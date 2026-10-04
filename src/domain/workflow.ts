import { log, now } from './state.js';
import type { Analysis } from './types.js';

export const DEFAULT_APPROVER = 'relay-engineer';

export type ApprovalResult =
  | { outcome: 'approved'; analysis: Analysis }
  | { outcome: 'idempotent'; analysis: Analysis }
  | { outcome: 'sequence-incomplete'; missing: string[] }
  | { outcome: 'conflict'; approvedBy: string; approvedAt: string; requestedBy: string };

// 分析状态机：pending -> approved 是唯一合法的终态转换。
// - pending 且动作序列完整：执行一次转换并写一条审批审计；
// - 已 approved 且重试请求语义相同（同一审批人）：返回稳定结果，不改写原审批，不再写审计；
// - 已 approved 但请求来自不同审批人：终态不可覆盖，返回明确冲突。
export function decideApproval(analysis: Analysis, requestedBy: string): ApprovalResult {
  if (analysis.status === 'approved') {
    if (analysis.approvedBy === requestedBy) {
      return { outcome: 'idempotent', analysis };
    }
    return {
      outcome: 'conflict',
      approvedBy: analysis.approvedBy as string,
      approvedAt: analysis.approvedAt as string,
      requestedBy,
    };
  }

  const missing = analysis.sequence?.missing ?? [];
  if (missing.length) {
    return { outcome: 'sequence-incomplete', missing };
  }

  analysis.status = 'approved';
  analysis.approvedBy = requestedBy;
  analysis.approvedAt = now();
  // 审计必须在转换落定后写入，且 log 内部对快照深拷贝，
  // 记录的是本次终态审批瞬间的分析，不随后续任何变化改写。
  log('analysis.approve', analysis.id, analysis);
  return { outcome: 'approved', analysis };
}
