import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchPolymarketEvents, fetchFinanceEvents, fetchNbaEvents, fetchTechEvents, fetchTrumpEvents, fetchWorldCupEvents } from '../src/api.js'
import { COUNTRY_ZH, PLAYER_ZH, TEAM_ZH, playTypeDescZh, playTypeZh, translateEntityLocal } from '../src/core/i18n-sports.js'
import {
  store,
  resetAll,
  register,
  pmUpdateNow,
  pmCachedList,
  pmCardNeedsZh,
  pmKindForEvent,
  placePmBet,
  autoSettlePendingBets,
  _setRetranslatePauseForTest,
} from '../src/store.js'

beforeEach(() => {
  _setRetranslatePauseForTest(0)
})

function wcMarket({ id, name, yes = '0.2' }) {
  return {
    id,
    question: `Will ${name} win the 2026 FIFA World Cup?`,
    groupItemTitle: name,
    outcomes: '["Yes","No"]',
    outcomePrices: JSON.stringify([yes, String(1 - Number(yes))]),
  }
}

function event({ id, slug, title, markets, volume = 1000, subcat } = {}) {
  return {
    id,
    slug,
    title,
    volume24hr: volume,
    createdAt: '2026-06-01T00:00:00Z',
    tags: [],
    subcat,
    markets,
  }
}

function simpleEvent({ id = 's1', title = 'Bitcoin above 100k?' } = {}) {
  return event({
    id,
    title,
    markets: [
      { id: 'm-' + id, question: title, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' },
    ],
  })
}

function nbaMarket({ id, groupItemTitle = '', outcomes = ['Spurs', 'Knicks'], prices = ['0.5', '0.5'] }) {
  return {
    id,
    question: groupItemTitle ? `Spurs vs. Knicks: ${groupItemTitle}` : 'Spurs vs. Knicks',
    groupItemTitle,
    outcomes: JSON.stringify(outcomes),
    outcomePrices: JSON.stringify(prices),
  }
}

function nbaMatch(id = 'nba1') {
  return {
    ...event({
    id,
    slug: 'spurs-knicks',
    title: 'Spurs vs. Knicks',
    subcat: 'NBA',
    markets: [
      nbaMarket({ id: 'ml', groupItemTitle: '', prices: ['0.46', '0.54'] }),
      nbaMarket({ id: 'spread', groupItemTitle: 'Spread -2.5', prices: ['0.49', '0.51'] }),
      nbaMarket({ id: 'total', groupItemTitle: 'O/U 215.5', outcomes: ['Over', 'Under'], prices: ['0.48', '0.52'] }),
    ],
    }),
    tags: [{ slug: 'nba', label: 'NBA' }],
  }
}

function nonWorldCupOutright(id = 'election') {
  return event({
    id,
    slug: 'us-election-candidates',
    title: 'Who will win the US election?',
    subcat: '政治',
    markets: [
      wcMarket({ id: 'm-a', name: 'Candidate A', yes: '0.4' }),
      wcMarket({ id: 'm-b', name: 'Candidate B', yes: '0.3' }),
      wcMarket({ id: 'm-c', name: 'Candidate C', yes: '0.2' }),
    ],
  })
}

function wcWinner(id = 'wc1') {
  return event({
    id,
    slug: 'world-cup-winner',
    title: '2026 FIFA World Cup Winner',
    subcat: '世界杯',
    markets: [
      wcMarket({ id: 'm-es', name: 'Spain', yes: '0.16' }),
      wcMarket({ id: 'm-fr', name: 'France', yes: '0.12' }),
      wcMarket({ id: 'm-br', name: 'Brazil', yes: '0.11' }),
    ],
  })
}

function wcSimple(id = 'wc-simple') {
  return event({
    id,
    slug: 'will-ronaldo-cry-at-the-world-cup',
    title: 'Will Ronaldo Cry at the World Cup?',
    subcat: '世界杯',
    markets: [
      { id: 'm-' + id, question: 'Will Ronaldo Cry at the World Cup?', outcomes: '["Yes","No"]', outcomePrices: '["0.35","0.65"]' },
    ],
  })
}

describe('P1 世界杯数据层 fetchWorldCupEvents', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('按世界杯 tag 拉全量，按 id 去重，并保留完整 markets/subcat', async () => {
    const wc = wcWinner('wc-slug')
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(String(url)).toContain('tag_slug=2026-fifa-world-cup')
      return { ok: true, json: async () => [wc, { ...wc, title: 'duplicate' }], text: async () => '' }
    }))
    const out = await fetchWorldCupEvents()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'wc-slug', category: '体育', subcat: '世界杯' })
    expect(out[0].markets).toHaveLength(3)
  })

  it('tag 拉取失败时容错返回空数组', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => [], text: async () => '' })))
    await expect(fetchWorldCupEvents()).resolves.toEqual([])
  })

  it('合并到 volume 漏斗时按 id 去重，世界杯版本优先保留多 markets', async () => {
    const volumeWc = event({
      id: 'same',
      title: '2026 FIFA World Cup Winner',
      markets: [wcMarket({ id: 'only-one', name: 'Spain', yes: '0.16' })],
    })
    const slugWc = wcWinner('same')
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.includes('offset=0')) return { ok: true, json: async () => [simpleEvent({ id: 'btc' }), volumeWc], text: async () => '' }
      if (s.includes('offset=100')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.includes('tag_slug=2026-fifa-world-cup')) return { ok: true, json: async () => [slugWc], text: async () => '' }
      return { ok: true, json: async () => [], text: async () => '' }
    }))
    const out = await fetchPolymarketEvents()
    expect(out.map((e) => e.id).sort()).toEqual(['btc', 'same'])
    expect(out.find((e) => e.id === 'same').markets).toHaveLength(3)
    expect(out.find((e) => e.id === 'same').category).toBe('体育')
    expect(out.find((e) => e.id === 'same').subcat).toBe('世界杯')
  })
})

describe('P3 NBA 数据层 fetchNbaEvents', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('按 NBA tag 拉全量，按 id 去重，并保留完整 markets/subcat', async () => {
    const nba = nbaMatch('nba-slug')
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(String(url)).toContain('tag_slug=nba')
      return { ok: true, json: async () => [nba, { ...nba, title: 'duplicate' }], text: async () => '' }
    }))
    const out = await fetchNbaEvents()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'nba-slug', category: '体育', subcat: 'NBA' })
    expect(out[0].markets).toHaveLength(3)
  })

  it('tag 拉取失败时容错返回空数组', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => [], text: async () => '' })))
    await expect(fetchNbaEvents()).resolves.toEqual([])
  })

  it('合并到 volume 漏斗时按 id 去重，NBA/世界杯 tag 完整 markets 版本优先', async () => {
    const volumeNba = event({
      id: 'same-nba',
      title: 'Spurs vs. Knicks',
      markets: [nbaMarket({ id: 'only-ml' })],
    })
    const tagNba = nbaMatch('same-nba')
    const volumeWc = event({
      id: 'same-wc',
      title: '2026 FIFA World Cup Winner',
      markets: [wcMarket({ id: 'only-one', name: 'Spain', yes: '0.16' })],
    })
    const tagWc = wcWinner('same-wc')
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.includes('offset=0')) return { ok: true, json: async () => [simpleEvent({ id: 'btc' }), volumeNba, volumeWc], text: async () => '' }
      if (s.includes('offset=100')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.includes('tag_slug=nba')) return { ok: true, json: async () => [tagNba], text: async () => '' }
      if (s.includes('tag_slug=2026-fifa-world-cup')) return { ok: true, json: async () => [tagWc], text: async () => '' }
      return { ok: true, json: async () => [], text: async () => '' }
    }))
    const out = await fetchPolymarketEvents()
    expect(out.map((e) => e.id).sort()).toEqual(['btc', 'same-nba', 'same-wc'])
    expect(out.find((e) => e.id === 'same-nba')).toMatchObject({ category: '体育', subcat: 'NBA' })
    expect(out.find((e) => e.id === 'same-nba').markets).toHaveLength(3)
    expect(out.find((e) => e.id === 'same-wc')).toMatchObject({ category: '体育', subcat: '世界杯' })
    expect(out.find((e) => e.id === 'same-wc').markets).toHaveLength(3)
  })
})

describe('P4 财经/科技数据层', () => {
  afterEach(() => vi.unstubAllGlobals())

  function topicEvents(prefix, count, baseVolume = 1000) {
    return Array.from({ length: count }, (_, i) => simpleEvent({
      id: prefix + i,
      title: 'Local neutral market ' + prefix + i,
    })).map((ev, i) => ({ ...ev, volume24hr: baseVolume - i }))
  }

  it('fetchFinanceEvents 多 tag 合并去重，按 volume24hr 降序取 top 50，并挂财经分类', async () => {
    const economy = topicEvents('e', 30, 3000)
    const stocks = topicEvents('s', 30, 2000)
    const business = topicEvents('b', 10, 1000)
    const duplicate = { ...economy[0], title: 'duplicate economy', volume24hr: 5000 }
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      expect(s).toContain('limit=100')
      if (s.includes('tag_slug=economy')) return { ok: true, json: async () => economy, text: async () => '' }
      if (s.includes('tag_slug=stocks')) return { ok: true, json: async () => [duplicate, ...stocks], text: async () => '' }
      if (s.includes('tag_slug=business')) return { ok: true, json: async () => business, text: async () => '' }
      return { ok: true, json: async () => [], text: async () => '' }
    }))
    const out = await fetchFinanceEvents()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(out).toHaveLength(50)
    expect(new Set(out.map((e) => e.id)).size).toBe(50)
    expect(out[0]).toMatchObject({ id: 'e0', title: 'duplicate economy', category: '财经' })
    expect(out.every((e) => e.category === '财经')).toBe(true)
    expect(out.map((e) => e.volume24hr)).toEqual([...out].map((e) => e.volume24hr).sort((a, b) => b - a))
  })

  it('fetchTechEvents 多 tag 合并去重，按 volume24hr 降序取 top 50，并挂科技分类', async () => {
    const tech = topicEvents('t', 20, 2500)
    const ai = topicEvents('a', 20, 2000)
    const bigTech = topicEvents('g', 20, 1500)
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.includes('tag_slug=tech')) return { ok: true, json: async () => tech, text: async () => '' }
      if (s.includes('tag_slug=ai')) return { ok: true, json: async () => [{ ...tech[0], volume24hr: 3000 }, ...ai], text: async () => '' }
      if (s.includes('tag_slug=big-tech')) return { ok: true, json: async () => bigTech, text: async () => '' }
      return { ok: true, json: async () => [], text: async () => '' }
    }))
    const out = await fetchTechEvents()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(out).toHaveLength(50)
    expect(new Set(out.map((e) => e.id)).size).toBe(50)
    expect(out[0]).toMatchObject({ id: 't0', category: '科技' })
    expect(out.every((e) => e.category === '科技')).toBe(true)
    expect(out.map((e) => e.volume24hr)).toEqual([...out].map((e) => e.volume24hr).sort((a, b) => b - a))
  })

  it('tag 拉取异常时容错返回空数组', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    await expect(fetchFinanceEvents()).resolves.toEqual([])
    await expect(fetchTechEvents()).resolves.toEqual([])
  })

  it('合并到 volume 漏斗时财经/科技专题盘并入，且 category 不被 classifyEvent 重置', async () => {
    const finance = simpleEvent({ id: 'finance-tag', title: 'Local neutral finance tag' })
    const tech = simpleEvent({ id: 'tech-tag', title: 'Local neutral tech tag' })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.includes('offset=0')) return { ok: true, json: async () => [simpleEvent({ id: 'btc' })], text: async () => '' }
      if (s.includes('offset=100')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.includes('tag_slug=economy')) return { ok: true, json: async () => [finance], text: async () => '' }
      if (s.includes('tag_slug=tech')) return { ok: true, json: async () => [tech], text: async () => '' }
      return { ok: true, json: async () => [], text: async () => '' }
    }))
    const out = await fetchPolymarketEvents()
    expect(out.find((e) => e.id === 'finance-tag')).toMatchObject({ category: '财经' })
    expect(out.find((e) => e.id === 'tech-tag')).toMatchObject({ category: '科技' })
    expect(out.find((e) => e.id === 'btc')).toMatchObject({ category: '加密' })
  })

  it('财经/科技 simple 盘不会被本地化跳过，会进入渐进重翻队列', () => {
    expect(pmCardNeedsZh({
      id: 'finance-en',
      kind: 'simple',
      subcat: '宏观经济',
      enTitle: 'US GDP above forecast?',
      zhTitle: 'US GDP above forecast?',
    })).toBe(true)
    expect(pmCardNeedsZh({
      id: 'tech-en',
      kind: 'simple',
      subcat: 'AI',
      enTitle: 'New model released?',
      zhTitle: 'New model released?',
    })).toBe(true)
  })
})

describe('P5 特朗普专题数据层 fetchTrumpEvents', () => {
  afterEach(() => vi.unstubAllGlobals())

  function trumpEvents(count, baseVolume = 7000) {
    return Array.from({ length: count }, (_, i) => simpleEvent({
      id: 'trump-' + i,
      title: 'Will Trump cut tariffs in 2026? ' + i,
    })).map((ev, i) => ({ ...ev, volume24hr: baseVolume - i }))
  }

  it('按 trump tag 拉热度 top60，并只挂特朗普 subcat', async () => {
    const events = trumpEvents(70)
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      expect(s).toContain('tag_slug=trump')
      expect(s).toContain('limit=100')
      return { ok: true, json: async () => events, text: async () => '' }
    }))
    const out = await fetchTrumpEvents()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(out).toHaveLength(60)
    expect(out[0]).toMatchObject({ id: 'trump-0', subcat: '特朗普' })
    expect(out[59]).toMatchObject({ id: 'trump-59', subcat: '特朗普' })
    expect(out.every((e) => e.subcat === '特朗普')).toBe(true)
    expect(out.every((e) => e.category == null)).toBe(true)
    expect(out.map((e) => e.volume24hr)).toEqual([...out].map((e) => e.volume24hr).sort((a, b) => b - a))
  })

  it('tag 拉取异常时容错返回空数组', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    await expect(fetchTrumpEvents()).resolves.toEqual([])
  })

  it('合并到 volume 漏斗后，特朗普 subcat 不被其他专题覆盖', async () => {
    const financeTrump = simpleEvent({ id: 'same-trump', title: 'Will Trump cut tariffs in 2026?' })
    const tagTrump = { ...financeTrump, volume24hr: 9000 }
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.includes('offset=0')) return { ok: true, json: async () => [simpleEvent({ id: 'btc' })], text: async () => '' }
      if (s.includes('offset=100')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.includes('tag_slug=economy')) return { ok: true, json: async () => [financeTrump], text: async () => '' }
      if (s.includes('tag_slug=trump')) return { ok: true, json: async () => [tagTrump], text: async () => '' }
      return { ok: true, json: async () => [], text: async () => '' }
    }))
    const out = await fetchPolymarketEvents()
    const same = out.find((e) => e.id === 'same-trump')
    expect(same).toMatchObject({ category: '财经', subcat: '特朗普' })
    expect(out.find((e) => e.id === 'btc')).toMatchObject({ category: '加密' })
  })

  it('特朗普涉台海仍被红线过滤', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.includes('offset=0')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.includes('tag_slug=trump')) {
        return {
          ok: true,
          json: async () => [simpleEvent({ id: 'tw-redline', title: 'Will Trump support China invade Taiwan?' })],
          text: async () => '',
        }
      }
      return { ok: true, json: async () => [], text: async () => '' }
    }))
    const out = await fetchPolymarketEvents()
    expect(out.find((e) => e.id === 'tw-redline')).toBeUndefined()
  })
})

describe('P1 世界杯词典 i18n-sports', () => {
  it('国家/大洲词典命中，缺失时降级原文', () => {
    expect(COUNTRY_ZH.Spain).toBe('西班牙')
    expect(translateEntityLocal('France')).toBe('法国')
    expect(translateEntityLocal('South Korea')).toBe('韩国')
    expect(translateEntityLocal('Europe')).toBe('欧洲')
    expect(translateEntityLocal('Turkiye')).toBe('土耳其')
    expect(translateEntityLocal('Türkiye')).toBe('土耳其')
    expect(translateEntityLocal('Ivory Coast')).toBe('科特迪瓦')
    expect(translateEntityLocal('Congo DR')).toBe('刚果（金）')
    expect(translateEntityLocal('Curacao')).toBe('库拉索')
    expect(translateEntityLocal('The Netherlands')).toBe('荷兰')
    expect(translateEntityLocal('Team AM')).toBe('附加赛席位')
    expect(translateEntityLocal('Other')).toBe('其他') // 榜单常见「Other」档归一
    expect(translateEntityLocal('Unknown FC')).toBe('Unknown FC')
  })

  it('世界杯球员词典命中，缺失球员和占位符降级原文', () => {
    expect(PLAYER_ZH['Lionel Messi']).toBe('梅西')
    expect(translateEntityLocal('Kylian Mbappé')).toBe('姆巴佩')
    expect(translateEntityLocal('Kylian Mbappe')).toBe('姆巴佩')
    expect(translateEntityLocal('Vinícius Júnior')).toBe('维尼修斯')
    expect(translateEntityLocal('Depay Memphis')).toBe('德佩')
    expect(translateEntityLocal('Player A')).toBe('Player A')
  })

  it('P3 NBA 队名词典命中，支持简称和全名后缀', () => {
    expect(Object.keys(TEAM_ZH)).toHaveLength(30)
    expect(TEAM_ZH.Spurs).toBe('马刺')
    expect(TEAM_ZH.Knicks).toBe('尼克斯')
    expect(TEAM_ZH['Trail Blazers']).toBe('开拓者')
    expect(translateEntityLocal('Los Angeles Lakers')).toBe('湖人')
    expect(translateEntityLocal('Portland Trail Blazers')).toBe('开拓者')
    expect(translateEntityLocal('Over')).toBe('大')
    expect(translateEntityLocal('Under')).toBe('小')
  })

  it('按标题和 slug 解析世界杯玩法中文名', () => {
    expect(playTypeZh({ slug: 'world-cup-winner', title: '2026 FIFA World Cup Winner' })).toBe('夺冠')
    expect(playTypeZh({ slug: 'world-cup-golden-boot-winner', title: 'Golden Boot Winner' })).toBe('金靴')
    expect(playTypeZh({ slug: 'world-cup-group-a-winner', title: 'World Cup Group A Winner' })).toBe('A 组头名')
    expect(playTypeZh({ slug: 'world-cup-nation-to-reach-quarterfinals', title: '' })).toBe('晋级8强')
  })

  it('解析 Loop 3 新增世界杯玩法名', () => {
    expect(playTypeZh({ slug: 'world-cup-golden-ball', title: 'Golden Ball' })).toBe('金球奖')
    expect(playTypeZh({ slug: 'world-cup-golden-glove', title: 'Golden Glove' })).toBe('金手套(最佳门将)')
    expect(playTypeZh({ slug: 'world-cup-bronze-boot', title: 'Bronze Boot' })).toBe('铜靴')
    expect(playTypeZh({ slug: 'world-cup-most-goal-contributions', title: 'Most Goal Contributions' })).toBe('进球贡献榜')
    expect(playTypeZh({ slug: 'world-cup-most-assists', title: 'Most Assists' })).toBe('助攻榜')
    expect(playTypeZh({ slug: 'furthest-advancing-caf-nation', title: 'Furthest Advancing CAF Nation' })).toBe('最远非洲球队')
    expect(playTypeZh({ slug: 'furthest-advancing-afc-nation', title: 'Furthest Advancing AFC Nation' })).toBe('最远亚洲球队')
    expect(playTypeZh({ slug: 'furthest-advancing-conmebol-nation', title: 'Furthest Advancing CONMEBOL Nation' })).toBe('最远南美球队')
    expect(playTypeZh({ slug: 'furthest-advancing-uefa-nation', title: 'Furthest Advancing UEFA Nation' })).toBe('最远欧洲球队')
    expect(playTypeZh({ slug: 'furthest-advancing-concacaf-nation', title: 'Furthest Advancing CONCACAF Nation' })).toBe('最远中北美球队')
    expect(playTypeZh({ slug: 'furthest-advancing-ofc-nation', title: 'Furthest Advancing OFC Nation' })).toBe('最远大洋洲球队')
    expect(playTypeZh({ slug: 'brazil-stage-of-elimination', title: 'Brazil Stage of Elimination' })).toBe('巴西 淘汰阶段')
    expect(playTypeZh({ slug: 'world-cup-group-c-last-place', title: 'Group C Last Place' })).toBe('C 组垫底')
    // Loop3 长尾玩法
    expect(playTypeZh({ slug: '', title: 'World Cup: Group D Second Place' })).toBe('D 组第二')
    expect(playTypeZh({ slug: '', title: 'World Cup: Worst-Placed CAF Nation' })).toBe('最差非洲球队')
    expect(playTypeZh({ slug: '', title: 'World Cup: Worst-Placed Host Nation' })).toBe('最差东道主')
    expect(playTypeZh({ slug: '', title: 'World Cup: Furthest Advancing Host Nation' })).toBe('最远东道主')
    expect(playTypeZh({ slug: '', title: 'World Cup: Most Clean Sheets (GK)' })).toBe('最多零封(门将)')
    expect(playTypeZh({ slug: '', title: 'World Cup: Group of Champion' })).toBe('冠军所在组')
    expect(playTypeZh({ slug: 'world-cup-fair-play-award', title: 'Fair Play Award' })).toBe('公平竞赛奖')
    expect(playTypeZh({ slug: 'world-cup-top-scorer-nation', title: 'Top Scorer Nation' })).toBe('最佳射手国')
  })

  it('按世界杯玩法生成中文描述模板', () => {
    expect(playTypeDescZh({ slug: 'world-cup-winner', title: '2026 FIFA World Cup Winner' })).toBe('押哪支球队夺得 2026 世界杯冠军。')
    expect(playTypeDescZh({ slug: 'world-cup-golden-boot-winner', title: 'Golden Boot Winner' })).toBe('押谁是 2026 世界杯进球最多的金靴得主。')
    expect(playTypeDescZh({ slug: 'world-cup-group-b-winner', title: 'World Cup Group B Winner' })).toBe('押 B 组谁能拿到小组头名。')
    expect(playTypeDescZh({ slug: 'world-cup-nation-to-reach-quarterfinals', title: '' })).toBe('押哪些球队能晋级到 2026 世界杯 8强。')
  })
})

describe('P1 世界杯缓存契约', () => {
  beforeEach(() => {
    resetAll()
    register({ name: '我', password: 'x', agreedTerms: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  function stubNet(pmEvents, dsArr = []) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.startsWith('/pm/events?slug=world-cup-winner')) {
        return { ok: true, json: async () => pmEvents.filter((e) => e.slug === 'world-cup-winner'), text: async () => '' }
      }
      if (s.startsWith('/pm/events?slug=')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.includes('tag_slug=')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.startsWith('/pm')) return { ok: true, json: async () => pmEvents, text: async () => '' }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(dsArr) } }] }), text: async () => '' }
    }))
  }

  it('outright 写入 kind/subcat/outright，候选中文名本地生成，并从列表透出', async () => {
    stubNet([wcWinner('wc-cache')])
    const list = await pmUpdateNow({ now: 1000 })
    const card = store.pmCache.byId['wc-cache']
    expect(card.kind).toBe('outright')
    expect(card.subcat).toBe('世界杯')
    expect(card.outright.map((r) => r.zhName)).toEqual(['西班牙', '法国', '巴西'])
    expect(card.outright.map((r) => r.marketId)).toEqual(['m-es', 'm-fr', 'm-br'])
    expect(card.zhDescription).toBe('押哪支球队夺得 2026 世界杯冠军。')
    expect(pmCardNeedsZh(card)).toBe(false)
    expect(fetch.mock.calls.filter((c) => String(c[0]).startsWith('/ds'))).toHaveLength(0)
    expect(list[0]).toMatchObject({ id: 'wc-cache', category: '体育', subcat: '世界杯', kind: 'outright' })
    expect(list[0].description).toBe('押哪支球队夺得 2026 世界杯冠军。')
    expect(list[0].outright[0]).toMatchObject({ marketId: 'm-es', name: 'Spain', zhName: '西班牙', outcomes: '["Yes","No"]' })
    expect(list[0].markets).toHaveLength(3)
  })

  it('非世界杯多候选盘回退 simple，并进入 DeepSeek 重翻队列', async () => {
    const ev = nonWorldCupOutright()
    expect(pmKindForEvent(ev)).toBe('simple')
    stubNet(
      [ev],
      [{ id: 'election', zhTitle: '美国大选赢家', zhOutcomes: ['会', '不会'], category: '政治', compliant: true }],
    )
    await pmUpdateNow({ now: 1000 })
    const cached = store.pmCache.byId.election
    expect(fetch.mock.calls.filter((c) => String(c[0]).startsWith('/ds'))).toHaveLength(1)
    expect(cached).toMatchObject({ kind: 'simple', zhTitle: '美国大选赢家' })
    expect(cached.outright).toBeUndefined()
    const card = {
      id: 'election',
      kind: 'outright',
      subcat: '政治',
      enTitle: 'Who will win the US election?',
      zhTitle: 'Who will win the US election?',
      outright: [
        { marketId: 'm-a', name: 'Candidate A', zhName: 'Candidate A' },
        { marketId: 'm-b', name: 'Candidate B', zhName: 'Candidate B' },
        { marketId: 'm-c', name: 'Candidate C', zhName: 'Candidate C' },
      ],
    }
    expect(pmCardNeedsZh(card)).toBe(true)
  })

  it('世界杯 simple 趣味盘不走本地跳过，会进入 DeepSeek 翻译队列', async () => {
    const ev = wcSimple()
    expect(pmKindForEvent(ev)).toBe('simple')
    expect(pmCardNeedsZh({
      id: 'wc-simple',
      kind: 'simple',
      subcat: '世界杯',
      enTitle: 'Will Ronaldo Cry at the World Cup?',
      zhTitle: 'Will Ronaldo Cry at the World Cup?',
    })).toBe(true)
    stubNet(
      [ev],
      [{ id: 'wc-simple', zhTitle: 'C罗会在世界杯哭吗', zhOutcomes: ['会', '不会'], category: '体育', compliant: true }],
    )
    await pmUpdateNow({ now: 1000 })
    const cached = store.pmCache.byId['wc-simple']
    expect(fetch.mock.calls.filter((c) => String(c[0]).startsWith('/ds'))).toHaveLength(1)
    expect(cached).toMatchObject({ kind: 'simple', subcat: '世界杯', zhTitle: 'C罗会在世界杯哭吗' })
  })

  it('P3 kind 判定优先级：世界杯榜单→outright，单场→match，其余→simple', () => {
    expect(pmKindForEvent(wcWinner('wc-kind'))).toBe('outright')
    expect(pmKindForEvent(nbaMatch('nba-kind'))).toBe('match')
    expect(pmKindForEvent(simpleEvent({ id: 'btc-kind' }))).toBe('simple')
  })

  it('P3 match 写入缓存并从列表透出，队名和选项本地中文化且不走翻译请求', async () => {
    stubNet([nbaMatch('nba-cache')])
    const list = await pmUpdateNow({ now: 1000 })
    const card = store.pmCache.byId['nba-cache']
    expect(card.kind).toBe('match')
    expect(card.subcat).toBe('NBA')
    expect(card.zhTitle).toBe('马刺 vs 尼克斯')
    expect(card.match.teams).toEqual(['Spurs', 'Knicks'])
    expect(card.match.moneyline.marketId).toBe('ml')
    expect(card.match.moneyline.options).toEqual([
      { name: 'Spurs', prob: 0.46, zhName: '马刺' },
      { name: 'Knicks', prob: 0.54, zhName: '尼克斯' },
    ])
    expect(card.match.spread).toMatchObject({ marketId: 'spread', line: -2.5 })
    expect(card.match.spread.options[0]).toMatchObject({ name: 'Spurs', zhName: '马刺' })
    expect(card.match.total).toMatchObject({ marketId: 'total', line: 215.5 })
    expect(card.match.total.options).toEqual([
      { name: 'Over', prob: 0.48, zhName: '大' },
      { name: 'Under', prob: 0.52, zhName: '小' },
    ])
    expect(pmCardNeedsZh(card)).toBe(false)
    expect(fetch.mock.calls.filter((c) => String(c[0]).startsWith('/ds'))).toHaveLength(0)
    expect(list[0]).toMatchObject({ id: 'nba-cache', category: '体育', subcat: 'NBA', kind: 'match' })
    expect(list[0].match.moneyline.marketId).toBe('ml')
    expect(list[0].match.total.options[0]).toMatchObject({ name: 'Over', zhName: '大' })
  })

  it('simple 旧单盘结构保持可读，只新增 kind=simple，不带 outright', async () => {
    stubNet(
      [simpleEvent({ id: 'btc' })],
      [{ id: 'btc', zhTitle: '比特币破十万', zhOutcomes: ['会', '不会'], category: '加密', compliant: true }],
    )
    await pmUpdateNow({ now: 1000 })
    const simple = pmCachedList().find((e) => e.id === 'btc')
    expect(simple).toMatchObject({ id: 'btc', title: '比特币破十万', kind: 'simple', category: '加密' })
    expect(simple.outright).toBeUndefined()
    expect(simple.markets).toHaveLength(1)
  })
})

describe('P1 押注 marketId 独立结算守恒', () => {
  beforeEach(() => {
    resetAll()
    register({ name: '我', password: 'x', agreedTerms: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('同一 event 下不同候选按各自 marketId 查结果，互不串台', async () => {
    const start = store.balance
    const spain = placePmBet({
      eventId: 'wc-event',
      marketId: 'm-es',
      eventTitle: '夺冠',
      marketQuestion: 'Spain',
      outcome: 'Yes',
      prob: 0.25,
      stake: 10000,
      zhOutcome: '会',
    })
    const france = placePmBet({
      eventId: 'wc-event',
      marketId: 'm-fr',
      eventTitle: '夺冠',
      marketQuestion: 'France',
      outcome: 'Yes',
      prob: 0.5,
      stake: 10000,
      zhOutcome: '会',
    })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      expect(s.startsWith('/pm/markets?id=')).toBe(true)
      const id = decodeURIComponent(s.match(/[?&]id=([^&]+)/)[1])
      const prices = id === 'm-es' ? ['1', '0'] : ['0', '1']
      return { ok: true, json: async () => ({ id, closed: true, outcomes: '["Yes","No"]', outcomePrices: JSON.stringify(prices) }), text: async () => '' }
    }))
    const settled = await autoSettlePendingBets()
    expect(settled).toBe(2)
    expect(spain.status).toBe('won')
    expect(spain.payout).toBe(40000)
    expect(france.status).toBe('lost')
    expect(france.payout).toBe(0)
    expect(store.balance).toBe(start - 20000 + 40000)
    expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual(['/pm/markets?id=m-fr', '/pm/markets?id=m-es'])
  })

  it('P3 同一 match 下 moneyline/spread/total 各绑各的 marketId 独立结算', async () => {
    const start = store.balance
    const moneyline = placePmBet({
      eventId: 'nba-event',
      marketId: 'ml',
      eventTitle: '马刺 vs 尼克斯',
      marketQuestion: '胜负线',
      outcome: 'Spurs',
      prob: 0.5,
      stake: 10000,
      zhOutcome: '马刺',
    })
    const spread = placePmBet({
      eventId: 'nba-event',
      marketId: 'spread',
      eventTitle: '马刺 vs 尼克斯',
      marketQuestion: '让分 -2.5',
      outcome: 'Spurs',
      prob: 0.5,
      stake: 10000,
      zhOutcome: '马刺',
    })
    const total = placePmBet({
      eventId: 'nba-event',
      marketId: 'total',
      eventTitle: '马刺 vs 尼克斯',
      marketQuestion: '大小分 215.5',
      outcome: 'Over',
      prob: 0.5,
      stake: 10000,
      zhOutcome: '大',
    })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      expect(s.startsWith('/pm/markets?id=')).toBe(true)
      const id = decodeURIComponent(s.match(/[?&]id=([^&]+)/)[1])
      const byId = {
        ml: { outcomes: ['Spurs', 'Knicks'], prices: ['1', '0'] },
        spread: { outcomes: ['Spurs', 'Knicks'], prices: ['0', '1'] },
        total: { outcomes: ['Over', 'Under'], prices: ['1', '0'] },
      }
      const r = byId[id]
      return {
        ok: true,
        json: async () => ({ id, closed: true, outcomes: JSON.stringify(r.outcomes), outcomePrices: JSON.stringify(r.prices) }),
        text: async () => '',
      }
    }))
    const settled = await autoSettlePendingBets()
    expect(settled).toBe(3)
    expect(moneyline.status).toBe('won')
    expect(spread.status).toBe('lost')
    expect(total.status).toBe('won')
    expect(moneyline.payout).toBe(20000)
    expect(spread.payout).toBe(0)
    expect(total.payout).toBe(20000)
    expect(store.balance).toBe(start - 30000 + 40000)
    expect(fetch.mock.calls.map((c) => String(c[0])).sort()).toEqual(['/pm/markets?id=ml', '/pm/markets?id=spread', '/pm/markets?id=total'])
  })
})
