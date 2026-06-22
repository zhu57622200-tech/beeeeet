import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  classifyEvent,
  classifySubcat,
  SUBCAT_MAP,
  funnelEvents,
  enrichEventsWithDS,
  isSensitiveEvent,
  isPoliticalMilitaryEvent,
  fetchPolymarketEvents,
  isChinaRelated,
} from '../src/api.js'
import {
  store,
  resetAll,
  register,
  refreshPmIfStale,
  pmUpdateNow,
  retranslateUntranslated,
  retranslateAllUntranslated,
  _setRetranslatePauseForTest,
  pmCachedList,
  pmCardNeedsZh,
} from '../src/store.js'

// 循环重翻轮间停顿设 0：测试不真等限流恢复（防拖慢/挂起）。
beforeEach(() => _setRetranslatePauseForTest(0))

// 本地 CJK 检测正则（与 store.js 内部 HAS_CJK 同口径），断言某缓存包是否已中文化。
const HAS_CJK_TEST = /[一-龥]/

// 造一个 Polymarket 风格 event。outcomes/prices 是 JSON 字符串（与真实 API 一致）。
function ev({ id = 'e1', title = '', volume = 1000, outcomes = ['Yes', 'No'], prices = ['0.5', '0.5'], createdAt } = {}) {
  return {
    id,
    title,
    volume24hr: volume,
    createdAt: createdAt || '2026-06-01T00:00:00Z',
    tags: [],
    markets: [
      { question: title, outcomes: JSON.stringify(outcomes), outcomePrices: JSON.stringify(prices) },
    ],
  }
}

describe('S15 漏斗 classifyEvent：白名单分类', () => {
  it('体育只放 NBA/世界杯/足球/网球', () => {
    expect(classifyEvent(ev({ title: 'Will the Lakers win the NBA finals?' }))).toBe('体育')
    expect(classifyEvent(ev({ title: '世界杯冠军是谁' }))).toBe('体育')
    expect(classifyEvent(ev({ title: 'tennis grand slam winner' }))).toBe('体育')
  })
  it('其他体育（棒球/F1/NFL 等）不归"体育"白名单 → 落"其他"（反向模式仍进盘）', () => {
    expect(classifyEvent(ev({ title: 'Who wins the baseball MLB title?' }))).toBe('其他')
    expect(classifyEvent(ev({ title: 'F1 grand prix champion 2026' }))).toBe('其他')
    // 北美 'football'=NFL 美式橄榄球，不归体育（去掉裸 football 后落"其他"）。
    expect(classifyEvent(ev({ title: 'Who wins the NFL Super Bowl football game?' }))).toBe('其他')
  })
  it('足球用 soccer/联赛专指词命中体育（不靠裸 football）', () => {
    expect(classifyEvent(ev({ title: 'Premier League title winner' }))).toBe('体育')
    expect(classifyEvent(ev({ title: 'soccer world champion' }))).toBe('体育')
  })
  it("科技 'ai' 整词命中，但 retail/detail/haiti 等子串不误伤", () => {
    expect(classifyEvent(ev({ title: 'Will OpenAI ship new AI model?' }))).toBe('科技')
    // 'retail sales' / 'project detail' 含 'ai' 子串，但不应误归科技（反向模式落"其他"）。
    expect(classifyEvent(ev({ title: 'US retail sales beat forecast' }))).not.toBe('科技')
    expect(classifyEvent(ev({ title: 'Will the project detail be released?' }))).not.toBe('科技')
  })
  it('加密 / 财经 / 科技 / 文化 / 国际 各归位', () => {
    expect(classifyEvent(ev({ title: 'Bitcoin above 100k?' }))).toBe('加密')
    expect(classifyEvent(ev({ title: 'US GDP growth 2026' }))).toBe('财经')
    expect(classifyEvent(ev({ title: 'Will Apple ship a new AI chip?' }))).toBe('科技')
    expect(classifyEvent(ev({ title: 'Oscar best picture winner' }))).toBe('文化')
    expect(classifyEvent(ev({ title: 'Iran nuclear deal agreement' }))).toBe('国际')
  })
  it('不匹配任何具体分类 → "其他"（反向模式不剔除，进盘可被分类栏筛）', () => {
    expect(classifyEvent(ev({ title: 'Some random local zoning vote' }))).toBe('其他')
  })
})

describe('P2 二级分类 classifySubcat', () => {
  it('SUBCAT_MAP 结构和顺序稳定', () => {
    expect(SUBCAT_MAP).toEqual({
      体育: ['世界杯', 'NBA', '足球', '网球', '棒球', '冰球', '电竞', '其他体育'],
      加密: ['比特币', '以太坊', '其他币'],
      财经: ['股市', '宏观经济', '其他财经'],
      科技: ['AI', '科技公司', '其他科技'],
      文化: ['影视', '音乐', '其他文化'],
      国际: [],
      其他: [],
    })
  })

  it('体育二级分类命中，世界杯 subcat 保持不被覆盖', () => {
    expect(classifySubcat(ev({ title: 'Lakers win the NBA finals?' }))).toBe('NBA')
    expect(classifySubcat(ev({ title: 'Premier League title winner' }))).toBe('足球')
    expect(classifySubcat(ev({ title: 'ATP tennis grand slam winner' }))).toBe('网球')
    expect(classifySubcat({ ...ev({ title: 'MLB baseball champion' }), category: '体育' })).toBe('棒球')
    expect(classifySubcat({ ...ev({ title: 'NHL Stanley Cup winner' }), category: '体育' })).toBe('冰球')
    expect(classifySubcat({ ...ev({ title: 'LoL esports world final' }), category: '体育' })).toBe('电竞')
    expect(classifySubcat({ ...ev({ title: 'Marathon winner' }), category: '体育' })).toBe('其他体育')
    expect(classifySubcat({ ...ev({ title: 'FIFA soccer winner' }), subcat: '世界杯' })).toBe('世界杯')
    expect(classifySubcat({ ...ev({ title: 'Trump tariffs and GDP?' }), subcat: '特朗普' })).toBe('特朗普')
  })

  it('加密/财经/科技/文化二级分类命中，国际和其他不细分', () => {
    expect(classifySubcat(ev({ title: 'Bitcoin above 100k?' }))).toBe('比特币')
    expect(classifySubcat(ev({ title: 'Ethereum ETF approved?' }))).toBe('以太坊')
    expect(classifySubcat(ev({ title: 'Crypto market cap above 5T?' }))).toBe('其他币')
    expect(classifySubcat(ev({ title: 'NASDAQ stock index all-time high?' }))).toBe('股市')
    expect(classifySubcat(ev({ title: 'US GDP inflation and Fed interest rate?' }))).toBe('宏观经济')
    expect(classifySubcat(ev({ title: 'Oil price above 100?' }))).toBe('其他财经')
    expect(classifySubcat(ev({ title: 'OpenAI GPT model released?' }))).toBe('AI')
    expect(classifySubcat(ev({ title: 'Apple iPhone sales beat Tesla?' }))).toBe('科技公司')
    expect(classifySubcat(ev({ title: 'New chip benchmark released?' }))).toBe('其他科技')
    expect(classifySubcat(ev({ title: 'Oscar box office movie record?' }))).toBe('影视')
    expect(classifySubcat(ev({ title: 'Grammy album winner?' }))).toBe('音乐')
    expect(classifySubcat(ev({ title: 'Award show host announced?' }))).toBe('其他文化')
    expect(classifySubcat(ev({ title: 'Iran diplomatic agreement?' }))).toBe('')
    expect(classifySubcat(ev({ title: 'Some random local zoning vote' }))).toBe('')
  })
})

describe('S15-C 全放开 isSensitiveEvent：政治军事伊朗放行，性犯罪底线仍拦', () => {
  it('全放开：政治军事盘（选举/开战/乌克兰战事/伊朗军事）放行（台海除外，独立挡）', () => {
    expect(isSensitiveEvent(ev({ title: 'Presidential election winner 2028?' }))).toBe(false)
    expect(isSensitiveEvent(ev({ title: 'Will Russia and Ukraine war end in 2026?' }))).toBe(false)
    expect(isSensitiveEvent(ev({ title: 'Will Iran go to war this year?' }))).toBe(false)
    expect(isSensitiveEvent(ev({ title: 'Strait of Hormuz blockade by Iran?' }))).toBe(false)
  })
  it('性犯罪底线：epstein/weinstein/pedophile/sex crime 全放开仍拦死', () => {
    expect(isSensitiveEvent(ev({ title: 'Will the Epstein list be released?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'Weinstein appeal verdict?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'pedophile ring trial outcome?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'sexual assault case verdict?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'sex offender registry change?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'new sex crime law passed?' }))).toBe(true)
  })
  it('性犯罪底线 cc-check 补全词：rape/molest/trafficking/child abuse 拦，grape/therapist 不误伤', () => {
    expect(isSensitiveEvent(ev({ title: 'statutory rape case verdict?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'molestation charges filed?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'sex trafficking ring busted?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'child abuse scandal verdict?' }))).toBe(true)
    // 词边界防误伤：grape(葡萄)/therapist(治疗师) 不该被 rape/rapist 误伤
    expect(isSensitiveEvent(ev({ title: 'California grape harvest forecast?' }))).toBe(false)
    expect(isSensitiveEvent(ev({ title: 'Will therapist shortage worsen?' }))).toBe(false)
  })
  it('台海红线：侵台/武统/cross-strait/中国侵台湾 全放开下仍拦死(国内最高红线,独立开关)', () => {
    expect(isSensitiveEvent(ev({ title: 'Will China invade Taiwan by end of 2026?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: '中国会在2026年底前侵台湾吗？' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'China Taiwan reunification by force?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'Cross-strait conflict in 2026?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: '台海开战可能性?' }))).toBe(true)
    // 中性台湾盘(半导体/经济,无军事主权词)放行
    expect(isSensitiveEvent(ev({ title: 'TSMC Taiwan chip output 2026?' }))).toBe(false)
    expect(isSensitiveEvent(ev({ title: 'Taiwan GDP growth above 3%?' }))).toBe(false)
  })
  it('习近平红线：全放开下仍拦死(领导人,爹地2026-06-08)；jinping不误伤xian/taxi', () => {
    expect(isSensitiveEvent(ev({ title: 'Will Xi Jinping step down by 2027?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: '习近平连任?' }))).toBe(true)
    expect(isSensitiveEvent(ev({ title: 'China general secretary change?' }))).toBe(true)
    // 不误伤 xi'an(西安)/taxi
    expect(isSensitiveEvent(ev({ title: "Xi'an tourism rebound 2026?" }))).toBe(false)
    expect(isSensitiveEvent(ev({ title: 'Will taxi fares rise in NYC?' }))).toBe(false)
  })
  it('中国相关加权 isChinaRelated：中性中国题材识别(排序加权),非中国不识别', () => {
    expect(isChinaRelated(ev({ title: 'China GDP growth 2026?' }))).toBe(true)
    expect(isChinaRelated(ev({ title: 'Alibaba stock above 100?' }))).toBe(true)
    expect(isChinaRelated(ev({ title: '人民币汇率破7?' }))).toBe(true)
    expect(isChinaRelated(ev({ title: 'US inflation 2026?' }))).toBe(false)
  })
  it("中性盘（BTC）放行", () => {
    expect(isSensitiveEvent(ev({ title: 'Bitcoin above 100k?' }))).toBe(false)
  })
  it('全放开：NBA Champion(含Warriors) 放行（词边界真验证见回退模式测试）', () => {
    expect(isSensitiveEvent(ev({ title: '2026 NBA Champion (Warriors favored)?' }))).toBe(false)
  })
})

// 开关 false 一键回退：原政治军事过滤逻辑完整保留，由 isPoliticalMilitaryEvent 暴露验证。
describe('S15-C 回退（ALLOW_POLITICAL_MILITARY=false）原政治军事过滤完整', () => {
  it('伊朗中性盘（核协议/油价/和谈）放行', () => {
    expect(isPoliticalMilitaryEvent(ev({ title: 'Iran nuclear deal reached in 2026?' }))).toBe(false)
    expect(isPoliticalMilitaryEvent(ev({ title: 'Will Iran oil price stay above 80?' }))).toBe(false)
    expect(isPoliticalMilitaryEvent(ev({ title: 'Iran and US reach diplomatic agreement?' }))).toBe(false)
  })
  it('伊朗军事盘（开战/封锁/霍尔木兹/军事打击）被关键词组合拦', () => {
    expect(isPoliticalMilitaryEvent(ev({ title: 'Will Iran go to war this year?' }))).toBe(true)
    expect(isPoliticalMilitaryEvent(ev({ title: 'Strait of Hormuz blockade by Iran?' }))).toBe(true)
    expect(isPoliticalMilitaryEvent(ev({ title: 'Iran military strike on tankers?' }))).toBe(true)
    expect(isPoliticalMilitaryEvent(ev({ title: '伊朗会封锁霍尔木兹海峡吗' }))).toBe(true)
  })
  it('政治盘（选举/政要下台）被关键词拦', () => {
    expect(isPoliticalMilitaryEvent(ev({ title: 'Presidential election winner 2028?' }))).toBe(true)
    expect(isPoliticalMilitaryEvent(ev({ title: 'Will China invade Taiwan?' }))).toBe(true)
  })
  it("' war ' 词边界：回退模式下 Warriors 仍不误伤", () => {
    expect(isPoliticalMilitaryEvent(ev({ title: '2026 NBA Champion (Warriors favored)?' }))).toBe(false)
  })
  it('回退模式子串边界(cc-check)：China player/Iran forward/Office annex 不误伤', () => {
    expect(isPoliticalMilitaryEvent(ev({ title: 'China player props for NBA?' }))).toBe(false)
    expect(isPoliticalMilitaryEvent(ev({ title: 'Iran forward oil guidance?' }))).toBe(false)
    expect(isPoliticalMilitaryEvent(ev({ title: 'Office annexure construction?' }))).toBe(false)
  })
})

describe('S15-C 漏斗 funnelEvents：全放开（政治军事进，性犯罪+死盘剔）+ top200', () => {
  it('全放开：政治军事盘进，性犯罪剔，死盘剔，中性放行', () => {
    const input = [
      ev({ id: 'keep', title: 'Bitcoin above 100k in 2026?' }), // 加密中性 → 留
      ev({ id: 'random', title: 'Local school board vote' }), // 非白名单中性 → 放行（归"其他"）
      ev({ id: 'mil', title: 'Presidential election winner 2028?' }), // 政治(选举) → 全放开放行
      ev({ id: 'tw', title: 'Will China invade Taiwan?' }), // 台海红线 → 独立挡剔
      ev({ id: 'elec', title: 'Ukraine war ends in 2026?' }), // 战事 → 全放开放行
      ev({ id: 'sex', title: 'Epstein list released?' }), // 性犯罪底线 → 剔
      ev({ id: 'dead', title: 'Bitcoin above 100k?', prices: ['0.995', '0.005'] }), // 死盘(>0.99) → 剔
    ]
    const out = funnelEvents(input)
    const ids = out.map((e) => e.id)
    expect(ids).toContain('keep')
    expect(ids).toContain('random')
    expect(out.find((e) => e.id === 'random').category).toBe('其他')
    expect(ids).toContain('mil') // 全放开：政治(选举)进
    expect(ids).not.toContain('tw') // 台海红线：独立挡剔
    expect(ids).toContain('elec') // 全放开：战事进
    expect(ids).not.toContain('sex') // 性犯罪底线仍剔
    expect(ids).not.toContain('dead') // 死盘仍剔
  })

  it('死盘阈值 0.99/0.01：0.97/0.03 不再算死盘（救 BTC到价类极端盘）', () => {
    const out = funnelEvents([ev({ id: 'btc150', title: 'Bitcoin hit 150k?', prices: ['0.97', '0.03'] })])
    expect(out.map((e) => e.id)).toContain('btc150') // 0.97 < 0.99 阈值 → 不算死盘，进盘
  })

  it("' war ' 词边界：NBA Champion(Warriors) 不被误剔", () => {
    const out = funnelEvents([ev({ id: 'nba', title: '2026 NBA Champion Warriors?' })])
    expect(out.map((e) => e.id)).toContain('nba')
  })

  it('挂上中文分类 category 字段', () => {
    const out = funnelEvents([ev({ id: 'btc', title: 'Bitcoin above 100k?' })])
    expect(out[0].category).toBe('加密')
  })

  it('top 200 截断', () => {
    const many = Array.from({ length: 260 }, (_, i) => ev({ id: 'b' + i, title: 'Bitcoin price band ' + i }))
    expect(funnelEvents(many).length).toBe(200)
  })
})

describe('S15-C 分页拉取 fetchPolymarketEvents：offset 0~400 合并多页', () => {
  afterEach(() => vi.unstubAllGlobals())

  function pageOf(n, prefix) {
    return Array.from({ length: n }, (_, i) => ev({ id: prefix + i, title: 'Bitcoin band ' + prefix + i }))
  }

  it('满页(100)继续翻，合并多页直到不足整页', async () => {
    // offset 0/100 各回满 100 条，offset 200 回 50 条(不足整页)→停。共 250 条进漏斗。
    const fetchMock = vi.fn(async (url) => {
      if (!String(url).includes('offset=')) return { ok: true, json: async () => [], text: async () => '' }
      const m = String(url).match(/offset=(\d+)/)
      const offset = m ? Number(m[1]) : 0
      let data = []
      if (offset === 0) data = pageOf(100, 'p0_')
      else if (offset === 100) data = pageOf(100, 'p1_')
      else if (offset === 200) data = pageOf(50, 'p2_')
      return { ok: true, json: async () => data, text: async () => '' }
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchPolymarketEvents()
    // 漏斗 top200 截断，但合并发生在截断前：验证发了 3 次请求(0/100/200)且 p1/p2 也进。
    const offsets = fetchMock.mock.calls
      .map((c) => String(c[0]).match(/offset=(\d+)/))
      .filter(Boolean)
      .map((m) => Number(m[1]))
    expect(offsets).toEqual([0, 100, 200])
    expect(out.length).toBe(200) // 250 → top200
    expect(out.some((e) => e.id.startsWith('p1_'))).toBe(true) // 第二页确实合并进来
  })

  it('某页返回空数组 → break 停止翻页', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (!String(url).includes('offset=')) return { ok: true, json: async () => [], text: async () => '' }
      const offset = Number(String(url).match(/offset=(\d+)/)[1])
      const data = offset === 0 ? pageOf(100, 'q') : []
      return { ok: true, json: async () => data, text: async () => '' }
    })
    vi.stubGlobal('fetch', fetchMock)
    await fetchPolymarketEvents()
    const offsets = fetchMock.mock.calls
      .map((c) => String(c[0]).match(/offset=(\d+)/))
      .filter(Boolean)
      .map((m) => Number(m[1]))
    expect(offsets).toEqual([0, 100]) // 第二页空 → 停，不再翻 200
  })

  it('首页就失败 → 抛错（来源隐藏，不暴露平台名）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, text: async () => '' })))
    await expect(fetchPolymarketEvents()).rejects.toThrow('系统盘加载失败')
  })
})

// ---- DeepSeek enrich：mock fetch（不真调网络）----
function mockDsReturn(arrJson) {
  // dsChat 走 fetch('/ds/...')，返回 OpenAI 风格 choices[0].message.content。
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(arrJson) } }] }),
    text: async () => '',
  }))
}

describe('S15 DeepSeek enrichEventsWithDS（mock）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('翻译 + 分类：全放开下 compliant=!isSensitiveEvent（政治军事均 true，不再以 DS 判 false）', async () => {
    const input = [
      ev({ id: 'a', title: 'Iran nuclear deal reached?' }),
      ev({ id: 'b', title: 'Strait of Hormuz blockade?' }),
    ]
    vi.stubGlobal(
      'fetch',
      mockDsReturn([
        { id: 'a', zhTitle: '伊朗核协议会达成吗', zhOutcomes: ['会', '不会'], category: '国际', compliant: true },
        // 即使 DeepSeek 误判 false，全放开下仍以 !isSensitiveEvent 为准 → 军事封锁放行。
        { id: 'b', zhTitle: '霍尔木兹海峡会被封锁吗', zhOutcomes: ['会', '不会'], category: '国际', compliant: false },
      ]),
    )
    const out = await enrichEventsWithDS(input)
    const a = out.find((x) => x.id === 'a')
    const b = out.find((x) => x.id === 'b')
    expect(a).toMatchObject({ zhTitle: '伊朗核协议会达成吗', category: '国际', compliant: true })
    expect(a.zhOutcomes).toEqual(['会', '不会'])
    expect(b.compliant).toBe(true) // 全放开：军事封锁不再判 false（漏斗只挡性犯罪）
  })

  it('全放开：性犯罪盘 compliant=false（!isSensitiveEvent 仍挡性犯罪底线）', async () => {
    vi.stubGlobal(
      'fetch',
      mockDsReturn([{ id: 's', zhTitle: 'epstein 名单', zhOutcomes: ['会'], category: '其他', compliant: true }]),
    )
    const out = await enrichEventsWithDS([ev({ id: 's', title: 'Epstein list released?' })])
    expect(out[0].compliant).toBe(false) // 性犯罪底线：即便 DS 判 true 也 false
  })

  it('DeepSeek 失败 → 整批降级：英文 title + 关键词分类 + compliant 信任初筛层（中性盘放行）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'err' })))
    const out = await enrichEventsWithDS([ev({ id: 'c', title: 'Bitcoin above 100k?' })])
    expect(out[0]).toMatchObject({ id: 'c', zhTitle: 'Bitcoin above 100k?', category: '加密', compliant: true })
  })

  it('降级时全放开军事盘 compliant:true（政治军事放行），性犯罪盘 false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'err' })))
    const out = await enrichEventsWithDS([
      ev({ id: 'm', title: 'Will the war escalate with an invasion?' }),
      ev({ id: 'sx', title: 'Weinstein verdict?' }),
    ])
    expect(out.find((x) => x.id === 'm').compliant).toBe(true) // 军事盘全放开放行
    expect(out.find((x) => x.id === 'sx').compliant).toBe(false) // 性犯罪底线降级也拦
  })

  it('某条没对上返回 → 该条降级（信任初筛层，中性盘放行）', async () => {
    vi.stubGlobal('fetch', mockDsReturn([{ id: 'a', zhTitle: '比特币破十万', zhOutcomes: ['会'], category: '加密', compliant: true }]))
    const out = await enrichEventsWithDS([
      ev({ id: 'a', title: 'Bitcoin above 100k?' }),
      ev({ id: 'z', title: 'Bitcoin above 200k?' }),
    ])
    expect(out.find((x) => x.id === 'a').compliant).toBe(true)
    expect(out.find((x) => x.id === 'z').compliant).toBe(true) // 没对上 → 降级，中性盘信任初筛放行
  })

  it('翻译扩展：description + 各 market question → 中文，按序对齐', async () => {
    const input = [
      {
        id: 'd',
        title: 'Will Bitcoin hit 100k?',
        description: 'This market resolves based on the spot price.',
        volume24hr: 1000,
        tags: [],
        markets: [
          { question: 'Will BTC reach 100k?', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' },
          { question: 'Will BTC reach 200k?', outcomes: '["Yes","No"]', outcomePrices: '["0.3","0.7"]' },
        ],
      },
    ]
    vi.stubGlobal(
      'fetch',
      mockDsReturn([
        {
          id: 'd',
          zhTitle: '比特币会破十万吗',
          zhDescription: '本盘以现货价格结算。',
          zhQuestions: ['BTC 会到 10 万吗', 'BTC 会到 20 万吗'],
          zhOutcomes: ['会', '不会'],
          category: '加密',
          compliant: true,
        },
      ]),
    )
    const out = await enrichEventsWithDS(input)
    expect(out[0].zhDescription).toBe('本盘以现货价格结算。')
    expect(out[0].zhQuestions).toEqual(['BTC 会到 10 万吗', 'BTC 会到 20 万吗'])
  })

  it('zhQuestions 长度不对齐 → 降级回英文 question（防错位）', async () => {
    const input = [ev({ id: 'q', title: 'Bitcoin?' })] // 单 market
    vi.stubGlobal(
      'fetch',
      mockDsReturn([{ id: 'q', zhTitle: '比特币', zhQuestions: ['多了一项', '错位项'], zhOutcomes: ['会', '不会'], category: '加密', compliant: true }]),
    )
    const out = await enrichEventsWithDS(input)
    expect(out[0].zhQuestions).toEqual(['Bitcoin?']) // 长度不符 → 降级英文
  })

  it('全放开下 DS 的 compliant 字段被忽略，以 !isSensitiveEvent 为准', async () => {
    // DS 给个奇怪值（字符串/false 都行），中性 BTC 盘最终仍 true。
    vi.stubGlobal('fetch', mockDsReturn([{ id: 'a', zhTitle: '比特币', zhOutcomes: [], category: '加密', compliant: 'whatever' }]))
    const out = await enrichEventsWithDS([ev({ id: 'a', title: 'Bitcoin?' })])
    expect(out[0].compliant).toBe(true)
  })
})

// ---- 缓存层：refreshPmIfStale 增量 / 24h / compliant 过滤 ----
describe('S15 缓存层 refreshPmIfStale', () => {
  beforeEach(() => {
    resetAll()
    register({ name: '我', password: 'x', agreedTerms: true })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // mock：fetchPolymarketEvents 的 /pm 拉取 + enrich 的 /ds，按 url 分流。
  function stubNet({ pmEvents, dsArr }) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.includes('tag_slug=')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.startsWith('/pm')) {
        return { ok: true, json: async () => pmEvents, text: async () => '' }
      }
      // /ds
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(dsArr) } }] }), text: async () => '' }
    }))
  }

  it('空缓存首拉：enrich 新盘，性犯罪盘被漏斗挡在 enrich 之前（全放开底线）', async () => {
    // b 用性犯罪盘（epstein）：fetchPolymarketEvents 的 funnelEvents 用 isSensitiveEvent
    // 直接挡掉 → 根本不进 enrich、不进缓存。验证性犯罪底线在漏斗层即生效。
    stubNet({
      pmEvents: [
        ev({ id: 'a', title: 'Bitcoin above 100k?' }),
        ev({ id: 'b', title: 'Epstein list released?' }),
      ],
      dsArr: [
        { id: 'a', zhTitle: '比特币破十万', zhOutcomes: ['会', '不会'], category: '加密', compliant: true },
      ],
    })
    const list = await pmUpdateNow({ now: 1000 })
    expect(list.map((e) => e.id)).toEqual(['a']) // b 性犯罪被漏斗挡，不进列表
    expect(list[0].title).toBe('比特币破十万') // 中文标题
    expect(list[0].category).toBe('加密')
    expect(list[0].subcat).toBe('比特币') // P2 非世界杯盘缓存透出二级分类
    expect(store.pmCache.fetchedAt).toBe(1000)
    expect(store.pmCache.byId.a.compliant).toBe(true)
    expect(store.pmCache.byId.a.subcat).toBe('比特币')
    expect(store.pmCache.byId.b).toBeUndefined() // 性犯罪盘没进缓存
  })

  it('翻译扩展：中文 description + 主盘 zhQuestion 写入缓存并经 list 透出', async () => {
    const evD = {
      id: 'a', title: 'Bitcoin above 100k?',
      description: 'Resolves by spot price.',
      volume24hr: 1000, tags: [],
      markets: [{ question: 'Will BTC top 100k?', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' }],
    }
    stubNet({
      pmEvents: [evD],
      dsArr: [{
        id: 'a', zhTitle: '比特币破十万', zhDescription: '以现货价结算。',
        zhQuestions: ['BTC 会破十万吗'], zhOutcomes: ['会', '不会'], category: '加密', compliant: true,
      }],
    })
    const list = await pmUpdateNow({ now: 1000 })
    expect(list[0].description).toBe('以现货价结算。') // 中文事件描述透出
    expect(list[0].markets[0].zhQuestion).toBe('BTC 会破十万吗') // 主盘中文问题透出
    expect(store.pmCache.byId.a.zhDescription).toBe('以现货价结算。')
    expect(store.pmCache.byId.a.market.zhQuestion).toBe('BTC 会破十万吗')
  })

  it('未过期（<24h）读缓存，不再调 enrich', async () => {
    stubNet({
      pmEvents: [ev({ id: 'a', title: 'Bitcoin above 100k?' })],
      dsArr: [{ id: 'a', zhTitle: '比特币破十万', zhOutcomes: ['会', '不会'], category: '加密', compliant: true }],
    })
    await pmUpdateNow({ now: 1000 })
    const calls1 = fetch.mock.calls.length
    // 第二次：未到刷新点（同日），前端入口直接读缓存，不再发任何请求。
    const list = await refreshPmIfStale({ now: 1000 + 60_000 })
    expect(fetch.mock.calls.length).toBe(calls1) // 未新增请求
    expect(list.map((e) => e.id)).toEqual(['a'])
  })

  it('增量：只对缓存里没有的新盘 enrich', async () => {
    // 首拉只有 a。
    stubNet({
      pmEvents: [ev({ id: 'a', title: 'Bitcoin above 100k?' })],
      dsArr: [{ id: 'a', zhTitle: '比特币A', zhOutcomes: ['会'], category: '加密', compliant: true }],
    })
    await pmUpdateNow({ now: 1000 })
    // 24h 后重拉：a 已在缓存（应跳过 enrich），新增 c。dsArr 只回 c。
    const dsForC = [{ id: 'c', zhTitle: '比特币C', zhOutcomes: ['会'], category: '加密', compliant: true }]
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.includes('tag_slug=')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.startsWith('/pm')) {
        return { ok: true, json: async () => [ev({ id: 'a', title: 'Bitcoin above 100k?' }), ev({ id: 'c', title: 'Bitcoin above 300k?' })], text: async () => '' }
      }
      // 断言：enrich 的请求体里只含新盘 c，不含 a。
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(dsForC) } }] }), text: async () => '' }
    }))
    const later = 1000 + 25 * 60 * 60 * 1000
    const list = await pmUpdateNow({ now: later })
    // 找到那次 /ds 调用，验证 body 只含 c。
    const dsCall = fetch.mock.calls.find((c) => String(c[0]).startsWith('/ds'))
    expect(dsCall).toBeTruthy()
    // body 是 JSON.stringify(整体)，内层盘口 JSON 被转义，故匹配转义形态。
    expect(dsCall[1].body).toContain('\\"id\\":\\"c\\"')
    expect(dsCall[1].body).not.toContain('\\"id\\":\\"a\\"')
    // 两盘都合规，列表含 a（读旧缓存）与 c（新 enrich）。
    expect(list.map((e) => e.id).sort()).toEqual(['a', 'c'])
    expect(list.find((e) => e.id === 'a').title).toBe('比特币A') // a 仍用旧缓存中文
  })

  it('新 dsFresh 盘先英文降级写入 byId，再等待渐进重翻', async () => {
    let resolveDs
    const dsPromise = new Promise((resolve) => { resolveDs = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.includes('tag_slug=')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.startsWith('/pm')) {
        return {
          ok: true,
          json: async () => [ev({ id: 'finance-now', title: 'US GDP above forecast?', outcomes: ['Yes', 'No'] })],
          text: async () => '',
        }
      }
      return dsPromise
    }))

    const updating = pmUpdateNow({ now: 1000 })
    for (let i = 0; i < 50 && !store.pmCache.byId['finance-now']; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const card = store.pmCache.byId['finance-now']
    expect(card).toBeTruthy()
    expect(card.zhTitle).toBe('')
    expect(card.zhOutcomes).toEqual(['Yes', 'No'])
    expect(card.market.outcomes).toBe('["Yes","No"]')
    expect(card.compliant).toBe(true)
    expect(pmCardNeedsZh(card)).toBe(true)
    expect(pmCachedList().find((e) => e.id === 'finance-now').title).toBe('US GDP above forecast?')

    resolveDs({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify([{ id: 'finance-now', zhTitle: '美国 GDP 超预期', zhOutcomes: ['会', '不会'], category: '财经', compliant: true }]) } }],
      }),
      text: async () => '',
    })
    const list = await updating
    expect(list.find((e) => e.id === 'finance-now').title).toBe('美国 GDP 超预期')
  })

  it('pmCachedList 只返合规盘且带中文（性犯罪盘被滤）', async () => {
    stubNet({
      pmEvents: [ev({ id: 'a', title: 'Bitcoin?' }), ev({ id: 'b', title: 'Weinstein verdict?' })],
      dsArr: [
        { id: 'a', zhTitle: '比特币', zhOutcomes: ['会'], category: '加密', compliant: true },
        { id: 'b', zhTitle: 'weinstein 判决', zhOutcomes: ['会'], category: '其他', compliant: true },
      ],
    })
    await pmUpdateNow({ now: 1000 })
    const list = pmCachedList()
    expect(list.map((e) => e.id)).toEqual(['a'])
  })
})

// ---- 渐进重翻：补翻历史遗留的"未中文化"盘（限量防限流，多次进渐翻完）----
describe('S15 翻译完整性：渐进重试补全中文', () => {
  beforeEach(() => {
    resetAll()
    register({ name: '我', password: 'x', agreedTerms: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  // 直接往缓存塞渲染包，模拟 DeepSeek 限流后留下的英文/中文盘。
  function seedCard({ id, zhTitle, enTitle = 'English Title ' + id, compliant = true, zhOutcomes = ['Yes', 'No'] }) {
    store.pmCache.byId[id] = {
      id, enTitle, icon: '', description: 'English desc ' + id, zhDescription: '',
      volume24hr: 1000, zhTitle, zhOutcomes, category: '加密', prob: 0.5, volume: 1000,
      createdAt: 1000, compliant,
      market: { question: 'English question ' + id, zhQuestion: '', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' },
    }
  }

  // /ds mock：按请求体里出现的 id 返回对应中文译文。
  function stubDsByIds(translations) {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const body = String(opts?.body || '')
      const arr = translations.filter((t) => body.includes('id\\":\\"' + t.id + '\\"'))
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(arr) } }] }), text: async () => '' }
    }))
  }

  it('中文判定 pmCardNeedsZh：空/等于英文/无中文字符判未翻，有中文判已翻', async () => {
    // 缓存未过期 → 走重翻分支。塞 3 个英文 + 1 个中文。
    store.pmCache.fetchedAt = 5000
    seedCard({ id: 'empty', zhTitle: '' })                       // 空 → 未翻
    seedCard({ id: 'eqEn', zhTitle: 'English Title eqEn' })       // 等于英文 → 未翻
    seedCard({ id: 'noCjk', zhTitle: 'Bitcoin 100k' })           // 无中文字符 → 未翻
    seedCard({ id: 'zh', zhTitle: '比特币破十万' })               // 有中文 → 已翻，跳过
    stubDsByIds([
      { id: 'empty', zhTitle: '空盘中文', zhOutcomes: ['会', '不会'], category: '加密', compliant: true },
      { id: 'eqEn', zhTitle: '等英文盘中文', zhOutcomes: ['会', '不会'], category: '加密', compliant: true },
      { id: 'noCjk', zhTitle: '无中文盘中文', zhOutcomes: ['会', '不会'], category: '加密', compliant: true },
      { id: 'zh', zhTitle: '不该被重翻', zhOutcomes: ['会', '不会'], category: '加密', compliant: true },
    ])
    await retranslateUntranslated() // 渐进重翻逻辑（refreshPmIfStale 缓存新鲜路径已改后台异步触发它）
    expect(store.pmCache.byId.empty.zhTitle).toBe('空盘中文')
    expect(store.pmCache.byId.eqEn.zhTitle).toBe('等英文盘中文')
    expect(store.pmCache.byId.noCjk.zhTitle).toBe('无中文盘中文')
    expect(store.pmCache.byId.zh.zhTitle).toBe('比特币破十万') // 已中文化，未被重翻覆盖
    // 验证 /ds 请求体里没带已中文化的 zh（不重翻）。
    const dsCall = fetch.mock.calls.find((c) => String(c[0]).startsWith('/ds'))
    expect(dsCall[1].body).not.toContain('id\\":\\"zh\\"')
  })

  it('未中文化盘被取出重翻并更新 byId（zhTitle/zhDescription/zhOutcomes/zhQuestion）', async () => {
    store.pmCache.fetchedAt = 5000
    seedCard({ id: 'a', zhTitle: '' })
    stubDsByIds([
      { id: 'a', zhTitle: '比特币破十万', zhDescription: '以现货价结算。', zhQuestions: ['BTC 会破十万吗'], zhOutcomes: ['会', '不会'], category: '加密', compliant: true },
    ])
    await retranslateUntranslated()
    const card = store.pmCache.byId.a
    expect(card.zhTitle).toBe('比特币破十万')
    expect(card.zhDescription).toBe('以现货价结算。')
    expect(card.zhOutcomes).toEqual(['会', '不会'])
    expect(card.market.zhQuestion).toBe('BTC 会破十万吗')
    // 透出列表也带中文。
    const list = pmCachedList()
    expect(list.find((e) => e.id === 'a').title).toBe('比特币破十万')
  })

  it('单次限量 N=30：未中文化超 30 个只翻前 30，剩下下次再补', async () => {
    store.pmCache.fetchedAt = 5000
    for (let i = 0; i < 50; i++) seedCard({ id: 'u' + i, zhTitle: '' })
    // DS 对任何进来的 id 都给中文译文。
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const body = String(opts?.body || '')
      const items = JSON.parse(body).messages[1].content.replace(/^[^\[]*/, '')
      const ids = (items.match(/"id":"(u\d+)"/g) || []).map((s) => s.match(/"(u\d+)"/)[1])
      const arr = ids.map((id) => ({ id, zhTitle: '中文' + id, zhOutcomes: ['会', '不会'], category: '加密', compliant: true }))
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(arr) } }] }), text: async () => '' }
    }))
    await retranslateUntranslated()
    const translated = Object.values(store.pmCache.byId).filter((c) => HAS_CJK_TEST.test(c.zhTitle)).length
    expect(translated).toBe(30) // 单次只翻 30
    // 再补一次：翻剩下 20。
    await retranslateUntranslated()
    const translated2 = Object.values(store.pmCache.byId).filter((c) => HAS_CJK_TEST.test(c.zhTitle)).length
    expect(translated2).toBe(50) // 两次进系统盘渐进翻完
  })

  it('已中文化的盘不重翻（全中文缓存进系统盘不发 enrich 请求）', async () => {
    store.pmCache.fetchedAt = 5000
    seedCard({ id: 'a', zhTitle: '比特币' })
    seedCard({ id: 'b', zhTitle: '以太坊' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '[]' } }] }), text: async () => '' })))
    await refreshPmIfStale({ now: 5000 + 60_000 })
    // 全已中文化 → 没有未中文化盘 → 不发任何 /ds 请求。
    const dsCalls = fetch.mock.calls.filter((c) => String(c[0]).startsWith('/ds'))
    expect(dsCalls.length).toBe(0)
  })

  it('重翻时 DeepSeek 仍限流（回英文）→ 不空写覆盖，留待下次再补', async () => {
    store.pmCache.fetchedAt = 5000
    seedCard({ id: 'a', zhTitle: '' })
    // DS 失败（限流）→ enrichFallback 回英文 enTitle。
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limit' })))
    await refreshPmIfStale({ now: 5000 + 60_000 })
    // 仍未中文化，zhTitle 没被英文降级值污染（保持原空，等下次重翻）。
    expect(pmCardNeedsZh(store.pmCache.byId.a)).toBe(true)
    expect(HAS_CJK_TEST.test(store.pmCache.byId.a.zhTitle || '')).toBe(false)
  })

  it('retranslateAllUntranslated：一次调用循环翻完全部（50 条多轮翻干净）', async () => {
    for (let i = 0; i < 50; i++) seedCard({ id: 'u' + i, zhTitle: '' })
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const body = String(opts?.body || '')
      const items = JSON.parse(body).messages[1].content.replace(/^[^\[]*/, '')
      const ids = (items.match(/"id":"(u\d+)"/g) || []).map((s) => s.match(/"(u\d+)"/)[1])
      const arr = ids.map((id) => ({ id, zhTitle: '中文' + id, zhOutcomes: ['会', '不会'], category: '加密', compliant: true }))
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(arr) } }] }), text: async () => '' }
    }))
    await retranslateAllUntranslated()
    const translated = Object.values(store.pmCache.byId).filter((c) => HAS_CJK_TEST.test(c.zhTitle)).length
    expect(translated).toBe(50) // 循环多轮一次翻完，不留英文残留
  })

  it('retranslateAllUntranslated：持续限流不死循环（连续无进展即退避停止）', async () => {
    for (let i = 0; i < 10; i++) seedCard({ id: 'r' + i, zhTitle: '' })
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; return { ok: false, status: 429, text: async () => 'rate limit' } }))
    await retranslateAllUntranslated()
    // 连续两轮翻不出新中文 → 退避停止（不会跑满 20 轮）。每轮 enrich 分批，calls 有限。
    expect(calls).toBeLessThan(10)
    // 仍全英文（没被降级值污染），留待下次。
    expect(Object.values(store.pmCache.byId).every((c) => pmCardNeedsZh(c))).toBe(true)
  })
})
