import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { analyses, audits, events } from '../src/domain/state.js';
import { randomUUID } from 'node:crypto';

const app = await buildApp();
app.log.level = 'silent';

async function call(method: string, url: string, body?: any) {
  const res = await app.inject({ method, url, payload: body });
  return { status: res.statusCode, body: res.json() };
}

async function createAnalyzedEvent(opts: { recording?: boolean } = {}) {
  const created = await call('POST', '/api/fault-events', { lineId: 'L-AB', type: 'three-phase', currentKa: 12.5 });
  assert.equal(created.status, 200);
  let recordingId: string | undefined;
  if (opts.recording) {
    const rec = await call('POST', '/api/recordings', {
      name: '北郊录波',
      lineId: 'L-AB',
      triggerTimeMs: 0,
      sampleRateHz: 1000,
      samples: [
        { timeMs: 0, channel: 'Ia', value: 0.2, unit: 'kA', quality: 'good' },
        { timeMs: 1, channel: 'Ia', value: 12.4, unit: 'kA', quality: 'good' },
        { timeMs: 2, channel: 'Ia', value: 12.6, unit: 'kA', quality: 'suspect' },
      ],
    });
    assert.equal(rec.status, 200);
    recordingId = rec.body.id;
  }
  const replay = await call('POST', `/api/fault-events/${created.body.id}/replay`, { recordingId });
  assert.equal(replay.status, 200);
  return { eventId: created.body.id, analysisId: replay.body.id, analysis: replay.body };
}

function approvalAuditIds(analysisId: string) {
  return audits.filter(x => x.action === 'analysis.approve' && x.entity === analysisId);
}

test('录波重放不回归：事件→录波→重放产出 pending 分析，序列完整可审批', async () => {
  const { eventId, analysisId, analysis } = await createAnalyzedEvent({ recording: true });
  assert.equal(analysis.status, 'pending');
  assert.equal(analysis.approvedBy, undefined);
  assert.deepEqual(analysis.sequence.missing, []);
  assert.equal(analysis.sequence.selectivity, true);
  assert.equal(analysis.sequence.operatingTimeMs, 78 - 12);
  assert.equal(analysis.sourceSampleCount, 3);
  assert.equal(events.find(e => e.id === eventId)!.status, 'analyzed');

  const listed = await call('GET', '/api/analyses?status=pending');
  assert.ok(listed.body.some((x: any) => x.id === analysisId));
});

test('正常审批：pending -> approved，写入审批人与时间，并落一条审批审计', async () => {
  const { analysisId } = await createAnalyzedEvent();
  const res = await call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-zhang' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
  assert.equal(res.body.approvedBy, 'engineer-zhang');
  assert.ok(res.body.approvedAt);

  const entries = approvalAuditIds(analysisId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].payload.status, 'approved');
  assert.equal(entries[0].payload.approvedBy, 'engineer-zhang');
});

test('同语义重试：同审批人重复提交返回稳定结果，不改写原审批、不重复审计', async () => {
  const { analysisId } = await createAnalyzedEvent();
  const first = await call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-li' });
  assert.equal(first.status, 200);

  const retry = await call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-li' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.approvedBy, 'engineer-li');
  assert.equal(retry.body.approvedAt, first.body.approvedAt);
  assert.equal(retry.body.status, 'approved');

  // 甚至省略 body（默认 relay-engineer 不适用时）之外，同审批人重试仍幂等；此处确认只有一条审计。
  assert.equal(approvalAuditIds(analysisId).length, 1);
});

test('冲突请求：不同审批人的终态请求返回 409 且不覆盖原审批、不补审计', async () => {
  const { analysisId } = await createAnalyzedEvent();
  const first = await call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-li' });
  assert.equal(first.status, 200);

  const conflict = await call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-wang' });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /already approved/);
  assert.equal(conflict.body.approvedBy, 'engineer-li');
  assert.equal(conflict.body.approvedAt, first.body.approvedAt);

  const stored = analyses.find(a => a.id === analysisId)!;
  assert.equal(stored.approvedBy, 'engineer-li');
  assert.equal(stored.approvedAt, first.body.approvedAt);
  assert.equal(approvalAuditIds(analysisId).length, 1);
});

test('交错请求：两个不同审批人并发提交，只产生一次状态转换和一条审批审计', async () => {
  const { analysisId } = await createAnalyzedEvent();
  const [r1, r2] = await Promise.all([
    call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-a' }),
    call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-b' }),
  ]);

  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  const winner = r1.status === 200 ? r1.body : r2.body;
  const loser = r1.status === 409 ? r1.body : r2.body;
  assert.ok(['engineer-a', 'engineer-b'].includes(winner.approvedBy));
  assert.equal(loser.approvedBy, winner.approvedBy);

  const stored = analyses.find(a => a.id === analysisId)!;
  assert.equal(stored.status, 'approved');
  assert.equal(stored.approvedBy, winner.approvedBy);
  assert.equal(approvalAuditIds(analysisId).length, 1);
});

test('审批后追溯：trace 返回已审批分析及其审批信息', async () => {
  const { eventId, analysisId } = await createAnalyzedEvent();
  await call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-zhao' });

  const trace = await call('GET', `/api/fault-events/${eventId}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.event.id, eventId);
  const approved = trace.body.analyses.find((x: any) => x.id === analysisId);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, 'engineer-zhao');
  assert.ok(approved.approvedAt);
});

test('审计快照：审批后对象的后续变化不得改写已落库的审批 payload', async () => {
  const { analysisId } = await createAnalyzedEvent();
  await call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-snapshot' });
  const entry = approvalAuditIds(analysisId)[0];
  const frozenAt = entry.payload.approvedAt;

  // 白盒模拟后续任何对该分析对象的写入（例如迟到的重复请求、后续流程更新）。
  const stored = analyses.find(a => a.id === analysisId)!;
  stored.approvedBy = 'tampered';
  stored.approvedAt = '1999-01-01T00:00:00.000Z';
  stored.status = 'something-else';

  const refetched = approvalAuditIds(analysisId)[0];
  assert.equal(refetched.payload.approvedBy, 'engineer-snapshot');
  assert.equal(refetched.payload.approvedAt, frozenAt);
  assert.equal(refetched.payload.status, 'approved');
});

test('审计快照：重放与故障创建时的历史 payload 不被后续状态变化改写', async () => {
  const { eventId, analysisId } = await createAnalyzedEvent();
  const replayEntry = audits.find(x => x.action === 'fault.replay' && x.entity === analysisId)!;
  assert.equal(replayEntry.payload.status, 'pending');

  await call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-history' });
  assert.equal(replayEntry.payload.status, 'pending');
  assert.equal(replayEntry.payload.approvedBy, undefined);

  const eventEntry = audits.find(x => x.action === 'fault.create' && x.entity === eventId)!;
  assert.equal(eventEntry.payload.status, 'new');
  assert.equal(events.find(e => e.id === eventId)!.status, 'analyzed');
});

test('错误语义：分析不存在返回 404', async () => {
  const res = await call('POST', `/api/analyses/${randomUUID()}/approve`, { approvedBy: 'x' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'analysis not found');
});

test('错误语义：序列不完整仍返回 409 sequence incomplete', async () => {
  const { analysisId } = await createAnalyzedEvent();
  // 白盒构造一个缺失动作的不完整序列（外部故障或拒动场景的等价数据）。
  const stored = analyses.find(a => a.id === analysisId)!;
  stored.sequence = { ...stored.sequence, missing: ['breaker-open'] };

  const res = await call('POST', `/api/analyses/${analysisId}/approve`, { approvedBy: 'engineer-x' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'sequence incomplete');
  assert.deepEqual(res.body.missing, ['breaker-open']);
  // 序列不完整时不得发生审批转换，也不得写审计。
  assert.equal(stored.status, 'pending');
  assert.equal(approvalAuditIds(analysisId).length, 0);
});

test('错误语义：不存在的故障事件与线路保持既有 404/400', async () => {
  const replay404 = await call('POST', `/api/fault-events/${randomUUID()}/replay`, {});
  assert.equal(replay404.status, 404);
  assert.equal(replay404.body.error, 'fault event not found');

  const line404 = await call('POST', '/api/fault-events', { lineId: 'NOPE', type: 'three-phase' });
  assert.equal(line404.status, 404);

  const bad = await call('POST', '/api/fault-events', { type: 'three-phase' });
  assert.equal(bad.status, 400);
});
