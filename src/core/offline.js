// S8 线下玩法纯逻辑（线下文字彩头履约 + 打球线下对战记录）。
// 抽成纯函数便于单测；store.js 负责把结果落进 reactive 状态、记账本、喂动态流。
//
// 合规红线（§5.3/§5.12）：线下文字彩头平台**只记录不结算**——积分照常自动结算，
// 彩头仅文字标注 + 履约状态（fulfilled / isOverdue）。绝不涉及现金/兑现。

// 还愿逾期阈值：结算后超过这么多天仍未还愿，标记为逾期（为 S9 老赖榜铺路）。
export const OVERDUE_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

// 判断一个文字彩头是否逾期未还愿。
//   sideBet: { fulfilled, ... }；settledAt: 该局结算时间戳；now: 当前时间。
// 规则：有彩头 + 未还愿 + 已结算 + 距结算超 OVERDUE_DAYS 天 → 逾期。
export function isSideBetOverdue(sideBet, settledAt, now = Date.now()) {
  if (!sideBet || sideBet.fulfilled) return false
  if (!settledAt) return false
  return now - settledAt > OVERDUE_DAYS * DAY_MS
}

// 打球线下对战的积分结算计算（纯函数，不碰余额，只算差额）。
//   iWon: 我是否赢这盘；stake: 挂的积分赌注（>0 才结算，0/空=纯记录不挂积分）。
// 返回 { delta, settled }：
//   settled=false → 没挂积分，纯记录，delta=0，余额不动。
//   settled=true  → delta = 赢则 +stake，输则 -stake（对手是 NPC，零和；不抽水）。
export function offlineScoreDelta(iWon, stake) {
  const s = Math.round(Number(stake) || 0) // 取整,防浮点小数进账本造成余额漂移
  if (!(s > 0)) return { delta: 0, settled: false }
  return { delta: iWon ? s : -s, settled: true }
}
