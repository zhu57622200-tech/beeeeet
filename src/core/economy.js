// S9 经济治理纯逻辑（周补给 / 赛季清零 / 积分转赠 / 信誉耍赖 / 老赖榜）。
// 抽成纯函数便于单测；store.js 负责把结果落进 reactive 状态、记账本、喂动态流。
//
// 合规红线（§5.11，死守）：
// - 积分永不可兑现。周补/转赠都是虚拟娱乐积分，不对应任何现实金钱/对价。
// - 转赠仅限熟人人情/还赌债，平台绝不背书现实对价，不做"积分买卖市场"，不抽水。
// - 转赠设单笔限额 + 走审计账本（ledger），守恒：转出方扣多少，对手收多少，平台 0 抽成。

const DAY_MS = 24 * 60 * 60 * 1000

// ---------- 周补给（§5.11：每周补 2 万）----------
export const SUPPLY_INTERVAL_DAYS = 7
export const SUPPLY_AMOUNT = 20_000

// 距上次补给是否已满 7 天（可领）。lastSupplyAt 为空(从未领过)视为可领。
export function canClaimSupply(lastSupplyAt, now = Date.now()) {
  if (!lastSupplyAt) return true
  return now - lastSupplyAt >= SUPPLY_INTERVAL_DAYS * DAY_MS
}

// 距下次可领还差多少毫秒（已可领返回 0）。给 UI 倒计时提示用。
export function msUntilNextSupply(lastSupplyAt, now = Date.now()) {
  if (!lastSupplyAt) return 0
  const left = SUPPLY_INTERVAL_DAYS * DAY_MS - (now - lastSupplyAt)
  return left > 0 ? left : 0
}

// ---------- 积分转赠（§5.11，合规敏感）----------
// 单笔限额：防变相买卖/集中输送（≤5 万）。
export const TRANSFER_LIMIT = 50_000

// 校验一笔转赠是否合法（纯函数，不碰余额）。
//   amount: 转出额；balance: 我的可用余额；toName: 收款熟人名(非空)。
// 返回 { ok, error?, amount? }。amount 已取整（防浮点小数进账本）。
export function validateTransfer({ amount, balance, toName }) {
  const a = Math.round(Number(amount) || 0)
  if (!toName || !String(toName).trim()) return { ok: false, error: '请选择转给谁' }
  if (!(a > 0)) return { ok: false, error: '转赠额必须大于 0' }
  if (a > TRANSFER_LIMIT) return { ok: false, error: `单笔最多转 ${TRANSFER_LIMIT.toLocaleString('en-US')} 积分` }
  if (a > balance) return { ok: false, error: '可用积分不足' }
  return { ok: true, amount: a }
}

// ---------- 信誉 / 耍赖判定（§5.9）----------
// 各类耍赖行为的信誉扣减幅度（原型简化：客观触发即扣，真实需审核背书）。
export const REP_PENALTY = {
  delay: 5,       // 裁判拖延
  misjudge: 10,   // 乱判
  litigation: 8,  // 无理缠讼
  deadbeat: 15,   // 线下彩头赖账（最重）
}
// 信誉下限（不为负，留作"已破产信誉"的可视底）。
export const REP_FLOOR = 0
// 低信誉阈值：低于此视为"信誉不良"，进老赖榜信誉区。
export const REP_LOW_THRESHOLD = 70

// 扣信誉后的新值（夹在 [REP_FLOOR, 100]）。
export function applyRepPenalty(reputation, kind) {
  const cur = typeof reputation === 'number' ? reputation : 100
  const penalty = REP_PENALTY[kind] || 0
  return Math.max(REP_FLOOR, Math.min(100, cur - penalty))
}

// ---------- 老赖榜（§5.12）----------
// 扫描所有"线下彩头逾期未还愿"的欠条 + 低信誉玩家，合成公开处刑榜。
//   players: store.players；matches: 个人对赌局(含 sideBet/settledAt)；
//   offlineMatches: 线下打球记录(含 sideBet/at)；overdueFn: 复用 isSideBetOverdue。
//   meName: 当前玩家名(逾期彩头归到欠债方——这里原型简化为归"我"，因彩头都是我参与的)。
// 返回两段：
//   debts:  逾期欠条列表 [{ id, debtorName, debtorEmoji, text, title, overdueDays, kind }]
//   lowRep: 低信誉玩家列表 [{ name, emoji, reputation }]（按信誉升序，越低越靠前）
export function deadbeatBoard({ players = [], matches = [], offlineMatches = [], overdueFn = () => false, meName = '我', now = Date.now() }) {
  const debts = []
  const myEmoji = players.find((p) => p.isMe)?.emoji || '🫵'

  // 个人对赌的逾期彩头：欠债方=输家。我赢→对手(taker)欠；我输→我欠。
  for (const m of matches) {
    if (!m.sideBet || !overdueFn(m.sideBet, m.settledAt, now)) continue
    // 兜底：坐庄/彩池是多方结算，没有单一 takerName。约赌(match)才有明确的1v1输家，
    // 其余玩法欠债方不可靠判定 → 用"庄家方/参与方"占位，绝不误判到具体熟人头上。
    const isMatch = (m.mode || 'match') === 'match'
    let debtorName, debtorEmoji
    if (isMatch) {
      const iWon = m.result && m.result === m.ownerSide
      debtorName = iWon ? (m.takerName || '对手') : meName
      debtorEmoji = iWon ? (m.takerEmoji || '🙂') : myEmoji
    } else {
      // 坐庄无单一 taker；彩池多方瓜分 → 安全占位，不点名具体熟人（防误判崩/冤枉）。
      debtorName = m.mode === 'banker' ? '庄家方' : '参与方'
      debtorEmoji = '🙂'
    }
    debts.push({
      id: m.id,
      debtorName,
      debtorEmoji,
      text: m.sideBet.text,
      title: m.title,
      overdueDays: Math.floor((now - m.settledAt) / DAY_MS),
      kind: 'predict',
    })
  }

  // 线下打球的逾期彩头：原型里线下输赢都记在 rivalName 上，欠债方=输家。
  for (const o of offlineMatches) {
    if (!o.sideBet || !overdueFn(o.sideBet, o.at, now)) continue
    const debtorName = o.iWon ? o.rivalName : meName
    const debtorEmoji = o.iWon ? (o.rivalEmoji || '🙂') : myEmoji
    debts.push({
      id: o.id,
      debtorName,
      debtorEmoji,
      text: o.sideBet.text,
      title: `${o.sport}${o.score ? ' ' + o.score : ''}`.trim(),
      overdueDays: Math.floor((now - o.at) / DAY_MS),
      kind: 'offline',
    })
  }

  // 逾期越久越靠前（公开处刑优先示众）。
  debts.sort((a, b) => b.overdueDays - a.overdueDays)

  // 低信誉玩家（含我），信誉升序。
  const lowRep = players
    .filter((p) => (typeof p.reputation === 'number' ? p.reputation : 100) < REP_LOW_THRESHOLD)
    .map((p) => ({ name: p.name || '神秘玩家', emoji: p.emoji || '🙂', reputation: p.reputation ?? 100, isMe: !!p.isMe }))
    .sort((a, b) => a.reputation - b.reputation)

  return { debts, lowRep }
}
