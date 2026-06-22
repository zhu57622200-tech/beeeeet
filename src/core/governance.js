// S10 治理纯逻辑（赌约截止异常状态机 + 申诉复议改判）。
// 抽成纯函数便于单测；store.js 负责把结果落进 reactive 状态、记账本、喂动态流。
//
// 合规红线（§5.13/§5.8）：
// - 异常状态机的退款守恒：到截止无人接 → 自动作废，冻结积分**原路全额退回**，绝不锁死/凭空蒸发。
// - 申诉复议押的复议金也是虚拟娱乐积分，走审计账本；改判则**反向结算**，守恒。

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MIN_MS = 60 * 1000

// 揭晓宽限期：过截止 + 这么久仍未揭晓（matched），提示该叫裁判了（§5.13）。
export const SETTLE_GRACE_MS = 24 * HOUR_MS

// 还剩多少毫秒到截止（已过期返回 ≤0；无截止返回 null）。
export function msUntilDeadline(deadline, now = Date.now()) {
  if (!deadline) return null
  return deadline - now
}

// 倒计时格式化（给卡片/详情显示）。
//   ms <= 0 → '已截止'；否则 'N天/N小时/N分钟后截止'。无截止返回 ''。
export function formatCountdown(deadline, now = Date.now()) {
  const left = msUntilDeadline(deadline, now)
  if (left === null) return ''
  if (left <= 0) return '已截止'
  if (left >= DAY_MS) return `${Math.floor(left / DAY_MS)}天后截止`
  if (left >= HOUR_MS) return `${Math.floor(left / HOUR_MS)}小时后截止`
  if (left >= MIN_MS) return `${Math.floor(left / MIN_MS)}分钟后截止`
  return '即将截止'
}

// 一个 open（无人接）的赌约是否已过截止 → 应自动作废退回（§5.13）。
//   有截止 + 仍 open + now 已过截止 → true。
export function isStaleOpen(match, now = Date.now()) {
  if (!match || match.status !== 'open' || !match.deadline) return false
  return now >= match.deadline
}

// 一个 matched（有人接但没揭晓）的赌约是否超宽限期未揭晓 → 提示叫裁判（§5.13）。
//   有截止 + 仍 matched + now 已过 截止+宽限期 → true。
export function isSettleOverdue(match, now = Date.now()) {
  if (!match || match.status !== 'matched' || !match.deadline) return false
  return now >= match.deadline + SETTLE_GRACE_MS
}

// ---------- §A 共识揭晓（提议→投票→达阈值落账；僵局→第三方仲裁）----------
// 纯计票逻辑，不碰积分。store.js 负责驱动假人投票、达成后才调结算（守恒）。
//   rule='unanimous'：约赌 1v1，全体同意（双方都点头）。
//   rule='twothirds'：坐庄/彩池多人，ceil(N×2/3) 同意。

export function consensusThreshold(n, rule = 'unanimous') {
  if (rule === 'twothirds') return Math.ceil(n * 2 / 3)
  return n
}

// 计票。voters=参与者 id 列表；votes={id:'agree'|'reject'}。
// 返回 { agree, reject, pending, threshold, passed, deadlocked }：
//   passed     = 同意数 ≥ 阈值（可落账结算）。
//   deadlocked = 即便剩下待定的全投同意也到不了阈值（僵局 → 该叫第三方仲裁）。
export function tallyConsensus({ votes = {}, voters = [], rule = 'unanimous' } = {}) {
  const voterIds = Array.isArray(voters) ? voters : []
  const threshold = consensusThreshold(voterIds.length, rule)
  let agree = 0
  let reject = 0
  voterIds.forEach((id) => {
    if (votes[id] === 'agree') agree += 1
    else if (votes[id] === 'reject') reject += 1
  })
  const pending = voterIds.length - agree - reject
  return {
    agree,
    reject,
    pending,
    threshold,
    passed: agree >= threshold,
    deadlocked: voterIds.length - reject < threshold,
  }
}

// ---------- 申诉复议（§5.8，简化）----------

// 复议金上限：申诉押的积分（被驳回则没收，反向激励别瞎告）。
export const APPEAL_STAKE_LIMIT = 50_000

// 校验一笔申诉是否合法（纯函数，不碰余额）。
//   stake: 押的复议金；balance: 我的可用余额。
// 返回 { ok, error?, stake? }。stake 已取整。
export function validateAppeal({ stake, balance }) {
  const s = Math.round(Number(stake) || 0)
  if (!(s > 0)) return { ok: false, error: '复议金必须大于 0' }
  if (s > APPEAL_STAKE_LIMIT) {
    return { ok: false, error: `复议金最多 ${APPEAL_STAKE_LIMIT.toLocaleString('en-US')} 积分` }
  }
  if (s > balance) return { ok: false, error: '可用积分不足以押复议金' }
  return { ok: true, stake: s }
}

// 终审裁定对一笔已结算约赌的资金影响（纯函数，只算差额，不碰余额）。
//   verdict: 'uphold'(维持原判) | 'overturn'(改判，结果反转)。
//   ownerStake / odds / ownerSide: 原局参数；origResult: 原揭晓结果。
//   appealStake: 申诉押的复议金。
// 返回 { settleDelta, appealRefund, newResult, iWonNow }：
//   - uphold：原判维持。申诉驳回 → 没收复议金（appealRefund=0）；settleDelta=0。
//   - overturn：结果反转 newResult。复议金原路退回（appealRefund=appealStake）。
//     settleDelta = 反向结算后我余额应净变动：
//       原我赢(拿了 ownerStake*odds 回余额) → 现在我输 → 应退还 ownerStake*odds（扣回）= -ownerStake*odds
//       原我输(余额拿了 0)               → 现在我赢 → 应补发奖池 = ownerStake*odds
//     注：原局结算时不论输赢都已解冻 ownerStake，故这里只补/扣"赢的那份奖池"。
export function resolveAppeal({ verdict, ownerStake, odds, ownerSide, origResult, appealStake }) {
  const pot = Math.round(ownerStake * odds) // 押中可拿回的总额（本金 + 净赚），与 wager 结算口径一致
  if (verdict === 'uphold') {
    return { settleDelta: 0, appealRefund: 0, newResult: origResult, iWonNow: origResult === ownerSide }
  }
  // overturn：结果反转
  const newResult = origResult === 'A' ? 'B' : 'A'
  const iWonBefore = origResult === ownerSide
  const iWonNow = newResult === ownerSide
  // 原赢现输 → 扣回当初拿到的奖池；原输现赢 → 补发奖池。
  let settleDelta = 0
  if (iWonBefore && !iWonNow) settleDelta = -pot
  else if (!iWonBefore && iWonNow) settleDelta = pot
  return { settleDelta, appealRefund: Math.round(appealStake) || 0, newResult, iWonNow }
}
