import { newId } from '../core/id.js';
import type { Analysis, AuditEntry, Breaker, FaultEvent, ProtectionDevice, Recording } from './types.js';

export const substations = [{ id: 'SS-A', name: '北郊变电站', voltageKv: 220 }, { id: 'SS-B', name: '东城变电站', voltageKv: 220 }, { id: 'SS-C', name: '工业园变电站', voltageKv: 110 }];
export const lines = [{ id: 'L-AB', from: 'SS-A', to: 'SS-B', lengthKm: 42.6, positiveSequenceOhmPerKm: .19, zeroSequenceOhmPerKm: .58, status: 'energized' }, { id: 'L-BC', from: 'SS-B', to: 'SS-C', lengthKm: 18.4, positiveSequenceOhmPerKm: .24, zeroSequenceOhmPerKm: .71, status: 'energized' }];
export const breakers: Breaker[] = [{ id: 'BR-A1', name: '北郊侧断路器', substation: 'SS-A', state: 'closed' }, { id: 'BR-B1', name: '东城侧断路器', substation: 'SS-B', state: 'closed' }, { id: 'BR-C1', name: '工业园侧断路器', substation: 'SS-C', state: 'closed' }];
export const devices: ProtectionDevice[] = [{ id: 'R-A1', name: 'L-AB 北郊侧保护', type: 'distance', lineId: 'L-AB', settingsVersion: 'set-2026.09', enabled: true, zones: [{ zone: 1, reachOhm: 8.1, delayMs: 0 }, { zone: 2, reachOhm: 18.4, delayMs: 350 }, { zone: 3, reachOhm: 31, delayMs: 900 }] }, { id: 'R-B1', name: 'L-AB 东城侧保护', type: 'distance', lineId: 'L-AB', settingsVersion: 'set-2026.09', enabled: true, zones: [{ zone: 1, reachOhm: 8.1, delayMs: 0 }, { zone: 2, reachOhm: 18.4, delayMs: 350 }, { zone: 3, reachOhm: 31, delayMs: 900 }] }, { id: 'R-BC', name: 'L-BC 差动保护', type: 'differential', lineId: 'L-BC', settingsVersion: 'set-2026.08', enabled: true, zones: [{ zone: 1, reachOhm: 9.2, delayMs: 0 }] }];
export const settingSnapshots: any[] = [{ id: 'set-2026.09', effectiveAt: '2026-09-01T00:00:00.000Z', author: 'protection-engineering', reason: '季节运行方式调整', checksum: 'sha256:relay-202609' }];

export const recordings: Recording[] = [];
export const events: FaultEvent[] = [];
export const analyses: Analysis[] = [];
export const topologyChanges: any[] = [];
export const maintenanceTests: any[] = [];
export const audits: AuditEntry[] = [];

export const now = () => new Date().toISOString();

// 审计是只追加的历史记录：写入时对 payload 做深拷贝快照，
// 之后业务实体（分析、故障事件等）的状态变化不得改写历史 payload。
export function log(action: string, entity: string, payload: unknown) {
  audits.push({ id: newId(), time: now(), action, entity, payload: structuredClone(payload) });
}

// 同一分析的审批请求按 ID 串行执行，使「检查状态 → 转换状态 → 写审计」
// 成为临界区，保证客户端超时重试和并发会话交错时至多发生一次状态转换、
// 至多产生一条审批审计。不同分析之间互不阻塞。
const approvalQueues = new Map<string, Promise<unknown>>();

export function withAnalysisLock<T>(analysisId: string, task: () => Promise<T>): Promise<T> {
  const previous = approvalQueues.get(analysisId) ?? Promise.resolve();
  const current = previous.then(task, task);
  approvalQueues.set(analysisId, current);
  void current.finally(() => {
    if (approvalQueues.get(analysisId) === current) approvalQueues.delete(analysisId);
  });
  return current;
}
