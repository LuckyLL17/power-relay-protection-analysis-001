import { newId } from '../core/id.js';
import type { FastifyInstance } from 'fastify';
import { analyses, breakers, devices, events, lines, log, now, recordings, substations, withAnalysisLock } from '../domain/state.js';
import { DEFAULT_APPROVER, decideApproval } from '../domain/workflow.js';
import type { Analysis, FaultEvent } from '../domain/types.js';
import { analyzeSequence, classifyFault, locateFault } from '../services/fault-calculator.js';

export async function registerFaultRoutes(app: FastifyInstance) {
  // 录波录入（链路：录波创建）
  app.post('/api/recordings', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.name || !b.lineId || !Array.isArray(b.samples)) {
      return res.code(400).send({ error: 'name、lineId、samples 必填' });
    }
    const samples = b.samples;
    const times = samples.map((x: any) => Number(x.timeMs));
    const r = {
      id: newId(),
      name: b.name,
      lineId: b.lineId,
      triggerTimeMs: Number(b.triggerTimeMs ?? Math.min(...times, 0)),
      sampleRateHz: Number(b.sampleRateHz || 1000),
      samples,
      quality: {
        channels: new Set(samples.map((x: any) => x.channel)).size,
        monotonic: times.every((x: number, i: number) => i === 0 || x >= times[i - 1]),
        badCount: samples.filter((x: any) => x.quality === 'bad').length,
      },
      createdAt: now(),
      status: 'captured',
    };
    recordings.push(r);
    log('recording.ingest', r.id, r);
    return r;
  });

  // 故障创建（链路起点）
  app.post('/api/fault-events', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.lineId || !b.type) return res.code(400).send({ error: 'lineId 和 type 必填' });
    const line = lines.find(x => x.id === b.lineId);
    if (!line) return res.code(404).send({ error: 'line not found' });
    const fault = classifyFault(b);
    const event: FaultEvent = {
      id: newId(),
      lineId: b.lineId,
      occurredAt: b.occurredAt || now(),
      fault,
      location: locateFault(line, fault.apparentImpedanceOhm),
      source: b.source || 'relay-record',
      status: 'new',
    };
    events.push(event);
    log('fault.create', event.id, event);
    return event;
  });

  // 录波重放 + 保护动作序列分析（链路：录波重放 -> 分析状态）
  app.post('/api/fault-events/:id/replay', async (req: any, res: any) => {
    const event = events.find(x => x.id === (req.params as any).id);
    if (!event) return res.code(404).send({ error: 'fault event not found' });
    const b = req.body as any;
    const recording = b.recordingId ? recordings.find(x => x.id === b.recordingId) : null;
    const line = lines.find(x => x.id === event.lineId)!;
    const relay = devices.find(x => x.lineId === line.id);
    const sequence = [
      { timeMs: 0, type: 'fault-inception', value: event.fault.apparentImpedanceOhm },
      { timeMs: 12, type: 'pickup', deviceId: relay?.id },
      { timeMs: 18, type: 'zone-trip', deviceId: relay?.id },
      { timeMs: 42, type: 'trip-command', deviceId: relay?.id },
      { timeMs: 78, type: 'breaker-open', breakerId: breakers.find(x => x.substation === substations.find(s => s.id === line.from)?.id)?.id },
    ];
    const analysis: Analysis = {
      id: newId(),
      eventId: event.id,
      recordingId: recording?.id || null,
      createdAt: now(),
      // 分析创建后进入待审批状态，只有 pending -> approved 一条合法转换
      status: 'pending',
      fault: event.fault,
      location: event.location,
      events: sequence,
      sourceSampleCount: recording?.samples.length || 0,
      sequence: analyzeSequence({ events: sequence, fault: { type: b.faultLocation === 'external' ? 'external' : event.fault.type } }),
      settingsVersion: relay?.settingsVersion,
    };
    analyses.push(analysis);
    event.status = 'analyzed';
    // log 对 analysis 做快照；后续审批只改活对象，历史 payload 保持重放时形态
    log('fault.replay', analysis.id, analysis);
    return analysis;
  });

  // 审批接口（链路：审批）
  app.post('/api/analyses/:id/approve', async (req: any, res: any) => {
    const analysis = analyses.find(x => x.id === (req.params as any).id);
    if (!analysis) return res.code(404).send({ error: 'analysis not found' });

    const requestedBy = (req.body as any)?.approvedBy || DEFAULT_APPROVER;

    // 同一分析的请求串行进入临界区：交错的重试/并发审批中只有一个能完成转换
    const result = await withAnalysisLock(analysis.id, async () => decideApproval(analysis, requestedBy));

    if (result.outcome === 'sequence-incomplete') {
      // 保留既有错误语义：序列不完整拒绝审批
      return res.code(409).send({ error: 'sequence incomplete', missing: result.missing });
    }
    if (result.outcome === 'conflict') {
      // 终态已由其他审批人落定：明确冲突，不覆盖原审批人和时间，不补写审计
      return res.code(409).send({
        error: 'analysis already approved by another engineer',
        approvedBy: result.approvedBy,
        approvedAt: result.approvedAt,
        requestedBy: result.requestedBy,
      });
    }
    // approved：首次审批成功，状态 200；idempotent：同语义重试，返回同一份稳定结果
    // （相同状态码与响应体，且不产生新的状态转换或审批审计）
    return result.analysis;
  });

  app.get('/api/analyses', async (req: any) => analyses.filter(x => !(req.query as any)?.status || x.status === (req.query as any).status));

  // 审批后追溯（链路：审计查询侧的事件视图）
  app.get('/api/fault-events/:id/trace', async (req: any, res: any) => {
    const e = events.find(x => x.id === (req.params as any).id);
    if (!e) return res.code(404).send({ error: 'fault event not found' });
    return { event: e, analyses: analyses.filter(x => x.eventId === e.id) };
  });
}
