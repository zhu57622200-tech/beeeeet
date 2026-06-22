import { describe, it, expect, beforeEach } from 'vitest'
import {
  store,
  register,
  resetAll,
  placePmBet,
  settlePmBetReal,
  settlePmBetSimulated,
} from '../src/store.js'
import {
  isSensitiveEvent,
  isPoliticalMilitaryEvent,
  isPlayableEvent,
  pmResolvedOutcome,
  parseOutcomes,
} from '../src/api.js'

beforeEach(() => {
  resetAll()
  register({ name: '我', password: 'x', agreedTerms: true })
})

function bet({ outcome = 'Yes', prob = 0.25, stake = 10000 } = {}) {
  return placePmBet({
    eventTitle: '某事件',
    marketQuestion: '会发生吗',
    outcome,
    prob,
    stake,
  })
}

describe('S11 押注下注：扣分 + pending', () => {
  it('下注扣分、记 ledger、初始 pending', () => {
    const before = store.balance
    const b = bet({ stake: 10000 })
    expect(store.balance).toBe(before - 10000)
    expect(b.status).toBe('pending')
    expect(b.payout).toBe(0)
    expect(store.ledger[0]).toMatchObject({ type: 'pm_bet', amount: -10000 })
  })
})

describe('S11 结算守恒：真实揭晓', () => {
  it('押中 → 派彩 = stake*odds，净赚守恒', () => {
    const start = store.balance
    const b = bet({ outcome: 'Yes', prob: 0.25, stake: 10000 }) // odds=4
    // 下注后扣 10000
    expect(store.balance).toBe(start - 10000)
    const res = settlePmBetReal(b.id, 'Yes')
    expect(res.status).toBe('won')
    // payout = 10000 * 4 = 40000（含本金），净 = -10000 + 40000 = +30000
    expect(res.payout).toBe(40000)
    expect(store.balance).toBe(start - 10000 + 40000)
    expect(store.ledger[0]).toMatchObject({ type: 'pm_win', amount: 40000 })
  })

  it('押错 → 本金已扣不返还，余额停在扣后', () => {
    const start = store.balance
    const b = bet({ outcome: 'Yes', prob: 0.25, stake: 10000 })
    const res = settlePmBetReal(b.id, 'No')
    expect(res.status).toBe('lost')
    expect(res.payout).toBe(0)
    expect(store.balance).toBe(start - 10000)
    expect(store.ledger[0]).toMatchObject({ type: 'pm_lose', amount: 0 })
  })

  it('重复结算幂等：不二次派彩', () => {
    const b = bet({ outcome: 'Yes', prob: 0.25, stake: 10000 })
    settlePmBetReal(b.id, 'Yes')
    const bal = store.balance
    expect(() => settlePmBetReal(b.id, 'Yes')).toThrow()
    expect(store.balance).toBe(bal)
  })
})

describe('S11 结算守恒：模拟揭晓（按概率）', () => {
  it('rnd<prob → 判赢并派彩', () => {
    const start = store.balance
    const b = bet({ outcome: 'Yes', prob: 0.25, stake: 10000 })
    const res = settlePmBetSimulated(b.id, () => 0.1) // 0.1 < 0.25 → 赢
    expect(res.status).toBe('won')
    expect(res.payout).toBe(40000)
    expect(store.balance).toBe(start - 10000 + 40000)
  })

  it('rnd>=prob → 判输无返还', () => {
    const start = store.balance
    const b = bet({ outcome: 'Yes', prob: 0.25, stake: 10000 })
    const res = settlePmBetSimulated(b.id, () => 0.9) // 0.9 >= 0.25 → 输
    expect(res.status).toBe('lost')
    expect(store.balance).toBe(start - 10000)
    expect(res.result).toBe('__other__')
  })
})

describe('S11 中国题材平衡', () => {
  const ev = (title) => ({ title, tags: [], markets: [] })

  it('中国经济中性题材可进（不敏感）', () => {
    expect(isSensitiveEvent(ev('China GDP growth above 5% in 2026?'))).toBe(false)
    expect(isSensitiveEvent(ev('Will China cut tariffs this year?'))).toBe(false)
    expect(isSensitiveEvent(ev('中国央行会降息吗'))).toBe(false)
    expect(isSensitiveEvent(ev('China trade surplus hits record?'))).toBe(false)
  })

  it('全放开（C）：台海/中国军事主权仍挡（独立红线，爹地2026-06-07拍板单独挡）', () => {
    expect(isSensitiveEvent(ev('Will China invade Taiwan in 2026?'))).toBe(true)
    expect(isSensitiveEvent(ev('China to blockade Taiwan strait?'))).toBe(true)
    expect(isSensitiveEvent(ev('台海会开战吗'))).toBe(true)
  })

  it('全放开（C）：通用军事政治题材放行', () => {
    expect(isSensitiveEvent(ev('US presidential election 2028'))).toBe(false)
    expect(isSensitiveEvent(ev('Russia Ukraine ceasefire'))).toBe(false)
  })

  it('开关 false 回退：原政治军事过滤仍能挡（isPoliticalMilitaryEvent 验证逻辑保留）', () => {
    expect(isPoliticalMilitaryEvent(ev('Will China invade Taiwan in 2026?'))).toBe(true)
    expect(isPoliticalMilitaryEvent(ev('China military blockade of strait?'))).toBe(true)
    expect(isPoliticalMilitaryEvent(ev('台海会开战吗'))).toBe(true)
    expect(isPoliticalMilitaryEvent(ev('US presidential election 2028'))).toBe(true)
    expect(isPoliticalMilitaryEvent(ev('Russia Ukraine ceasefire'))).toBe(true)
  })
})

describe('S11 真实揭晓探测 pmResolvedOutcome', () => {
  it('未结束盘口 → null', () => {
    const m = { closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]' }
    expect(pmResolvedOutcome(m)).toBe(null)
  })
  it('已结束盘口 → 取价格≈1的获胜结果', () => {
    const m = { closed: true, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' }
    expect(pmResolvedOutcome(m)).toBe('Yes')
  })
})
