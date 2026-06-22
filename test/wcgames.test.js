import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWorldCupEvents, fetchWorldCupGames } from '../src/api.js'
import { COUNTRY_ZH } from '../src/core/i18n-sports.js'

function yesNo(yes) {
  return {
    outcomes: '["Yes","No"]',
    outcomePrices: JSON.stringify([String(yes), String(1 - yes)]),
  }
}

function market(id, sportsMarketType, question, yes) {
  return {
    id,
    question,
    sportsMarketType,
    ...yesNo(yes),
  }
}

function wcGameEvent() {
  const exactScores = Array.from({ length: 17 }, (_, i) => {
    const home = Math.floor(i / 4)
    const away = i % 4
    return market(
      `score-${home}-${away}`,
      'soccer_exact_score',
      `Will Korea Republic vs. Czechia end ${home}-${away}?`,
      0.03 + i / 1000,
    )
  })
  exactScores[0] = market(
    'score-2-1',
    'soccer_exact_score',
    'Will Korea Republic vs. Czechia end 2-1?',
    0.08,
  )
  return {
    id: 'event-game-1',
    gameId: 'game-kr-cz',
    slug: 'fifwc-kr-cze-2026-06-11',
    title: 'Korea Republic vs. Czechia',
    startDate: '2026-06-11T20:00:00Z',
    icon: 'https://example.test/icon.png',
    volume24hr: 123,
    markets: [
      market('ml-kr', 'moneyline', 'Will Korea Republic win on 2026-06-11?', 0.44),
      market('ml-draw', 'moneyline', 'Will Korea Republic vs. Czechia end in a draw?', 0.28),
      market('ml-cz', 'moneyline', 'Will Czechia win on 2026-06-11?', 0.28),
      market('ht-kr', 'soccer_halftime_result', 'Will Korea Republic lead at halftime?', 0.35),
      market('ht-draw', 'soccer_halftime_result', 'Will the game be a draw at halftime?', 0.42),
      market('ht-cz', 'soccer_halftime_result', 'Will Czechia lead at halftime?', 0.23),
      ...exactScores,
    ],
  }
}

describe('世界杯单场赛程聚合 fetchWorldCupGames', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('按 gameId 聚成 wcgame 卡，并按 sportsMarketType 分组', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(String(url)).toContain('https://gamma-api.polymarket.com/events?series_slug=soccer-fifwc')
      return { ok: true, json: async () => [wcGameEvent()], text: async () => '' }
    }))

    const out = await fetchWorldCupGames()
    expect(out).toHaveLength(1)
    const card = out[0]
    expect(card).toMatchObject({
      id: 'wcgame-game-kr-cz',
      kind: 'wcgame',
      category: '体育',
      subcat: '世界杯',
      enTitle: 'Korea Republic vs. Czechia',
      zhTitle: '韩国 vs 捷克',
      gameDate: '2026-06-11',
      icon: 'https://example.test/icon.png',
    })
    expect(card.groups.moneyline).toHaveLength(3)
    expect(card.groups.halftime).toHaveLength(3)
    expect(card.groups.exactScore.length).toBeGreaterThanOrEqual(1)
    expect(card.groups.moneyline.find((r) => r.marketId === 'ml-draw').zhName).toBe('平局')
    expect(card.groups.exactScore.find((r) => r.marketId === 'score-2-1').score).toMatch(/^2[-:]1$/)
    expect(card.markets[0]).toMatchObject({
      id: 'ml-kr',
      question: 'Will Korea Republic win on 2026-06-11?',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.44","0.56"]',
      sportsMarketType: 'moneyline',
    })
  })
})

describe('世界杯玩法子分类与体育词典', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('按 wc/world-cup tag 映射 wcSubcat，无命中时落其他玩法', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          id: 'award',
          slug: 'world-cup-golden-boot',
          title: 'World Cup Golden Boot',
          tags: [{ slug: 'world-cup-awards', label: 'World Cup Awards' }],
          markets: [market('award-m', 'winner', 'Will Korea Republic win?', 0.5)],
        },
        {
          id: 'other',
          slug: 'fifa-long-tail',
          title: 'FIFA long tail prop',
          tags: [{ slug: 'soccer', label: 'Soccer' }],
          markets: [market('other-m', 'winner', 'Will Czechia win?', 0.5)],
        },
      ],
      text: async () => '',
    })))

    const out = await fetchWorldCupEvents()
    expect(out.find((e) => e.id === 'award').wcSubcat).toBe('奖项')
    expect(out.find((e) => e.id === 'other').wcSubcat).toBe('其他玩法')
  })

  it('COUNTRY_ZH 覆盖本场队名', () => {
    expect(COUNTRY_ZH['Korea Republic']).toBe('韩国')
    expect(COUNTRY_ZH.Czechia).toBe('捷克')
  })
})
