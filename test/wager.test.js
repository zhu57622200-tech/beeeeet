import { describe, it, expect } from 'vitest'
import { takerStakeFor, settleMatch, settleBanker, settlePool } from '../src/core/wager.js'

describe('takerStakeFor', () => {
  it('等额赔率(2.0)：接盘额等于下注额', () => {
    expect(takerStakeFor(100, 2)).toBe(100)
  })

  it('非对等赔率(2.5)：接盘额 = 100×1.5 = 150', () => {
    expect(takerStakeFor(100, 2.5)).toBe(150)
  })

  it('非对等赔率(1.3) 四舍五入：100×0.3 = 30', () => {
    expect(takerStakeFor(100, 1.3)).toBe(30)
  })

  it('需要四舍五入：333×(1.5-1)=166.5 → 167', () => {
    expect(takerStakeFor(333, 1.5)).toBe(167)
  })
})

describe('settleMatch', () => {
  it('房主押 A、结果 A → 房主赢，拿走 pot，taker 归零', () => {
    const r = settleMatch({ ownerStake: 100, takerStake: 100, ownerSide: 'A', result: 'A' })
    expect(r).toEqual({ ownerPayout: 200, takerPayout: 0 })
  })

  it('房主押 A、结果 B → 接盘方赢，拿走 pot，owner 归零', () => {
    const r = settleMatch({ ownerStake: 100, takerStake: 150, ownerSide: 'A', result: 'B' })
    expect(r).toEqual({ ownerPayout: 0, takerPayout: 250 })
  })

  it('非对等赔率下房主赢：100 + 150 = 250 全归房主', () => {
    const r = settleMatch({ ownerStake: 100, takerStake: 150, ownerSide: 'A', result: 'A' })
    expect(r).toEqual({ ownerPayout: 250, takerPayout: 0 })
  })
})

describe('守恒性：赢家所得 = 两边冻结总额，系统不增不减', () => {
  it('房主赢时守恒', () => {
    const ownerStake = 100
    const odds = 2.5
    const takerStake = takerStakeFor(ownerStake, odds)
    const r = settleMatch({ ownerStake, takerStake, ownerSide: 'A', result: 'A' })
    expect(r.ownerPayout + r.takerPayout).toBe(ownerStake + takerStake)
  })

  it('接盘方赢时守恒', () => {
    const ownerStake = 200
    const odds = 1.8
    const takerStake = takerStakeFor(ownerStake, odds)
    const r = settleMatch({ ownerStake, takerStake, ownerSide: 'Yes', result: 'No' })
    expect(r.ownerPayout + r.takerPayout).toBe(ownerStake + takerStake)
  })
})

// ───────────────────────── 坐庄 settleBanker ─────────────────────────
describe('settleBanker 坐庄', () => {
  it('押中：庄家赔净赢，押中者拿本金×赔率', () => {
    // 赔率2.0，一人押A 100，结果A → 押中者净赢100，庄家亏100。
    const r = settleBanker({ bankerOdds: 2, bets: [{ side: 'A', stake: 100 }], result: 'A' })
    expect(r.payouts).toEqual([{ betIndex: 0, payout: 200 }])
    expect(r.bankerPnl).toBe(-100)
  })

  it('押错：本金归庄家，押注者 payout=0', () => {
    const r = settleBanker({ bankerOdds: 2, bets: [{ side: 'A', stake: 100 }], result: 'B' })
    expect(r.payouts).toEqual([{ betIndex: 0, payout: 0 }])
    expect(r.bankerPnl).toBe(100)
  })

  it('多人混合：押中押错并存，庄家净盈亏正确', () => {
    // 赔率2.0：押A 100(中)、押B 200(错)、押A 50(中)；结果A。
    // 庄家：吃B 200；赔A净赢 = 100+50=150 → bankerPnl=200-150=50。
    const r = settleBanker({
      bankerOdds: 2,
      bets: [{ side: 'A', stake: 100 }, { side: 'B', stake: 200 }, { side: 'A', stake: 50 }],
      result: 'A',
    })
    expect(r.bankerPnl).toBe(50)
    const byIdx = Object.fromEntries(r.payouts.map((p) => [p.betIndex, p.payout]))
    expect(byIdx[0]).toBe(200) // 100×2
    expect(byIdx[1]).toBe(0)   // 押错
    expect(byIdx[2]).toBe(100) // 50×2
  })

  it('零和守恒（未封顶）：庄家净盈亏 + 押注者净盈亏 = 0', () => {
    const bets = [{ side: 'A', stake: 100 }, { side: 'B', stake: 80 }, { side: 'A', stake: 60 }]
    const r = settleBanker({ bankerOdds: 1.8, bets, result: 'A' })
    const bettorsPnl = r.payouts.reduce((s, p) => s + (p.payout - bets[p.betIndex].stake), 0)
    expect(r.bankerPnl + bettorsPnl).toBeCloseTo(0, 9)
  })

  it('封顶：庄家被薅爆时亏损封顶在 -bankerCap', () => {
    // 赔率5.0，一人押A 1000(中)，结果A → 理论庄家亏4000；封顶 bankerCap=500。
    const r = settleBanker({ bankerOdds: 5, bets: [{ side: 'A', stake: 1000 }], result: 'A', bankerCap: 500 })
    expect(r.bankerPnl).toBe(-500)
    // 押中者本金1000 + 封顶后可分净赢：payable = loserStake(0)+cap(500)=500 → payout=1500。
    expect(r.payouts[0].payout).toBe(1500)
  })

  it('不封顶：cap 充足时不削减，等于理论值', () => {
    const r = settleBanker({ bankerOdds: 3, bets: [{ side: 'A', stake: 100 }], result: 'A', bankerCap: 99999 })
    expect(r.bankerPnl).toBe(-200) // 净赢200
    expect(r.payouts[0].payout).toBe(300)
  })

  it('封顶按比例削减多个押中者', () => {
    // 赔率3.0：押A 100、押A 300（均中），结果A；理论净赢=200+600=800，庄家亏800。
    // 封顶 cap=400，无押错方 → payable=400，ratio=400/800=0.5。
    // 押中者净赢各砍半：100→本金100+净赢200×0.5=100 → 200；300→300+600×0.5=300 → 600。
    const r = settleBanker({
      bankerOdds: 3,
      bets: [{ side: 'A', stake: 100 }, { side: 'A', stake: 300 }],
      result: 'A',
      bankerCap: 400,
    })
    expect(r.bankerPnl).toBe(-400)
    const byIdx = Object.fromEntries(r.payouts.map((p) => [p.betIndex, p.payout]))
    expect(byIdx[0]).toBe(200)
    expect(byIdx[1]).toBe(600)
  })
})

// ───────────────────────── 彩池 settlePool ─────────────────────────
describe('settlePool 彩池', () => {
  it('瓜分：赢方按比例分输方池', () => {
    // A边 100+100=200(中)，B边 300(错)。结果A。
    // 赢家1：100 + (100/200)×300 = 250；赢家2同 250。
    const r = settlePool({ sideA: [100, 100], sideB: [300], result: 'A' })
    const map = r.payouts.filter((p) => p.side === 'A').map((p) => p.payout)
    expect(map).toEqual([250, 250])
    // 输方 payout=0
    expect(r.payouts.filter((p) => p.side === 'B').every((p) => p.payout === 0)).toBe(true)
  })

  it('守恒：赢方总 payout = 两边总池', () => {
    const sideA = [120, 80, 50]
    const sideB = [200, 60]
    const r = settlePool({ sideA, sideB, result: 'A' })
    const total = [...sideA, ...sideB].reduce((s, x) => s + x, 0)
    const winTotal = r.payouts.filter((p) => p.side === 'A').reduce((s, p) => s + p.payout, 0)
    expect(winTotal).toBeCloseTo(total, 9)
  })

  it('B 赢时守恒', () => {
    const sideA = [100]
    const sideB = [50, 50]
    const r = settlePool({ sideA, sideB, result: 'B' })
    const winTotal = r.payouts.filter((p) => p.side === 'B').reduce((s, p) => s + p.payout, 0)
    expect(winTotal).toBeCloseTo(200, 9)
  })

  it('一边空（输方池为空）：赢方只拿回本金', () => {
    // A 中、B 空 → losePool=0，赢家只拿本金。
    const r = settlePool({ sideA: [100, 200], sideB: [], result: 'A' })
    expect(r.payouts.find((p) => p.index === 0).payout).toBe(100)
    expect(r.payouts.find((p) => p.index === 1).payout).toBe(200)
  })

  it('赢方空（没人押中）：无人瓜分，赢方 payout=0', () => {
    const r = settlePool({ sideA: [], sideB: [100], result: 'A' })
    expect(r.payouts.filter((p) => p.side === 'A')).toEqual([])
    expect(r.payouts.filter((p) => p.side === 'B').every((p) => p.payout === 0)).toBe(true)
  })
})
