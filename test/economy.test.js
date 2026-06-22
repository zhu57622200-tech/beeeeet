import { describe, it, expect } from 'vitest'
import {
  canClaimSupply,
  msUntilNextSupply,
  SUPPLY_INTERVAL_DAYS,
  SUPPLY_AMOUNT,
  validateTransfer,
  TRANSFER_LIMIT,
  applyRepPenalty,
  REP_PENALTY,
  deadbeatBoard,
} from '../src/core/economy.js'
import { isSideBetOverdue, OVERDUE_DAYS } from '../src/core/offline.js'

const DAY = 24 * 60 * 60 * 1000
const now = 1_700_000_000_000

describe('周补给 canClaimSupply / msUntilNextSupply', () => {
  it('从未领过（null）→ 可领', () => {
    expect(canClaimSupply(null, now)).toBe(true)
    expect(msUntilNextSupply(null, now)).toBe(0)
  })
  it('距上次满 7 天 → 可领', () => {
    const last = now - SUPPLY_INTERVAL_DAYS * DAY
    expect(canClaimSupply(last, now)).toBe(true)
    expect(msUntilNextSupply(last, now)).toBe(0)
  })
  it('距上次不足 7 天 → 不可领，倒计时>0', () => {
    const last = now - (SUPPLY_INTERVAL_DAYS * DAY - DAY) // 还差 1 天
    expect(canClaimSupply(last, now)).toBe(false)
    expect(msUntilNextSupply(last, now)).toBe(DAY)
  })
  it('补给额是 2 万', () => {
    expect(SUPPLY_AMOUNT).toBe(20_000)
  })
})

describe('积分转赠 validateTransfer（合规：限额+守恒前置校验）', () => {
  it('未选收款人 → 拒绝', () => {
    expect(validateTransfer({ amount: 1000, balance: 100000, toName: '' }).ok).toBe(false)
    expect(validateTransfer({ amount: 1000, balance: 100000, toName: '  ' }).ok).toBe(false)
  })
  it('金额 ≤0 → 拒绝', () => {
    expect(validateTransfer({ amount: 0, balance: 100000, toName: '老王' }).ok).toBe(false)
    expect(validateTransfer({ amount: -5, balance: 100000, toName: '老王' }).ok).toBe(false)
  })
  it('超单笔限额 → 拒绝', () => {
    const r = validateTransfer({ amount: TRANSFER_LIMIT + 1, balance: 999999, toName: '老王' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('单笔')
  })
  it('超可用余额 → 拒绝', () => {
    expect(validateTransfer({ amount: 5000, balance: 4000, toName: '老王' }).ok).toBe(false)
  })
  it('合法 → 通过且金额取整', () => {
    const r = validateTransfer({ amount: 10000.7, balance: 100000, toName: '老王' })
    expect(r.ok).toBe(true)
    expect(r.amount).toBe(10001)
  })
  it('刚好等于限额 → 通过', () => {
    expect(validateTransfer({ amount: TRANSFER_LIMIT, balance: TRANSFER_LIMIT, toName: '老王' }).ok).toBe(true)
  })
})

describe('信誉 applyRepPenalty（耍赖降信誉，不动积分）', () => {
  it('各类耍赖按对应幅度扣', () => {
    expect(applyRepPenalty(100, 'delay')).toBe(100 - REP_PENALTY.delay)
    expect(applyRepPenalty(100, 'misjudge')).toBe(100 - REP_PENALTY.misjudge)
    expect(applyRepPenalty(100, 'deadbeat')).toBe(100 - REP_PENALTY.deadbeat)
  })
  it('信誉不为负（夹到 0）', () => {
    expect(applyRepPenalty(5, 'deadbeat')).toBe(0)
  })
  it('未知类型 → 不扣', () => {
    expect(applyRepPenalty(80, 'xxx')).toBe(80)
  })
  it('undefined 信誉按 100 起算', () => {
    expect(applyRepPenalty(undefined, 'delay')).toBe(100 - REP_PENALTY.delay)
  })
})

describe('老赖榜 deadbeatBoard（逾期欠条 + 低信誉公开处刑）', () => {
  const overdueAt = now - (OVERDUE_DAYS * DAY + 2 * DAY) // 已逾期 2 天超阈值
  const freshAt = now - 1000 // 刚结算，未逾期

  it('我赢→对手(taker)欠彩头；我输→我欠', () => {
    const matches = [
      // 我押 A 且结果 A → 我赢 → 对手欠
      { id: 'm1', title: '盘1', ownerSide: 'A', result: 'A', takerName: '老王', takerEmoji: '🧔',
        sideBet: { text: '请吃饭', fulfilled: false }, settledAt: overdueAt },
      // 我押 A 但结果 B → 我输 → 我欠
      { id: 'm2', title: '盘2', ownerSide: 'A', result: 'B', takerName: '阿强', takerEmoji: '😎',
        sideBet: { text: '发红包', fulfilled: false }, settledAt: overdueAt },
    ]
    const { debts } = deadbeatBoard({
      players: [{ isMe: true, name: '我', emoji: '🫵', reputation: 100 }],
      matches, offlineMatches: [], overdueFn: isSideBetOverdue, meName: '我', now,
    })
    expect(debts.length).toBe(2)
    expect(debts.find((d) => d.id === 'm1').debtorName).toBe('老王')
    expect(debts.find((d) => d.id === 'm2').debtorName).toBe('我')
  })

  it('已还愿 / 未逾期 → 不进欠条', () => {
    const matches = [
      { id: 'm3', title: '盘3', ownerSide: 'A', result: 'A', takerName: '老王',
        sideBet: { text: '请吃饭', fulfilled: true }, settledAt: overdueAt }, // 已还愿
      { id: 'm4', title: '盘4', ownerSide: 'A', result: 'A', takerName: '老王',
        sideBet: { text: '请吃饭', fulfilled: false }, settledAt: freshAt }, // 未逾期
    ]
    const { debts } = deadbeatBoard({
      players: [], matches, offlineMatches: [], overdueFn: isSideBetOverdue, now,
    })
    expect(debts.length).toBe(0)
  })

  it('线下打球逾期彩头也入榜，欠债方=输家', () => {
    const offlineMatches = [
      { id: 'o1', rivalName: '胖子', rivalEmoji: '🐷', sport: '网球', score: '6-4',
        iWon: true, sideBet: { text: '请喝奶茶', fulfilled: false }, at: overdueAt },
    ]
    const { debts } = deadbeatBoard({
      players: [{ isMe: true, name: '我', emoji: '🫵' }],
      matches: [], offlineMatches, overdueFn: isSideBetOverdue, meName: '我', now,
    })
    expect(debts.length).toBe(1)
    expect(debts[0].debtorName).toBe('胖子') // 我赢 → 对手欠
    expect(debts[0].kind).toBe('offline')
  })

  it('低信誉玩家进信誉区，信誉升序；正常信誉不进', () => {
    const players = [
      { name: '我', emoji: '🫵', isMe: true, reputation: 100 },
      { name: '老王', emoji: '🧔', reputation: 65 },
      { name: '阿强', emoji: '😎', reputation: 40 },
      { name: '胖子', emoji: '🐷', reputation: 90 },
    ]
    const { lowRep } = deadbeatBoard({
      players, matches: [], offlineMatches: [], overdueFn: isSideBetOverdue, now,
    })
    expect(lowRep.map((p) => p.name)).toEqual(['阿强', '老王']) // <70，升序
  })

  it('欠条按逾期天数降序', () => {
    const matches = [
      { id: 'a', title: 'A', ownerSide: 'A', result: 'A', takerName: '老王',
        sideBet: { text: 'x', fulfilled: false }, settledAt: now - (OVERDUE_DAYS * DAY + 1 * DAY) },
      { id: 'b', title: 'B', ownerSide: 'A', result: 'A', takerName: '阿强',
        sideBet: { text: 'y', fulfilled: false }, settledAt: now - (OVERDUE_DAYS * DAY + 10 * DAY) },
    ]
    const { debts } = deadbeatBoard({
      players: [], matches, offlineMatches: [], overdueFn: isSideBetOverdue, now,
    })
    expect(debts[0].id).toBe('b') // 逾期更久在前
  })
})
