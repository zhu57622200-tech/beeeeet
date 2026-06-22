import { describe, expect, it } from 'vitest'
import { searchMarkets } from '../src/core/search.js'

const pmList = [
  { id: 'pm-1', title: '世界杯冠军', enTitle: 'World Cup Winner', category: '体育', subcat: '世界杯',
    outright: [{ name: 'Brazil', zhName: '巴西' }, { name: 'France', zhName: '法国' }] },
  { id: 'pm-2', title: '比特币年底价格', enTitle: 'Bitcoin price by year end', category: '加密', subcat: 'BTC',
    markets: [{ question: 'Above 100k?', zhQuestion: '会破10万美元吗' }] },
]

const matches = [
  { id: 'm-1', title: '今晚谁买单', optionA: '老王', optionB: '阿强' },
  { id: 'm-2', title: 'NBA 总冠军', optionA: 'Warriors', optionB: 'Celtics' },
]

describe('searchMarkets', () => {
  it('中文命中系统盘 title', () => {
    const result = searchMarkets({ pmList, matches, query: '世界杯' })

    expect(result.pm.map((ev) => ev.id)).toEqual(['pm-1'])
    expect(result.matches).toEqual([])
  })

  it('英文大小写不敏感命中系统盘 enTitle', () => {
    const result = searchMarkets({ pmList, matches, query: 'bitcoin' })

    expect(result.pm.map((ev) => ev.id)).toEqual(['pm-2'])
    expect(result.matches).toEqual([])
  })

  it('命中约赌 title、optionA 或 optionB', () => {
    const result = searchMarkets({ pmList, matches, query: 'warriors' })

    expect(result.pm).toEqual([])
    expect(result.matches.map((m) => m.id)).toEqual(['m-2'])
  })

  it('空 query 返回两个空数组', () => {
    expect(searchMarkets({ pmList, matches, query: '   ' })).toEqual({ pm: [], matches: [] })
  })

  it('无命中返回空数组', () => {
    expect(searchMarkets({ pmList, matches, query: '火星' })).toEqual({ pm: [], matches: [] })
  })

  it('命中约赌 title 与 optionB 分支', () => {
    expect(searchMarkets({ pmList, matches, query: '买单' }).matches.map((m) => m.id)).toEqual(['m-1'])
    expect(searchMarkets({ pmList, matches, query: 'celtics' }).matches.map((m) => m.id)).toEqual(['m-2'])
  })

  it('命中榜单候选名与子盘问题（中/英）', () => {
    expect(searchMarkets({ pmList, matches, query: '巴西' }).pm.map((e) => e.id)).toEqual(['pm-1'])
    expect(searchMarkets({ pmList, matches, query: 'brazil' }).pm.map((e) => e.id)).toEqual(['pm-1'])
    expect(searchMarkets({ pmList, matches, query: '破10万' }).pm.map((e) => e.id)).toEqual(['pm-2'])
  })

  it('字段缺失/undefined 不炸', () => {
    const sparse = [{ id: 'x' }, { id: 'y', title: null, markets: [{}], outright: [{}] }]
    expect(searchMarkets({ pmList: sparse, matches: [{ id: 'z' }], query: 'abc' })).toEqual({ pm: [], matches: [] })
    expect(searchMarkets({ query: 'abc' })).toEqual({ pm: [], matches: [] })
  })
})
