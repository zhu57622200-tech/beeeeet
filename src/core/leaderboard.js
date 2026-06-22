// 排行榜纯函数 —— 无副作用，输入 players[]，输出三类榜的排序后名次列表。
// 实名口径（§5.12）：身家榜 / 神预测榜（胜率，含防刷门槛）/ 连胜榜。
//
// 设计取舍：
// - 只读 players[]，不依赖 store / Vue，方便单测与复用。
// - 神预测榜按"胜率降序"，但设结算单数门槛（默认 5）防"押一单 100% 屠榜"；
//   未达门槛的玩家直接不进神预测榜（不是排末尾，是不上榜）。
// - "我"通过 p.isMe 标记，每榜返回项带 isMe，供 UI 高亮我那一行。
// - 每项结构：{ rank, id, name, emoji, title, isMe, value, sub }
//     value: 该榜主指标的展示字符串（已格式化）
//     sub:   次要信息（段位/战绩等，UI 副标题）
import { getRank } from './rank.js'

// 神预测榜默认结算单数门槛：低于此不进榜（防屠榜）。
export const PREDICT_MIN_SETTLED = 5

function fmtInt(n) {
  return Math.round(n || 0).toLocaleString('en-US')
}
function pct(r) {
  return (r * 100).toFixed(0) + '%'
}

// 给一组已排好序的玩家打名次并映射成榜单项。
function withRank(sorted, valueFn, subFn) {
  return sorted.map((p, i) => ({
    rank: i + 1,
    id: p.id,
    name: p.name || '神秘玩家',
    emoji: p.emoji || '🙂',
    title: p.title || '',
    isMe: !!p.isMe,
    value: valueFn(p),
    sub: subFn(p),
  }))
}

// 身家榜：按 balance 降序（balance = 可用积分，不含冻结，与顶栏口径一致）。
export function wealthBoard(players = []) {
  const sorted = [...players].sort((a, b) => (b.balance || 0) - (a.balance || 0))
  return withRank(
    sorted,
    (p) => fmtInt(p.balance) + ' 积分',
    (p) => getRank({ wins: p.wins || 0, losses: p.losses || 0 }).name
  )
}

// 神预测榜：按胜率降序，门槛 = 结算单数 ≥ minSettled 才进榜（防屠榜）。
// 胜率相同则按结算单数多的在前（样本更可信）。
export function predictBoard(players = [], minSettled = PREDICT_MIN_SETTLED) {
  const safe = Math.max(minSettled, 1) // 防 minSettled=0 时 0胜0负进榜算出 NaN%
  const eligible = players.filter((p) => (p.wins || 0) + (p.losses || 0) >= safe)
  const sorted = eligible.sort((a, b) => {
    const ra = (a.wins || 0) / ((a.wins || 0) + (a.losses || 0))
    const rb = (b.wins || 0) / ((b.wins || 0) + (b.losses || 0))
    if (rb !== ra) return rb - ra
    return ((b.wins || 0) + (b.losses || 0)) - ((a.wins || 0) + (a.losses || 0))
  })
  return withRank(
    sorted,
    (p) => pct((p.wins || 0) / ((p.wins || 0) + (p.losses || 0))),
    (p) => `${p.wins || 0} 胜 ${p.losses || 0} 负`
  )
}

// 连胜榜：按历史最大连胜 maxStreak 降序。
export function streakBoard(players = []) {
  const sorted = [...players].sort(
    (a, b) => (b.maxStreak || 0) - (a.maxStreak || 0) || (b.streak || 0) - (a.streak || 0)
  )
  return withRank(
    sorted,
    (p) => '🔥 ' + (p.maxStreak || 0) + ' 连胜',
    (p) => `${p.wins || 0} 胜 ${p.losses || 0} 负`
  )
}
