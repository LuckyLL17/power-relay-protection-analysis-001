import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { analyses, audits, events, recordings, withAnalysisLock } from '../src/domain/state.js';
import type { Analysis } from '../src/domain/types.js';

// 每个进程内状态锚点：开始前清空，保证用例相互隔离
for (const store of [analyses, audits, events, recordings]) store.length = 0;

const app = await buildApp();
const base: any = { headers: { 'content-type': 'application/json' } };

async function call(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload, ...base });
  return { status: res.statusCode, body: res.json() };
}

async function createReplayedAnalysis(approvePayload?: Record<string, unknown>) {
  const fault = await call('POST', '/api/fault-events', { lineId: 'L-AB', type: 'three-phase', currentKa: 12.5 });
  assert.equal(fault.status, 200);
  const replay = await call('POST', `/api/fault-events/${fault.body.id}/replay`, approvePayload ?? {});
  assert.equal(replay.status, 200);
  return { eventId: fault.body.id, analysis: replay.body as Analysis };
}

const approvalAudits = () => audits.filter(x => x.action === 'analysis.approve');

test('正常审批：pending -> approved 完成唯一一次状态转换并写一次审计', async () => {
  const { analysis } = await createReplayedAnalysis();
  assert.equal(analysis.status, 'pending');
  assert.equal(analysis.approvedBy, undefined);

  const res = await call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'engineer-A' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
  assert.equal(res.body.approvedBy, 'engineer-A');
  assert.ok(typeof res.body.approvedAt === 'string' && res.body.approvedAt.length > 0);
  assert.equal(approvalAudits().filter(x => x.entity === analysis.id).length, 1);
});

test('同语义重试：返回稳定结果，不改变原审批人和时间，不重复写审计', async () => {
  const { analysis } = await createReplayedAnalysis();
  const first = await call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'engineer-A' });
  const approvedAt = first.body.approvedAt;
  // 模拟客户端超时后的重试（同样的请求体再发一次，甚至多试一次）
  const retry1 = await call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'engineer-A' });
  const retry2 = await call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'engineer-A' });

  for (const r of [retry1, retry2]) {
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'approved');
    assert.equal(r.body.approvedBy, 'engineer-A');
    assert.equal(r.body.approvedAt, approvedAt);
  }
  assert.equal(approvalAudits().filter(x => x.entity === analysis.id).length, 1);
});

test('不同审批人的终态请求：返回明确冲突且不覆盖、不补审计', async () => {
  const { analysis } = await createReplayedAnalysis();
  const first = await call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'engineer-A' });
  const conflict = await call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'engineer-B' });

  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /already approved/);
  assert.equal(conflict.body.approvedBy, 'engineer-A');
  assert.equal(conflict.body.approvedAt, first.body.approvedAt);
  assert.equal(conflict.body.requestedBy, 'engineer-B');

  const stored = analyses.find(a => a.id === analysis.id)!;
  assert.equal(stored.approvedBy, 'engineer-A');
  assert.equal(stored.approvedAt, first.body.approvedAt);
  assert.equal(approvalAudits().filter(x => x.entity === analysis.id).length, 1);
});

test('交错请求：两个会话并发提交，只产生一次状态转换和一次审批审计', async () => {
  const { analysis } = await createReplayedAnalysis();
  // 3 个 A、3 个 B 几乎同时提交（含 A 自身的重试）
  const responses = await Promise.all([
    call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'A' }),
    call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'B' }),
    call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'A' }),
    call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'B' }),
    call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'A' }),
    call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'B' }),
  ]);

  const winners = responses.filter(r => r.status === 200);
  const losers = responses.filter(r => r.status === 409);
  assert.equal(winners.length, 3); // 胜出审批人的首次请求 + 两次同语义重试
  assert.equal(losers.length, 3);  // 另一审批人的全部请求均明确冲突
  const winner = winners[0].body.approvedBy;
  assert.ok(winner === 'A' || winner === 'B');
  for (const r of winners) {
    assert.equal(r.body.approvedBy, winner);
    assert.equal(r.body.approvedAt, winners[0].body.approvedAt);
  }
  for (const r of losers) assert.equal(r.body.requestedBy, winner === 'A' ? 'B' : 'A');

  assert.equal(approvalAudits().filter(x => x.entity === analysis.id).length, 1);
  assert.equal(analyses.find(a => a.id === analysis.id)!.approvedBy, winner);
});

test('审计快照：保存时写入，后续状态变化不得改写历史 payload', async () => {
  const { analysis } = await createReplayedAnalysis();
  const replayAudit = audits.find(x => x.action === 'fault.replay' && x.entity === analysis.id)!;
  // 重放审计快照定格在 pending、未审批形态
  assert.equal(replayAudit.payload.status, 'pending');
  assert.equal(replayAudit.payload.approvedBy, undefined);
  assert.notEqual(replayAudit.payload, analysis);

  await call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'engineer-A' });
  const approveAudit = approvalAudits().find(x => x.entity === analysis.id)!;
  assert.equal(approveAudit.payload.status, 'approved');
  assert.equal(approveAudit.payload.approvedBy, 'engineer-A');
  const snapshotApprovedAt = approveAudit.payload.approvedAt;

  // 模拟审批之后实体再发生任何变化（冲突尝试、人工修正等）
  const live = analyses.find(a => a.id === analysis.id)!;
  live.status = 'pending' as any;
  live.approvedBy = 'tampered';
  live.approvedAt = '2099-01-01T00:00:00.000Z';

  assert.equal(approveAudit.payload.status, 'approved');
  assert.equal(approveAudit.payload.approvedBy, 'engineer-A');
  assert.equal(approveAudit.payload.approvedAt, snapshotApprovedAt);
  assert.equal(replayAudit.payload.status, 'pending');
  assert.equal(replayAudit.payload.approvedBy, undefined);

  // 恢复现场，避免污染其他用例对终态的判断（不影响审计断言）
  live.status = 'approved';
  live.approvedBy = 'engineer-A';
  live.approvedAt = snapshotApprovedAt;
});

test('审批后追溯：trace 视图包含已审批分析', async () => {
  const { eventId, analysis } = await createReplayedAnalysis();
  await call('POST', `/api/analyses/${analysis.id}/approve`, { approvedBy: 'engineer-A' });
  const trace = await call('GET', `/api/fault-events/${eventId}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.event.status, 'analyzed');
  assert.equal(trace.body.analyses.length, 1);
  assert.equal(trace.body.analyses[0].id, analysis.id);
  assert.equal(trace.body.analyses[0].status, 'approved');
  assert.equal(trace.body.analyses[0].approvedBy, 'engineer-A');
});

test('既有错误语义：分析不存在 404、序列不完整 409 且拒绝时不写审计', async () => {
  const missing = await call('POST', '/api/analyses/no-such-analysis/approve', { approvedBy: 'x' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'analysis not found');

  const before = approvalAudits().length;
  const incomplete: Analysis = {
    id: 'analysis-incomplete-sequence',
    eventId: 'evt-x',
    recordingId: null,
    createdAt: new Date().toISOString(),
    status: 'pending',
    fault: {},
    location: {},
    events: [],
    sourceSampleCount: 0,
    sequence: { missing: ['zone-trip'], selectivity: false },
  };
  analyses.push(incomplete);
  const res = await call('POST', `/api/analyses/${incomplete.id}/approve`, { approvedBy: 'engineer-A' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'sequence incomplete');
  assert.deepEqual(res.body.missing, ['zone-trip']);
  assert.equal(analyses.find(a => a.id === incomplete.id)!.status, 'pending');
  assert.equal(approvalAudits().length, before);

  const badEvent = await call('POST', '/api/fault-events/no-such/replay', {});
  assert.equal(badEvent.status, 404);
  const badLine = await call('POST', '/api/fault-events', { lineId: 'L-XX', type: 'three-phase' });
  assert.equal(badLine.status, 404);
  const badBody = await call('POST', '/api/fault-events', { lineId: 'L-AB' });
  assert.equal(badBody.status, 400);
});

test('锁原语：临界区内 await 让出事件循环时，交错任务仍然严格串行', async () => {
  const order: string[] = [];
  const run = (label: string, delayMs: number) =>
    withAnalysisLock('analysis-lock-unit', async () => {
      order.push(`enter-${label}`);
      await new Promise(r => setTimeout(r, delayMs)); // 临界区内让出事件循环
      order.push(`leave-${label}`);
      return label;
    });

  const [r1, r2, r3] = await Promise.all([run('1', 20), run('2', 1), run('3', 1)]);
  assert.deepEqual(order, ['enter-1', 'leave-1', 'enter-2', 'leave-2', 'enter-3', 'leave-3']);
  assert.deepEqual([r1, r2, r3], ['1', '2', '3']);
});

test('录波重放不回归：质量检查、序列选择性、耗时与 pending 状态', async () => {
  const rec = await call('POST', '/api/recordings', {
    name: 'L-AB 故障录波',
    lineId: 'L-AB',
    sampleRateHz: 1000,
    samples: [
      { timeMs: 0, channel: 'Ia', value: 0.1, unit: 'kA', quality: 'good' },
      { timeMs: 5, channel: 'Ia', value: 12.4, unit: 'kA', quality: 'good' },
      { timeMs: 10, channel: 'Ib', value: 12.1, unit: 'kA', quality: 'bad' },
    ],
  });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.status, 'captured');
  assert.equal(rec.body.quality.channels, 2);
  assert.equal(rec.body.quality.monotonic, true);
  assert.equal(rec.body.quality.badCount, 1);

  const fault = await call('POST', '/api/fault-events', { lineId: 'L-AB', type: 'single-line-ground', currentKa: 12.5 });
  const replay = await call('POST', `/api/fault-events/${fault.body.id}/replay`, { recordingId: rec.body.id });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, 'pending');
  assert.equal(replay.body.recordingId, rec.body.id);
  assert.equal(replay.body.sourceSampleCount, 3);
  assert.deepEqual(replay.body.sequence.missing, []);
  assert.equal(replay.body.sequence.selectivity, true);
  assert.equal(replay.body.sequence.operatingTimeMs, 78 - 12);
  assert.equal(replay.body.sequence.backupRequired, false);
  assert.equal(replay.body.settingsVersion, 'set-2026.09');

  // 外部故障重放：期望序列不含 zone-trip，同样完整
  const fault2 = await call('POST', '/api/fault-events', { lineId: 'L-AB', type: 'three-phase' });
  const external = await call('POST', `/api/fault-events/${fault2.body.id}/replay`, { faultLocation: 'external' });
  assert.deepEqual(external.body.sequence.expected, ['pickup', 'trip-command', 'breaker-open']);
  assert.equal(external.body.sequence.selectivity, true);
  assert.equal(external.body.status, 'pending');

  // 列表状态过滤
  const pendingList = await call('GET', '/api/analyses?status=pending');
  assert.ok(pendingList.body.every((a: Analysis) => a.status === 'pending'));
  const approvedList = await call('GET', '/api/analyses?status=approved');
  assert.ok(approvedList.body.every((a: Analysis) => a.status === 'approved'));

  // 审计查询链路可读到录波、故障、重放、审批各类快照
  const audit = await call('GET', '/api/audit');
  assert.equal(audit.status, 200);
  const actions = new Set(audit.body.map((x: any) => x.action));
  for (const a of ['recording.ingest', 'fault.create', 'fault.replay', 'analysis.approve']) {
    assert.ok(actions.has(a), `audit should contain ${a}`);
  }
});
