import { describe, it, expect } from 'vitest'
import { isSideBetOverdue, offlineScoreDelta, OVERDUE_DAYS } from '../src/core/offline.js'

const DAY = 24 * 60 * 60 * 1000

describe('isSideBetOverdue（线下彩头还愿逾期）', () => {
  const now = 1_000_000_000_000

  it('已还愿 → 永不逾期', () => {
    const sb = { fulfilled: true }
    expect(isSideBetOverdue(sb, now - 99 * DAY, now)).toBe(false)
  })

  it('未还愿但未结算（无 settledAt）→ 不算逾期', () => {
    expect(isSideBetOverdue({ fulfilled: false }, null, now)).toBe(false)
    expect(isSideBetOverdue({ fulfilled: false }, undefined, now)).toBe(false)
  })

  it('未还愿 + 结算后未超阈值 → 不逾期', () => {
    const settledAt = now - (OVERDUE_DAYS * DAY - 1000)
    expect(isSideBetOverdue({ fulfilled: false }, settledAt, now)).toBe(false)
  })

  it('未还愿 + 结算后超阈值 → 逾期', () => {
    const settledAt = now - (OVERDUE_DAYS * DAY + 1000)
    expect(isSideBetOverdue({ fulfilled: false }, settledAt, now)).toBe(true)
  })

  it('无彩头 → 不逾期', () => {
    expect(isSideBetOverdue(null, now - 99 * DAY, now)).toBe(false)
  })
})

describe('offlineScoreDelta（打球积分赌注结算）', () => {
  it('不挂积分（0/空）→ 纯记录，余额不动', () => {
    expect(offlineScoreDelta(true, 0)).toEqual({ delta: 0, settled: false })
    expect(offlineScoreDelta(false, undefined)).toEqual({ delta: 0, settled: false })
    expect(offlineScoreDelta(true, null)).toEqual({ delta: 0, settled: false })
  })

  it('挂积分 + 赢 → +stake', () => {
    expect(offlineScoreDelta(true, 10000)).toEqual({ delta: 10000, settled: true })
  })

  it('挂积分 + 输 → -stake', () => {
    expect(offlineScoreDelta(false, 10000)).toEqual({ delta: -10000, settled: true })
  })

  it('负数/非法 stake → 当作纯记录', () => {
    expect(offlineScoreDelta(true, -5)).toEqual({ delta: 0, settled: false })
    expect(offlineScoreDelta(true, 'abc')).toEqual({ delta: 0, settled: false })
  })
})
