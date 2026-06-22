import { describe, it, expect } from 'vitest'
import { getRank } from '../src/core/rank.js'

describe('getRank · 单数门槛', () => {
  it('零战绩 → 新晋赌徒', () => {
    expect(getRank({ wins: 0, losses: 0 }).name).toBe('新晋赌徒')
  })

  it('单数 < 5（4 单全胜也算新人，样本太小）', () => {
    expect(getRank({ wins: 4, losses: 0 }).name).toBe('新晋赌徒')
  })

  it('缺省参数不报错，返回新晋赌徒', () => {
    expect(getRank().name).toBe('新晋赌徒')
  })
})

describe('getRank · 各胜率档（单数已达门槛）', () => {
  it('胜率 < 30% → 反向指标人', () => {
    // 1 胜 9 负 = 10%
    expect(getRank({ wins: 1, losses: 9 }).name).toBe('反向指标人')
  })

  it('30%~45% → 青铜赌徒', () => {
    // 4 胜 6 负 = 40%
    expect(getRank({ wins: 4, losses: 6 }).name).toBe('青铜赌徒')
  })

  it('45%~55% → 白银预言家', () => {
    // 5 胜 5 负 = 50%
    expect(getRank({ wins: 5, losses: 5 }).name).toBe('白银预言家')
  })

  it('55%~65% → 黄金神算', () => {
    // 6 胜 4 负 = 60%
    expect(getRank({ wins: 6, losses: 4 }).name).toBe('黄金神算')
  })

  it('65%~75% → 铂金赌神', () => {
    // 7 胜 3 负 = 70%
    expect(getRank({ wins: 7, losses: 3 }).name).toBe('铂金赌神')
  })
})

describe('getRank · 封神门槛', () => {
  it('胜率 ≥ 75% 但单数 < 15 → 只到铂金赌神', () => {
    // 8 胜 2 负 = 80%，单数 10 < 15
    expect(getRank({ wins: 8, losses: 2 }).name).toBe('铂金赌神')
  })

  it('胜率 ≥ 75% 且单数 ≥ 15 → 料事如神', () => {
    // 15 胜 5 负 = 75%，单数 20
    expect(getRank({ wins: 15, losses: 5 }).name).toBe('料事如神')
  })
})

describe('getRank · 返回结构', () => {
  it('带 name/color/icon/winRate/settled 字段', () => {
    const r = getRank({ wins: 6, losses: 4 })
    expect(r).toMatchObject({ name: '黄金神算' })
    expect(typeof r.color).toBe('string')
    expect(typeof r.icon).toBe('string')
    expect(r.winRate).toBeCloseTo(0.6)
    expect(r.settled).toBe(10)
  })
})

describe('getRank · 精确边界值（防 < 误写成 <=）', () => {
  it('恰好 30% → 青铜赌徒（30% 不算反向）', () => {
    expect(getRank({ wins: 3, losses: 7 }).name).toBe('青铜赌徒')
  })
  it('恰好 45% → 白银预言家', () => {
    expect(getRank({ wins: 9, losses: 11 }).name).toBe('白银预言家')
  })
  it('恰好 55% → 黄金神算', () => {
    expect(getRank({ wins: 11, losses: 9 }).name).toBe('黄金神算')
  })
  it('恰好 65% → 铂金赌神', () => {
    expect(getRank({ wins: 13, losses: 7 }).name).toBe('铂金赌神')
  })
})

describe('getRank · 单数门槛精确', () => {
  it('恰好 5 单全输 → 反向指标人（5 单刚够参与胜率判断）', () => {
    expect(getRank({ wins: 0, losses: 5 }).name).toBe('反向指标人')
  })
  it('4 单有胜有负 → 仍新晋赌徒（样本不足）', () => {
    expect(getRank({ wins: 2, losses: 2 }).name).toBe('新晋赌徒')
  })
})

describe('getRank · 段位 color/icon 具体值', () => {
  it('料事如神 = 👑 金色', () => {
    const r = getRank({ wins: 15, losses: 5 })
    expect(r.icon).toBe('👑')
    expect(r.color).toBe('#ffd700')
  })
  it('反向指标人 = 🤡 红色', () => {
    const r = getRank({ wins: 0, losses: 5 })
    expect(r.icon).toBe('🤡')
    expect(r.color).toBe('#e74c3c')
  })
})
