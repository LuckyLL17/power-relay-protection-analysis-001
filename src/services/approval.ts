// 分析审批状态机。
//
// 合法状态转换只有一条：pending -> approved。
// 审批通过后分析进入终态：
//   - 同一审批人重放（客户端超时重试属于同语义请求）：返回稳定结果，原审批人与审批时间保持不变，也不重复写审计；
//   - 不同审批人再次请求终态：明确冲突，不覆盖原审批；
//   - 其它状态：拒绝非法转换。
export const ANALYSIS_PENDING = 'pending';
export const ANALYSIS_APPROVED = 'approved';

export type ApproveOutcome =
  | { outcome: 'approved' }
  | { outcome: 'replayed' }
  | { outcome: 'conflict'; currentApprovedBy: string; approvedAt: string }
  | { outcome: 'illegal-transition'; currentStatus: string };

export function normalizeApprover(body: any): string {
  const value = body?.approvedBy;
  return typeof value === 'string' && value.trim() !== '' ? value : 'relay-engineer';
}

// 同步完成“读状态 -> 判定 -> 提交”。审批路由在调用本函数前后没有 await，
// Node 单线程事件循环保证两个交错请求不可能插入到这次读-改之间，
// 因此同一份分析最多只发生一次状态转换，审批审计也最多只写一条。
export function approveAnalysis(analysis: any, approvedBy: string, stamp: string): ApproveOutcome {
  const currentStatus = analysis.status ?? ANALYSIS_PENDING;

  if (currentStatus === ANALYSIS_APPROVED) {
    if (analysis.approvedBy === approvedBy) {
      return { outcome: 'replayed' };
    }
    return {
      outcome: 'conflict',
      currentApprovedBy: analysis.approvedBy,
      approvedAt: analysis.approvedAt,
    };
  }

  if (currentStatus !== ANALYSIS_PENDING) {
    return { outcome: 'illegal-transition', currentStatus };
  }

  analysis.status = ANALYSIS_APPROVED;
  analysis.approvedBy = approvedBy;
  analysis.approvedAt = stamp;
  return { outcome: 'approved' };
}
