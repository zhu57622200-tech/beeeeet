import { describe, it, expect } from 'vitest'
import { parseMarketPlayType, isMainPlayType, parseMarketLine, aggregateOutright, groupMatchMarkets, isMatchEvent } from '../src/api.js'

// 用真实 gamma API 的玩法命名模式构造 market（NBA 单场 + 世界杯 outright）。
const mkt = (question, groupItemTitle = '', outcomes = ['Yes', 'No']) => ({
  question,
  groupItemTitle,
  outcomes: JSON.stringify(outcomes),
  outcomePrices: '["0.5","0.5"]',
})

const pricedMkt = ({ id, question, groupItemTitle = '', outcomes = ['Yes', 'No'], prices = ['0.5', '0.5'], volume = 1000 }) => ({
  id,
  question,
  groupItemTitle,
  volume24hr: volume,
  outcomes: JSON.stringify(outcomes),
  outcomePrices: JSON.stringify(prices),
})

describe('P1 玩法识别 parseMarketPlayType', () => {
  it('胜负线 moneyline：git 空 + "A vs. B" + 两队名选项', () => {
    expect(parseMarketPlayType(mkt('Spurs vs. Knicks', '', ['Spurs', 'Knicks']))).toBe('moneyline')
  })
  it('显式 Moneyline 命名', () => {
    expect(parseMarketPlayType(mkt('Spurs vs. Knicks: Moneyline', 'Moneyline', ['Spurs', 'Knicks']))).toBe('moneyline')
  })
  it('让分 spread：Spread -2.5', () => {
    expect(parseMarketPlayType(mkt('Spread: Knicks (-2.5)', 'Spread -2.5', ['Knicks', 'Spurs']))).toBe('spread')
  })
  it('大小分 total：O/U 215.5', () => {
    expect(parseMarketPlayType(mkt('Spurs vs. Knicks: O/U 215.5', 'O/U 215.5', ['Over', 'Under']))).toBe('total')
  })
  it('冠军期货 outright：Yes/No + 实体名', () => {
    expect(parseMarketPlayType(mkt('Will Spain win the 2026 FIFA World Cup?', 'Spain'))).toBe('outright')
    expect(parseMarketPlayType(mkt('Will South Korea advance to the knockout stages?', 'South Korea'))).toBe('outright')
    expect(parseMarketPlayType(mkt('Will Lionel Messi be the top goalscorer?', 'Lionel Messi'))).toBe('outright')
  })
  it('球员道具盘 player_prop：球员名: Points/Rebounds/Assists O/U', () => {
    expect(parseMarketPlayType(mkt('Victor Wembanyama: Points O/U 27.5', 'Victor Wembanyama: Points O/U 27.5', ['Over', 'Under']))).toBe('player_prop')
    expect(parseMarketPlayType(mkt('Jalen Brunson: Assists O/U 6.5', 'Jalen Brunson: Assists O/U 6.5', ['Over', 'Under']))).toBe('player_prop')
  })
  it('趣味盘 novelty：谁先得分 / 奇偶', () => {
    expect(parseMarketPlayType(mkt('Spurs vs. Knicks: Team to Score First', 'Team to Score First', ['Spurs', 'Knicks']))).toBe('novelty')
    expect(parseMarketPlayType(mkt('Spurs vs. Knicks: Odd/Even Score', 'Odd/Even Score', ['Odd', 'Even']))).toBe('novelty')
  })
  it('半场盘 half：1H 前缀（含 1H Spread / 1H O/U / 1H Moneyline）', () => {
    expect(parseMarketPlayType(mkt('1H Spread: Knicks (-0.5)', '1H Spread -0.5', ['Knicks', 'Spurs']))).toBe('half')
    expect(parseMarketPlayType(mkt('Spurs vs. Knicks: 1H O/U 111.5', '1H O/U 111.5', ['Over', 'Under']))).toBe('half')
    expect(parseMarketPlayType(mkt('Spurs vs. Knicks: 1H Moneyline', '1H Moneyline', ['Spurs', 'Knicks']))).toBe('half')
  })
  it('空/异常 market → other', () => {
    expect(parseMarketPlayType(null)).toBe('other')
    expect(parseMarketPlayType(mkt('一些没头绪的盘', '', ['A', 'B', 'C']))).toBe('other')
  })
})

describe('P1 精选主玩法 isMainPlayType', () => {
  it('保留 胜负线/让分/大小分/冠军期货', () => {
    expect(isMainPlayType('moneyline')).toBe(true)
    expect(isMainPlayType('spread')).toBe(true)
    expect(isMainPlayType('total')).toBe(true)
    expect(isMainPlayType('outright')).toBe(true)
  })
  it('砍掉 球员道具/趣味/半场/other', () => {
    expect(isMainPlayType('player_prop')).toBe(false)
    expect(isMainPlayType('novelty')).toBe(false)
    expect(isMainPlayType('half')).toBe(false)
    expect(isMainPlayType('other')).toBe(false)
  })
})

describe('P1 盘口线 parseMarketLine', () => {
  it('让分取带符号数值', () => {
    expect(parseMarketLine(mkt('Spread: Knicks (-2.5)', 'Spread -2.5'))).toBe(-2.5)
    expect(parseMarketLine(mkt('Spread: Spurs (-5.5)', 'Spread -5.5'))).toBe(-5.5)
  })
  it('大小分取数值', () => {
    expect(parseMarketLine(mkt('Spurs vs. Knicks: O/U 215.5', 'O/U 215.5', ['Over', 'Under']))).toBe(215.5)
  })
  it('无盘口线（moneyline/outright）→ null', () => {
    expect(parseMarketLine(mkt('Spurs vs. Knicks', '', ['Spurs', 'Knicks']))).toBe(null)
    expect(parseMarketLine(mkt('Will Spain win?', 'Spain'))).toBe(null)
  })
})

describe('P1 outright 榜单聚合 aggregateOutright', () => {
  // 模拟 world-cup-winner 风 event：每个候选一个 Yes/No market，Yes 价即夺冠概率。
  const wcWinner = {
    markets: [
      { id: 1, question: 'Will Spain win the 2026 FIFA World Cup?', groupItemTitle: 'Spain', outcomes: '["Yes","No"]', outcomePrices: '["0.1615","0.8385"]' },
      { id: 2, question: 'Will New Zealand win the 2026 FIFA World Cup?', groupItemTitle: 'New Zealand', outcomes: '["Yes","No"]', outcomePrices: '["0.0005","0.9995"]' },
      { id: 3, question: 'Will France win the 2026 FIFA World Cup?', groupItemTitle: 'France', outcomes: '["Yes","No"]', outcomePrices: '["0.12","0.88"]' },
    ],
  }
  it('按 Yes 概率降序排出榜单，保留 marketId + 真实 outcomes', () => {
    const rows = aggregateOutright(wcWinner)
    expect(rows.map((r) => r.name)).toEqual(['Spain', 'France', 'New Zealand']) // 0.1615 > 0.12 > 0.0005
    expect(rows[0]).toMatchObject({ marketId: '1', name: 'Spain', prob: 0.1615, outcomes: '["Yes","No"]' })
  })
  it('非 outright 的 market 不计入榜单', () => {
    const mixed = {
      markets: [
        { id: 9, question: 'Spurs vs. Knicks: O/U 215.5', groupItemTitle: 'O/U 215.5', outcomes: '["Over","Under"]', outcomePrices: '["0.5","0.5"]' },
        { id: 1, question: 'Will Spain win?', groupItemTitle: 'Spain', outcomes: '["Yes","No"]', outcomePrices: '["0.16","0.84"]' },
      ],
    }
    const rows = aggregateOutright(mixed)
    expect(rows.map((r) => r.name)).toEqual(['Spain'])
  })
  it('空 event → []', () => {
    expect(aggregateOutright(null)).toEqual([])
    expect(aggregateOutright({ markets: [] })).toEqual([])
  })
})

describe('P3 单场玩法分组 groupMatchMarkets', () => {
  function nbaMatch() {
    return {
      id: 'nba1',
      title: 'Spurs vs. Knicks',
      markets: [
        pricedMkt({ id: 'prop', question: 'Victor Wembanyama: Points O/U 27.5', groupItemTitle: 'Victor Wembanyama: Points O/U 27.5', outcomes: ['Over', 'Under'], prices: ['0.51', '0.49'] }),
        pricedMkt({ id: 'half', question: 'Spurs vs. Knicks: 1H Moneyline', groupItemTitle: '1H Moneyline', outcomes: ['Spurs', 'Knicks'], prices: ['0.5', '0.5'] }),
        pricedMkt({ id: 'fun', question: 'Spurs vs. Knicks: Team to Score First', groupItemTitle: 'Team to Score First', outcomes: ['Spurs', 'Knicks'], prices: ['0.5', '0.5'] }),
        pricedMkt({ id: 'ml-low', question: 'Spurs vs. Knicks: Moneyline', groupItemTitle: 'Moneyline', outcomes: ['Spurs', 'Knicks'], prices: ['0.46', '0.54'], volume: 100 }),
        pricedMkt({ id: 'ml-main', question: 'Spurs vs. Knicks', groupItemTitle: '', outcomes: ['Spurs', 'Knicks'], prices: ['0.47', '0.53'], volume: 2000 }),
        pricedMkt({ id: 'sp-wide', question: 'Spurs vs. Knicks: Spread -8.5', groupItemTitle: 'Spread -8.5', outcomes: ['Spurs', 'Knicks'], prices: ['0.35', '0.65'] }),
        pricedMkt({ id: 'sp-main', question: 'Spurs vs. Knicks: Spread -2.5', groupItemTitle: 'Spread -2.5', outcomes: ['Spurs', 'Knicks'], prices: ['0.49', '0.51'] }),
        pricedMkt({ id: 'tot-low', question: 'Spurs vs. Knicks: O/U 210.5', groupItemTitle: 'O/U 210.5', outcomes: ['Over', 'Under'], prices: ['0.62', '0.38'] }),
        pricedMkt({ id: 'tot-main', question: 'Spurs vs. Knicks: O/U 215.5', groupItemTitle: 'O/U 215.5', outcomes: ['Over', 'Under'], prices: ['0.48', '0.52'] }),
      ],
    }
  }

  it('精选胜负线、让分主线、大小分主线，并砍掉球员道具/趣味/半场', () => {
    const grouped = groupMatchMarkets(nbaMatch())
    expect(grouped.teams).toEqual(['Spurs', 'Knicks'])
    expect(grouped.moneyline.marketId).toBe('ml-main') // 主胜负线取全场主盘里 volume 最高
    expect(grouped.moneyline.options).toEqual([{ name: 'Spurs', prob: 0.47 }, { name: 'Knicks', prob: 0.53 }])
    expect(grouped.spread).toMatchObject({ marketId: 'sp-main', line: -2.5 })
    expect(grouped.total).toMatchObject({ marketId: 'tot-main', line: 215.5 })
    expect([grouped.moneyline.marketId, grouped.spread.marketId, grouped.total.marketId]).not.toContain('prop')
    expect([grouped.moneyline.marketId, grouped.spread.marketId, grouped.total.marketId]).not.toContain('half')
    expect([grouped.moneyline.marketId, grouped.spread.marketId, grouped.total.marketId]).not.toContain('fun')
  })

  it('isMatchEvent：有 moneyline 且有 spread/total 才算单场', () => {
    expect(isMatchEvent(nbaMatch())).toBe(true)
    expect(isMatchEvent({ markets: [pricedMkt({ id: 'ml', question: 'Spurs vs. Knicks', outcomes: ['Spurs', 'Knicks'] })] })).toBe(false)
    expect(isMatchEvent({ markets: [pricedMkt({ id: 'tot', question: 'Spurs vs. Knicks: O/U 215.5', groupItemTitle: 'O/U 215.5', outcomes: ['Over', 'Under'] })] })).toBe(false)
  })
})
