import { describe, it, expect, beforeEach } from 'vitest'
import {
  msUntilDeadline,
  formatCountdown,
  isStaleOpen,
  isSettleOverdue,
  validateAppeal,
  resolveAppeal,
  SETTLE_GRACE_MS,
  APPEAL_STAKE_LIMIT,
  consensusThreshold,
  tallyConsensus,
} from '../src/core/governance.js'
import {
  store,
  register,
  resetAll,
  createMatch,
  npcJoin,
  settleMatchStore,
  fileAppeal,
  resolveAppealStore,
} from '../src/store.js'
import { settleMatch } from '../src/core/wager.js'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000
const now = 1_000_000_000_000

describe('msUntilDeadline / formatCountdown（截止倒计时）', () => {
  it('无截止 → null / 空串', () => {
    expect(msUntilDeadline(null, now)).toBe(null)
    expect(formatCountdown(null, now)).toBe('')
    expect(formatCountdown(undefined, now)).toBe('')
  })
  it('已过截止 → 已截止', () => {
    expect(msUntilDeadline(now - 1000, now)).toBeLessThanOrEqual(0)
    expect(formatCountdown(now - 1000, now)).toBe('已截止')
    expect(formatCountdown(now, now)).toBe('已截止')
  })
  it('按天/小时/分钟分级格式化', () => {
    expect(formatCountdown(now + 3 * DAY + 5 * HOUR, now)).toBe('3天后截止')
    expect(formatCountdown(now + 5 * HOUR, now)).toBe('5小时后截止')
    expect(formatCountdown(now + 20 * MIN, now)).toBe('20分钟后截止')
    expect(formatCountdown(now + 30 * 1000, now)).toBe('即将截止')
  })
})

describe('isStaleOpen（无人接到截止 → 自动作废）', () => {
  it('open + 有截止 + 已过 → true', () => {
    expect(isStaleOpen({ status: 'open', deadline: now - 1 }, now)).toBe(true)
  })
  it('open + 未到截止 → false', () => {
    expect(isStaleOpen({ status: 'open', deadline: now + DAY }, now)).toBe(false)
  })
  it('open 但无截止 → false（无截止的盘不自动作废）', () => {
    expect(isStaleOpen({ status: 'open', deadline: null }, now)).toBe(false)
    expect(isStaleOpen({ status: 'open' }, now)).toBe(false)
  })
  it('已接盘(matched)/已揭晓(settled) → 永不算 stale-open', () => {
    expect(isStaleOpen({ status: 'matched', deadline: now - DAY }, now)).toBe(false)
    expect(isStaleOpen({ status: 'settled', deadline: now - DAY }, now)).toBe(false)
  })
})

describe('isSettleOverdue（接盘后超宽限期未揭晓 → 提示裁判）', () => {
  it('matched + 过截止+宽限期 → true', () => {
    expect(isSettleOverdue({ status: 'matched', deadline: now - SETTLE_GRACE_MS - 1 }, now)).toBe(true)
  })
  it('matched + 刚过截止但未过宽限期 → false', () => {
    expect(isSettleOverdue({ status: 'matched', deadline: now - 1000 }, now)).toBe(false)
  })
  it('matched 但无截止 → false', () => {
    expect(isSettleOverdue({ status: 'matched', deadline: null }, now)).toBe(false)
  })
  it('open/settled → false', () => {
    expect(isSettleOverdue({ status: 'open', deadline: now - 10 * DAY }, now)).toBe(false)
    expect(isSettleOverdue({ status: 'settled', deadline: now - 10 * DAY }, now)).toBe(false)
  })
})

describe('validateAppeal（申诉复议金校验）', () => {
  it('复议金必须 > 0', () => {
    expect(validateAppeal({ stake: 0, balance: 100000 }).ok).toBe(false)
    expect(validateAppeal({ stake: -5, balance: 100000 }).ok).toBe(false)
  })
  it('超上限拒绝', () => {
    expect(validateAppeal({ stake: APPEAL_STAKE_LIMIT + 1, balance: 1_000_000 }).ok).toBe(false)
  })
  it('余额不足拒绝', () => {
    expect(validateAppeal({ stake: 10000, balance: 5000 }).ok).toBe(false)
  })
  it('合法 → ok + 取整 stake', () => {
    expect(validateAppeal({ stake: 9999.6, balance: 100000 })).toEqual({ ok: true, stake: 10000 })
  })
})

describe('resolveAppeal（终审改判反向结算守恒）', () => {
  const base = { ownerStake: 10000, odds: 2, ownerSide: 'A', appealStake: 5000 }

  it('维持原判 → 复议金没收，资金不动', () => {
    const r = resolveAppeal({ ...base, verdict: 'uphold', origResult: 'A' })
    expect(r).toEqual({ settleDelta: 0, appealRefund: 0, newResult: 'A', iWonNow: true })
  })

  it('改判：原我赢(A) → 现我输(B)，扣回奖池，退复议金', () => {
    // 原结果 A == ownerSide A，我当初赢拿了 10000*2=20000；改判后扣回 20000
    const r = resolveAppeal({ ...base, verdict: 'overturn', origResult: 'A' })
    expect(r.newResult).toBe('B')
    expect(r.iWonNow).toBe(false)
    expect(r.settleDelta).toBe(-20000)
    expect(r.appealRefund).toBe(5000)
  })

  it('改判：原我输(B) → 现我赢(A)，补发奖池，退复议金', () => {
    // 原结果 B != ownerSide A，我当初输拿了 0；改判后补发 20000
    const r = resolveAppeal({ ...base, verdict: 'overturn', origResult: 'B' })
    expect(r.newResult).toBe('A')
    expect(r.iWonNow).toBe(true)
    expect(r.settleDelta).toBe(20000)
    expect(r.appealRefund).toBe(5000)
  })

  it('守恒：改判一来一回 settleDelta 大小相等符号相反', () => {
    const win2lose = resolveAppeal({ ...base, verdict: 'overturn', origResult: 'A' })
    const lose2win = resolveAppeal({ ...base, verdict: 'overturn', origResult: 'B' })
    expect(win2lose.settleDelta + lose2win.settleDelta).toBe(0)
  })
})

// ── store 级申诉改判守恒补测（LOOP-2 S10 遗留）──
// 验证 fileAppeal + resolveAppealStore 落进余额后整体守恒：
//   overturn 原赢现输 → 反向结算扣 pot；原输现赢 → 补发 pot；复议金原路退。
//   uphold → 资金不动、复议金没收（settleDelta=0）。
describe('store 申诉改判守恒（fileAppeal + resolveAppealStore）', () => {
  beforeEach(() => {
    resetAll()
    register({ name: '我', password: 'x', agreedTerms: true })
  })

  // 开一盘 ownerStake=10000、odds=2、押 A，NPC 接盘，按 result 揭晓结算。
  // 返回结算后该 match 对象。pot（押中可拿回）= 10000*2 = 20000。
  function openSettle(result) {
    const m = createMatch({
      title: '改判测试', optionA: '甲', optionB: '乙',
      ownerSide: 'A', odds: 2, ownerStake: 10000,
    })
    npcJoin(m.id)
    const mm = store.matches.find((x) => x.id === m.id)
    const r = settleMatch({ ownerStake: mm.ownerStake, takerStake: mm.takerStake, ownerSide: mm.ownerSide, result })
    settleMatchStore(mm.id, result, r)
    return store.matches.find((x) => x.id === m.id)
  }

  it('overturn 原赢现输：settleDelta=-pot，复议金原路退（净 -pot）', () => {
    const mm = openSettle('A') // 押 A、揭晓 A → 我赢，余额已 +20000(pot)
    const balAfterSettle = store.balance
    const stake = 5000
    expect(fileAppeal({ matchId: mm.id, reason: '不服', stake }).ok).toBe(true)
    expect(store.balance).toBe(balAfterSettle - stake) // 押复议金先扣
    expect(resolveAppealStore(store.appeals[0].id, 'overturn').ok).toBe(true)
    // 改判：扣回 pot(20000) + 退复议金(5000) = 净 -20000，结果改为 B
    expect(store.balance).toBe(balAfterSettle - 20000)
    expect(mm.result).toBe('B')
    expect(store.appeals[0].status).toBe('resolved')
    expect(store.appeals[0].verdict).toBe('overturn')
  })

  it('overturn 原输现赢：settleDelta=+pot，复议金原路退（净 +pot）', () => {
    const mm = openSettle('B') // 押 A、揭晓 B → 我输，余额 +0
    const balAfterSettle = store.balance
    const stake = 5000
    expect(fileAppeal({ matchId: mm.id, reason: '冤枉', stake }).ok).toBe(true)
    expect(store.balance).toBe(balAfterSettle - stake)
    expect(resolveAppealStore(store.appeals[0].id, 'overturn').ok).toBe(true)
    // 改判：补发 pot(20000) + 退复议金(5000) = 净 +20000，结果改为 A
    expect(store.balance).toBe(balAfterSettle + 20000)
    expect(mm.result).toBe('A')
  })

  it('uphold 维持原判：settleDelta=0，复议金没收（净 -stake，资金不再动）', () => {
    const mm = openSettle('A') // 我赢
    const balAfterSettle = store.balance
    const stake = 5000
    expect(fileAppeal({ matchId: mm.id, reason: '试试', stake }).ok).toBe(true)
    expect(store.balance).toBe(balAfterSettle - stake)
    expect(resolveAppealStore(store.appeals[0].id, 'uphold').ok).toBe(true)
    // 维持：复议金没收（已在发起时扣），resolve 不再动资金 → 余额仍是 -stake
    expect(store.balance).toBe(balAfterSettle - stake)
    expect(mm.result).toBe('A') // 结果不变
    expect(store.appeals[0].verdict).toBe('uphold')
  })
})

describe('§A 共识揭晓计票', () => {
  it('consensusThreshold: unanimous=全员, twothirds=ceil(N*2/3)', () => {
    expect(consensusThreshold(2, 'unanimous')).toBe(2)
    expect(consensusThreshold(3, 'unanimous')).toBe(3)
    expect(consensusThreshold(3, 'twothirds')).toBe(2) // ceil(2)=2
    expect(consensusThreshold(4, 'twothirds')).toBe(3) // ceil(2.67)=3
    expect(consensusThreshold(6, 'twothirds')).toBe(4)
  })

  it('约赌 unanimous：两人都同意才 passed', () => {
    const voters = ['me', 'rival']
    expect(tallyConsensus({ voters, votes: { me: 'agree', rival: 'agree' }, rule: 'unanimous' }).passed).toBe(true)
    // 只有提议人同意、对手待定 → 未过且未僵
    const t = tallyConsensus({ voters, votes: { me: 'agree' }, rule: 'unanimous' })
    expect(t.passed).toBe(false)
    expect(t.deadlocked).toBe(false)
    expect(t.pending).toBe(1)
  })

  it('约赌 unanimous：对手反对 → 立即僵局(deadlocked)', () => {
    const t = tallyConsensus({ voters: ['me', 'rival'], votes: { me: 'agree', rival: 'reject' }, rule: 'unanimous' })
    expect(t.passed).toBe(false)
    expect(t.deadlocked).toBe(true) // 剩下没人了，到不了全员同意
  })

  it('多人 twothirds：达 ceil(N*2/3) 同意即 passed', () => {
    const voters = ['me', 'a', 'b', 'c'] // N=4, 阈值=3
    const t = tallyConsensus({ voters, votes: { me: 'agree', a: 'agree', b: 'agree', c: 'reject' }, rule: 'twothirds' })
    expect(t.threshold).toBe(3)
    expect(t.passed).toBe(true)
  })

  it('多人 twothirds：反对过多到不了阈值 → deadlocked', () => {
    const voters = ['me', 'a', 'b', 'c'] // 阈值=3
    // 2 人反对：剩 2 人即便全同意也只有 2 < 3 → 僵局
    const t = tallyConsensus({ voters, votes: { me: 'agree', a: 'agree', b: 'reject', c: 'reject' }, rule: 'twothirds' })
    expect(t.passed).toBe(false)
    expect(t.deadlocked).toBe(true)
  })
})
