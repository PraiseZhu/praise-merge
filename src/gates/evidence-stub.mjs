// 审查证据门禁的占位实现：在正式实现（PraiseZhu/praise-merge#3）合入前，永远不放行。
export default {
  id: 'evidence',
  lanes: ['personal'],
  check: () => ({ ok: false, reason: 'evidence_not_implemented' }),
}
