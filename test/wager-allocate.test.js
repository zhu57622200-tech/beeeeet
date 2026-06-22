import { describe, expect, it } from 'vitest'
import { allocateIntegerPayouts } from '../src/core/wager.js'

describe('allocateIntegerPayouts', () => {
  it('逐笔 floor 后把余差给注额最大的赢家，并列取先下注者', () => {
    const payouts = allocateIntegerPayouts([
      { payout: 8.333, stake: 3 },
      { payout: 11.667, stake: 7 },
      { payout: 5, stake: 7 },
    ], 25)
    expect(payouts).toEqual([8, 12, 5])
    expect(payouts.reduce((sum, n) => sum + n, 0)).toBe(25)
  })

  it('没有赢家时不凭空生成派彩', () => {
    expect(allocateIntegerPayouts([], 100)).toEqual([])
  })
})
