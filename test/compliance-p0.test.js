import { describe, expect, it } from 'vitest'
import { isSensitiveEvent } from '../src/api.js'

function ev({ title = '', description = '', question = title } = {}) {
  return {
    id: 'p0-compliance',
    title,
    description,
    tags: [],
    markets: [
      { question, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' },
    ],
  }
}

describe('P0 合规补丁：description + NFKC', () => {
  it('description 含 xi jinping 且 title 干净时必须拦', () => {
    expect(isSensitiveEvent(ev({ title: 'China GDP growth above 5%', description: 'Xi Jinping related market' }))).toBe(true)
  })

  it('全角 taiwan invasion 归一化后必须拦', () => {
    expect(isSensitiveEvent(ev({ title: 'ｔａｉｗａｎ ｉｎｖａｓｉｏｎ by 2026?' }))).toBe(true)
  })

  it('中性台湾经济盘不误伤', () => {
    expect(isSensitiveEvent(ev({ title: 'Taiwan GDP growth above 3%?' }))).toBe(false)
  })

  it('中性伊朗油价盘不误伤', () => {
    expect(isSensitiveEvent(ev({ title: 'Will Iran oil price stay above 80?' }))).toBe(false)
  })
})
