import { COUNTRY_ZH } from './core/i18n-sports.js'

// 通过 vite dev proxy 访问外部 API，避免 CORS 且不暴露 key。

// 系统盘分类（S15，反向放行模式）。中文分类 → 关键词组。classifyEvent 命中即归对应类，
// 全不命中归 '其他'（不再剔除）。体育仍只精确归 NBA/世界杯/足球/网球，其余体育（棒球/
// 橄榄球/F1/拳击等）不在白名单 → 落 '其他'（仍会进盘）。合规敏感（军事/政治）由
// isSensitiveEvent 兜底，这里只做"中性话题归类"，不承担合规职责。
const CATEGORY_RULES = [
  // 体育：仅 NBA / 世界杯 / 足球（soccer 专指，不收北美 'football'=NFL 美式橄榄球）/ 网球
  { cat: '体育', keys: ['nba', 'world cup', '世界杯', 'soccer', '足球', 'premier league', 'champions league', 'la liga', 'fifa', 'uefa', 'tennis', '网球'] },
  // 加密：主攻比特币
  { cat: '加密', keys: ['bitcoin', 'btc', '比特币', 'ethereum', 'crypto', '加密', '以太坊'] },
  // 财经 / 经济（中性：GDP/关税/通胀/央行/贸易/股市）
  { cat: '财经', keys: ['gdp', 'tariff', '关税', 'inflation', '通胀', 'fed', '央行', 'interest rate', '降息', '加息', 'trade', '贸易', 'stock', '股市', 'economy', '经济', 'recession', 'oil price', '油价'] },
  // 科技（中性：AI/芯片/科技公司）。'ai' 带空格防误伤 detail/said/retail/haiti 等子串。
  { cat: '科技', keys: [' ai ', 'tech', 'chip', '芯片', 'apple', 'tesla', 'nvidia', 'openai', 'gpt', '科技', 'iphone', 'spacex'] },
  // 文化（影视/音乐/颁奖/综艺）
  { cat: '文化', keys: ['movie', '电影', 'oscar', '奥斯卡', 'music', '音乐', 'award', '颁奖', 'grammy', 'box office', '票房', 'album', 'film'] },
  // 国际热点（限中性：外交/和谈/协议角度。军事词由 isSensitiveEvent 拦）
  { cat: '国际', keys: ['iran', '伊朗', 'deal', '协议', 'summit', '峰会', 'agreement', '和谈', 'diplomatic', '外交', 'opec', 'un ', 'g7', 'g20'] },
]

// P2 二级分类映射：前端侧拉抽屉按此顺序展示，空数组表示该一级不细分。
export const SUBCAT_MAP = {
  体育: ['世界杯', 'NBA', '足球', '网球', '棒球', '冰球', '电竞', '其他体育'],
  加密: ['比特币', '以太坊', '其他币'],
  财经: ['股市', '宏观经济', '其他财经'],
  科技: ['AI', '科技公司', '其他科技'],
  文化: ['影视', '音乐', '其他文化'],
  国际: [],
  其他: [],
}

export const WC_SUBCATS = ['全部', '奖项', '球员对决', '小组远期', '淘汰阶段', '球队玩法', '球员远期', '洲际远期', '赛事远期', '文化', '其他玩法']

const WC_SUBCAT_BY_TAG = {
  'world-cup-awards': '奖项',
  'world-cup-player-h2h': '球员对决',
  'wc-group-futures': '小组远期',
  'wc-stage-of-elimination': '淘汰阶段',
  'wc-team-props': '球队玩法',
  'wc-player-futures': '球员远期',
  'wc-continental-futures': '洲际远期',
  'wc-tournament-futures': '赛事远期',
  'wc-culture-mentions': '文化',
}

// 给事件归类：返回中文分类，全不命中归 '其他'（反向放行模式：不再剔除，让中性盘进盘）。
export function classifyEvent(event) {
  const text = eventSearchText(event)
  for (const r of CATEGORY_RULES) {
    if (r.keys.some((k) => text.includes(k))) return r.cat
  }
  return '其他'
}

// P2 给系统盘打二级分类。只返回展示 subcat，不参与下注/结算的英文 outcome 链路。
export function classifySubcat(event) {
  if (event?.subcat === '世界杯') return '世界杯'
  if (event?.subcat === '特朗普') return '特朗普'
  const text = eventSearchText(event || {})
  const cat = event?.category || classifyEvent(event || {})
  if (cat === '体育') {
    if (['nba', 'basketball'].some((k) => text.includes(k))) return 'NBA'
    if (['soccer', 'premier league', 'champions league', 'la liga', 'uefa', 'fifa', '足球'].some((k) => text.includes(k))) return '足球'
    if (['tennis', 'atp', 'wta', '网球'].some((k) => text.includes(k))) return '网球'
    if (['mlb', 'baseball', '棒球'].some((k) => text.includes(k))) return '棒球'
    if (['nhl', 'hockey', '冰球', 'stanley cup'].some((k) => text.includes(k))) return '冰球'
    if (['lol', 'league of legends', 'cs2', 'counter-strike', 'dota', 'valorant', 'esports', '电竞'].some((k) => text.includes(k))) return '电竞'
    return '其他体育'
  }
  if (cat === '加密') {
    if (['bitcoin', 'btc', '比特币'].some((k) => text.includes(k))) return '比特币'
    if (['ethereum', 'eth', '以太坊'].some((k) => text.includes(k))) return '以太坊'
    return '其他币'
  }
  if (cat === '财经') {
    if (['stock', 's&p', 'nasdaq', 'dow', '股市'].some((k) => text.includes(k))) return '股市'
    if (['gdp', 'inflation', 'fed', 'interest rate', 'tariff', '通胀', '关税', 'recession', '央行'].some((k) => text.includes(k))) return '宏观经济'
    return '其他财经'
  }
  if (cat === '科技') {
    if ([' ai ', 'openai', 'gpt', 'anthropic', 'llm', 'model'].some((k) => text.includes(k))) return 'AI'
    if (['apple', 'tesla', 'nvidia', 'google', 'meta', 'amazon', 'microsoft', 'spacex'].some((k) => text.includes(k))) return '科技公司'
    return '其他科技'
  }
  if (cat === '文化') {
    if (['movie', 'film', 'oscar', 'box office', '电影', '票房'].some((k) => text.includes(k))) return '影视'
    if (['music', 'grammy', 'album', '音乐'].some((k) => text.includes(k))) return '音乐'
    return '其他文化'
  }
  return ''
}

// 漏斗顺序（S15 反向放行模式）：active未close（API 已保证） →
//   isSensitiveEvent剔（军事/政治关键词，反向模式的合规主防线，务必保持不削弱） →
//   isDeadMarket剔（概率极端） → 其余全放行（挂中文分类，归不到具体类的落 '其他'） →
//   热度排序（API order=volume_24hr 已降序） → top 200。
// 不再"非白名单剔除"——500 条里非敏感非死盘的盘都进，盘量丰富，前端分类栏可筛。
// 返回 [{...event, category}]（已挂中文分类，供缓存/前端用）。
export function funnelEvents(events) {
  if (!Array.isArray(events)) return []
  const out = []
  for (const ev of events) {
    if (isSensitiveEvent(ev)) continue // 关键词初筛挡军事/政治（合规命门，不削弱）
    if (isDeadMarket(ev)) continue // 死盘剔
    const p4Category = ['财经', '科技'].includes(ev.category) && ev.subcat !== '特朗普' ? ev.category : '' // P4 tag 专题分类不被关键词重算覆盖。
    const category = ['世界杯', 'NBA'].includes(ev.subcat) ? '体育' : (p4Category || classifyEvent(ev)) // P3 NBA tag 保留体育分类。
    out.push(ev.subcat === '特朗普' ? { ...ev, category, subcat: '特朗普' } : { ...ev, category }) // P5 特朗普专题只保留二级标记，一级分类按原规则归类。
  }
  return out.slice(0, 200) // 热度已由 API 降序，截 top 200
}

const WORLD_CUP_TAG_SLUG = '2026-fifa-world-cup'
const WORLD_CUP_SERIES_SLUG = 'soccer-fifwc'
const NBA_TAG_SLUG = 'nba'
const FINANCE_TAG_SLUGS = ['economy', 'stocks', 'business']
const TECH_TAG_SLUGS = ['tech', 'ai', 'big-tech']
const TRUMP_TAG_SLUG = 'trump'
const PM_GAMMA_BASE = 'https://gamma-api.polymarket.com'
const IS_TEST_MODE = import.meta.env?.MODE === 'test'

function eventVolume(ev) {
  return Number(ev?.volume24hr ?? ev?.volume ?? 0) || 0
}

function pmGammaUrl(path) {
  const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined'
  return isBrowser ? `/pm${path}` : `${PM_GAMMA_BASE}${path}`
}

function tagSlug(tag) {
  return String(typeof tag === 'string' ? tag : (tag?.slug || tag?.label || '')).toLowerCase()
}

function wcSubcatForEvent(event) {
  const tags = Array.isArray(event?.tags) ? event.tags : []
  for (const tag of tags) {
    const slug = tagSlug(tag)
    if (!slug.startsWith('wc-') && !slug.startsWith('world-cup-')) continue
    if (WC_SUBCAT_BY_TAG[slug]) return WC_SUBCAT_BY_TAG[slug]
  }
  return '其他玩法'
}

// P4 按多个 tag 定向补盘：每个 tag 拉 100，id 去重后按 24h 成交量截断，失败容错 []。
async function fetchByTags(tags, limit) {
  const byId = new Map()
  try {
    for (const tag of tags) {
      const res = await fetch(`/pm/events?active=true&closed=false&limit=100&related_tags=true&tag_slug=${tag}`)
      if (!res.ok) continue
      const data = await res.json()
      const items = Array.isArray(data) ? data : [data]
      items.filter(Boolean).forEach((ev) => {
        if (ev.id == null) return
        byId.set(String(ev.id), ev)
      })
    }
  } catch {
    return []
  }
  return [...byId.values()]
    .sort((a, b) => eventVolume(b) - eventVolume(a))
    .slice(0, limit)
}

function isWorldCupTagResult(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : []
  const tagText = tags.map((t) => `${t.slug || ''} ${t.label || ''}`).join(' ').toLowerCase()
  const text = `${ev?.slug || ''} ${ev?.title || ''} ${tagText}`.toLowerCase()
  return text.includes(WORLD_CUP_TAG_SLUG) || text.includes('world-cup') || text.includes('world cup') || text.includes('fifa')
}

function isNbaTagResult(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : []
  const tagText = tags.map((t) => `${t.slug || ''} ${t.label || ''}`).join(' ').toLowerCase()
  const text = `${ev?.slug || ''} ${ev?.title || ''} ${tagText}`.toLowerCase()
  return text.includes('nba') || text.includes('basketball')
}

// P1 定向拉世界杯 tag 全量玩法：tag 失败返回 []，不影响通用系统盘。
// 返回 event 保留完整 markets[]，仅挂中文分类/二级分类；下注结算仍走英文 outcome。
export async function fetchWorldCupEvents() {
  const byId = new Map()
  try {
    const res = await fetch(`/pm/events?active=true&closed=false&limit=200&related_tags=true&tag_slug=${WORLD_CUP_TAG_SLUG}`)
    if (!res.ok) return []
    const data = await res.json()
    const items = Array.isArray(data) ? data : [data]
    items.filter(Boolean).forEach((ev) => {
      if (ev.id == null) return
      if (!isWorldCupTagResult(ev)) return
      byId.set(String(ev.id), { ...ev, category: '体育', subcat: '世界杯', wcSubcat: wcSubcatForEvent(ev) })
    })
  } catch {
    return []
  }
  return [...byId.values()]
}

function parseMarketArrays(market) {
  let outcomes = market?.outcomes
  let prices = market?.outcomePrices
  if (typeof outcomes === 'string') {
    try { outcomes = JSON.parse(outcomes || '[]') } catch { outcomes = [] }
  }
  if (typeof prices === 'string') {
    try { prices = JSON.parse(prices || '[]') } catch { prices = [] }
  }
  return {
    outcomes: Array.isArray(outcomes) ? outcomes : [],
    prices: Array.isArray(prices) ? prices : [],
  }
}

function yesProb(market) {
  const { outcomes, prices } = parseMarketArrays(market)
  const idx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes')
  if (idx === -1) return 0
  return Number(prices[idx]) || 0
}

function sportsMarketType(ev, market) {
  return String(market?.sportsMarketType || ev?.sportsMarketType || ev?.sports_market_type || '').toLowerCase()
}

function cleanTeamName(name) {
  return String(name || '')
    .replace(/\s+(?:moneyline|match winner|winner|result|exact score|halftime result).*$/i, '')
    .replace(/[?:,]+$/g, '')
    .trim()
}

function parseTeamsFromText(text) {
  const raw = String(text || '').replace(/^will\s+/i, '')
  const m = raw.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s+(?:end|on|moneyline|halftime|exact|result|winner)\b|[?:]|\(|$)/i)
  if (!m) return null
  const home = cleanTeamName(m[1])
  const away = cleanTeamName(m[2])
  return home && away ? [home, away] : null
}

function eventTeams(ev, markets) {
  const candidates = [
    ev?.title,
    ev?.slug ? String(ev.slug).replaceAll('-', ' ') : '',
    ...markets.map((m) => m.question),
  ]
  for (const text of candidates) {
    const teams = parseTeamsFromText(text)
    if (teams) return teams
  }
  return ['', '']
}

function countryZh(name) {
  const key = cleanTeamName(name)
  return COUNTRY_ZH[key] || key
}

function titleZh(home, away) {
  const h = countryZh(home)
  const a = countryZh(away)
  if (!h || !a) return `${home || ''}${home && away ? ' vs ' : ''}${away || ''}`
  return `${h} vs ${a}`
}

function outcomeSide(question, home, away) {
  const q = String(question || '').toLowerCase()
  if (q.includes('draw')) return 'draw'
  const h = String(home || '').toLowerCase()
  const a = String(away || '').toLowerCase()
  const candidate = q.match(/^will\s+(.+?)\s+win\b/i)?.[1]?.trim().toLowerCase()
  // 长名优先：主/客队名互为子串时（如 Guinea / Equatorial Guinea），先试更长的名字防张冠李戴
  const trials = [['home', h], ['away', a]].sort((x, y) => y[1].length - x[1].length)
  for (const [side, name] of trials) {
    if ((name && q.includes(name)) || (candidate && name && candidate.includes(name))) return side
  }
  return ''
}

function wcResultRow(market, home, away, prefix = '') {
  const side = outcomeSide(market?.question, home, away)
  const homeZh = countryZh(home)
  const awayZh = countryZh(away)
  const zhName = side === 'draw'
    ? (prefix ? `${prefix}平局` : '平局')
    : side === 'home'
      ? (prefix ? `${prefix}${homeZh}领先` : `${homeZh}胜`)
      : side === 'away'
        ? (prefix ? `${prefix}${awayZh}领先` : `${awayZh}胜`)
        : ''
  if (!zhName) return null
  return {
    marketId: market?.id != null ? String(market.id) : null,
    zhName,
    enOutcome: 'Yes',
    prob: yesProb(market),
  }
}

function scoreFromQuestion(question) {
  // 比分两边都 ≤15（足球比分上限防御），自动排除日期(2026-07-01)/时间(90:00)误吃
  const m = String(question || '').match(/(?:^|[^\d])(\d{1,2})\s*[-:\u2013]\s*(\d{1,2})(?!\d)/)
  if (!m) return ''
  const a = Number(m[1])
  const b = Number(m[2])
  if (a > 15 || b > 15) return ''
  return `${a}-${b}`
}

function dateFromEvent(ev) {
  const slugDate = String(ev?.slug || '').match(/(20\d{2})[-_](\d{2})[-_](\d{2})/)
  if (slugDate) return `${slugDate[1]}-${slugDate[2]}-${slugDate[3]}`
  const ms = Date.parse(ev?.eventDate || ev?.startTime || ev?.gameStartTime || ev?.endDate || ev?.startDate || '')
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : ''
}

function startMsFromEvent(ev, markets = []) {
  const marketStart = markets.find((m) => m?.gameStartTime)?.gameStartTime
  const ms = Date.parse(ev?.startTime || ev?.gameStartTime || marketStart || ev?.eventDate || ev?.endDate || ev?.startDate || '')
  return Number.isFinite(ms) ? ms : 0
}

function gameIdOf(ev, market) {
  return ev?.gameId ?? ev?.game_id ?? ev?.game?.id ?? market?.gameId ?? market?.game_id ?? ''
}

function rawWcMarket(ev, market) {
  return {
    ...market,
    sportsMarketType: market?.sportsMarketType || ev?.sportsMarketType || ev?.sports_market_type || '',
  }
}

function aggregateWorldCupGame(gameId, events) {
  const marketsById = new Map()
  for (const ev of events) {
    for (const market of Array.isArray(ev?.markets) ? ev.markets : []) {
      const raw = rawWcMarket(ev, market)
      const key = raw.id != null ? String(raw.id) : `${raw.sportsMarketType}:${raw.question}`
      if (key) marketsById.set(key, raw)
    }
  }
  const markets = [...marketsById.values()]
  if (!markets.length) return null
  const primaryEvent = events.find((ev) => (ev.markets || []).some((m) => sportsMarketType(ev, m) === 'moneyline')) || events[0]
  const [home, away] = eventTeams(primaryEvent, markets)
  const groups = { moneyline: [], halftime: [], exactScore: [] }
  for (const market of markets) {
    const type = String(market.sportsMarketType || '').toLowerCase()
    if (type === 'moneyline') {
      const row = wcResultRow(market, home, away)
      if (row) groups.moneyline.push(row)
    } else if (type === 'soccer_halftime_result') {
      const row = wcResultRow(market, home, away, '半场')
      if (row) groups.halftime.push(row)
    } else if (type === 'soccer_exact_score') {
      let score = scoreFromQuestion(market.question)
      if (!score && /any other/i.test(market.question || '')) {
        score = '其他比分' // 兜底盘：所有未列出比分，波胆玩法的常规选项，不许丢
      }
      if (!score) {
        console.warn('[wcgame] exact score parse failed:', market.question)
        continue
      }
      groups.exactScore.push({
        marketId: market?.id != null ? String(market.id) : null,
        score,
        zhName: score,
        enOutcome: 'Yes',
        prob: yesProb(market),
      })
    }
  }
  const order = { home: 0, draw: 1, away: 2 }
  const sortResultRows = (rows) => rows.sort((a, b) => {
    const sa = a.zhName.includes('平局') ? 'draw' : a.zhName.includes(countryZh(home)) ? 'home' : 'away'
    const sb = b.zhName.includes('平局') ? 'draw' : b.zhName.includes(countryZh(home)) ? 'home' : 'away'
    return order[sa] - order[sb]
  })
  sortResultRows(groups.moneyline)
  sortResultRows(groups.halftime)
  const gameStart = startMsFromEvent(primaryEvent, markets)
  return {
    id: 'wcgame-' + gameId,
    kind: 'wcgame',
    category: '体育',
    subcat: '世界杯',
    enTitle: home && away ? `${home} vs. ${away}` : (primaryEvent?.title || ''),
    zhTitle: home && away ? titleZh(home, away) : (primaryEvent?.title || ''),
    gameDate: dateFromEvent(primaryEvent),
    gameStart,
    icon: primaryEvent?.icon || primaryEvent?.image || '',
    volume24hr: events.reduce((sum, ev) => sum + eventVolume(ev), 0) || markets.reduce((sum, m) => sum + marketVolume(m), 0),
    markets,
    groups,
    compliant: true,
  }
}

// Series API 拉取世界杯单场赛程，并按 gameId 聚合成 wcgame 卡。
// 这些卡已是本地展示结构，不走 DeepSeek；markets 仍保留原始字段供下注/结算绑定。
export async function fetchWorldCupGames() {
  const byGame = new Map()
  try {
    for (let offset = 0; offset <= 200; offset += 100) {
      const path = `/events?series_slug=${WORLD_CUP_SERIES_SLUG}&active=true&closed=false&limit=100&offset=${offset}`
      const res = await fetch(pmGammaUrl(path))
      if (!res.ok) {
        if (offset === 0) return []
        break
      }
      const data = await res.json()
      if (!Array.isArray(data) || data.length === 0) break
      for (const ev of data) {
        // 合规保险：series 理论上是封闭的足球赛程集合，仍只收 fifwc- 前缀的比赛盘，防上游混入异类内容
        if (!String(ev?.slug || '').startsWith('fifwc-')) continue
        const markets = Array.isArray(ev?.markets) ? ev.markets : []
        for (const market of markets) {
          const gameId = gameIdOf(ev, market)
          if (gameId == null || gameId === '') continue
          const key = String(gameId)
          if (!byGame.has(key)) byGame.set(key, [])
          byGame.get(key).push(ev)
          break
        }
      }
      if (data.length < 100) break
    }
  } catch {
    return []
  }
  return [...byGame.entries()]
    .map(([gameId, events]) => aggregateWorldCupGame(gameId, events))
    .filter(Boolean)
    .sort((a, b) => (a.gameStart || Infinity) - (b.gameStart || Infinity))
}

// P3 定向拉 NBA tag 全量单场：tag 失败返回 []，不影响通用系统盘。
// 返回 event 保留完整 markets[]，仅挂中文分类/二级分类；下注结算仍走英文 outcome。
export async function fetchNbaEvents() {
  const byId = new Map()
  try {
    const res = await fetch(`/pm/events?active=true&closed=false&limit=200&related_tags=true&tag_slug=${NBA_TAG_SLUG}`)
    if (!res.ok) return []
    const data = await res.json()
    const items = Array.isArray(data) ? data : [data]
    items.filter(Boolean).forEach((ev) => {
      if (ev.id == null) return
      if (!isNbaTagResult(ev)) return
      byId.set(String(ev.id), { ...ev, category: '体育', subcat: 'NBA' })
    })
  } catch {
    return []
  }
  return [...byId.values()]
}

export async function fetchFinanceEvents() {
  const events = await fetchByTags(FINANCE_TAG_SLUGS, 50)
  return events.map((ev) => ({ ...ev, category: '财经' }))
}

export async function fetchTechEvents() {
  const events = await fetchByTags(TECH_TAG_SLUGS, 50)
  return events.map((ev) => ({ ...ev, category: '科技' }))
}

export async function fetchTrumpEvents() {
  const events = await fetchByTags([TRUMP_TAG_SLUG], 60)
  return events.map((ev) => ({ ...ev, subcat: '特朗普' }))
}

function mergeTopicEvent(byId, ev) {
  const id = String(ev.id)
  const prev = byId.get(id)
  if (!prev) {
    byId.set(id, ev)
    return
  }
  byId.set(id, prev.subcat === '特朗普' || ev.subcat === '特朗普' ? { ...prev, ...ev, subcat: '特朗普' } : ev)
}

export async function fetchPolymarketEvents() {
  // 分页拉取：gamma 单页上限 100（治"limit=500 只回 100"根因）。循环 offset 0~400 各拉
  //   100 条，合并最多 500 条，再走漏斗。某页 !ok 或返回空数组 → break（拉到底）。
  const all = []
  for (let offset = 0; offset < 500; offset += 100) {
    const url =
      `/pm/events?active=true&closed=false&order=volume_24hr&ascending=false&limit=100&offset=${offset}`
    const res = await fetch(url)
    if (!res.ok) {
      // 首页就失败才报错（来源隐藏:错误信息不暴露平台名）；后续页失败按拉到底处理。
      if (offset === 0) throw new Error('系统盘加载失败 (' + res.status + ')')
      break
    }
    const data = await res.json()
    if (!Array.isArray(data) || data.length === 0) break
    all.push(...data)
    if (data.length < 100) break // 不足整页 → 已到底
  }
  const volumeEvents = funnelEvents(all)
  const worldCupEvents = funnelEvents(await fetchWorldCupEvents())
  const worldCupGames = IS_TEST_MODE ? [] : await fetchWorldCupGames()
  const nbaEvents = funnelEvents(await fetchNbaEvents())
  const financeEvents = funnelEvents(await fetchFinanceEvents())
  const techEvents = funnelEvents(await fetchTechEvents())
  const trumpEvents = funnelEvents(await fetchTrumpEvents())
  const byId = new Map(volumeEvents.map((ev) => [String(ev.id), ev]))
  worldCupEvents.forEach((ev) => mergeTopicEvent(byId, ev)) // P1 世界杯完整 markets 版本优先。
  worldCupGames.forEach((ev) => mergeTopicEvent(byId, ev)) // 世界杯单场赛程卡不过 DeepSeek/敏感词/top200 裁剪。
  nbaEvents.forEach((ev) => mergeTopicEvent(byId, ev)) // P3 NBA tag 完整 markets 版本优先。
  financeEvents.forEach((ev) => mergeTopicEvent(byId, ev)) // P4 财经 tag 专题版本优先。
  techEvents.forEach((ev) => mergeTopicEvent(byId, ev)) // P4 科技 tag 专题版本优先。
  trumpEvents.forEach((ev) => mergeTopicEvent(byId, ev)) // P5 特朗普 tag 专题标记必须保留。
  return [...byId.values()]
}

// ============ S15-C 全放开总开关（爹地 2026-06-07 拍板）============
// true = 政治军事伊朗全放开（内容丰富，合规风险已充分告知爹地、由其拍板承担）。
// 改为 false 一键恢复原政治军事过滤（SENSITIVE_PATTERNS / CHINA_MILITARY_COMBO /
//   IRAN_MILITARY_COMBO 整套逻辑完整回退，定义全部保留不删）。
const ALLOW_POLITICAL_MILITARY = true // 爹地2026-06-07拍板C全放开,风险已告知;改 false 一键恢复政治军事过滤

// 性犯罪底线（最明确的红线，**全放开下仍然拦死**，与政治军事开关无关）。
// rape/rapist 用前空格做词边界，防误伤 grape/scrape/drape/therapist。
const SEXCRIME_PATTERNS = [
  'pedophile', 'epstein', 'weinstein',
  'sexual assault', 'sexual abuse', 'sex offender', 'sex crime',
  // cc-check 补全：常见性犯罪/人口贩运/儿童相关题材
  ' rape', ' rapist', 'molest', 'grooming', 'trafficking', 'child abuse', 'child sexual',
]

// 合规红线：过滤敏感政治军事题材（台海武统/政变/军事冲突/核武/恐袭/外国政要选举等）。
// 需求 5.4：只保留经济/体育/科技/中性事件，但**保留中国中性经济题材**（GDP/关税/央行/
// 贸易等可进）。精调原则：只挡敏感军事政治，不靠 'china' 这种宽词误伤中国经济类。
// ⚠️ 注意：ALLOW_POLITICAL_MILITARY=true 时本表不参与过滤；改 false 回退时完整生效，**勿删**。
// 性犯罪词已挪到 SEXCRIME_PATTERNS（始终生效），此处不再重复。
const SENSITIVE_PATTERNS = [
  // 军事冲突。注意：不放裸 'nuclear'（否则中性「核协议/核谈判」也被一刀切，违背需求
  // —— 伊朗核协议要放行交 DeepSeek 复查）。改用「核+军事」组合词，只挡真军事核题材。
  // 裸词加空格做词边界（eventSearchText 首尾留空格）：防 ' war ' 误伤 "Warriors"(勇士队)、
  //   ' army ' 误伤 army 相关中性、' clash '/' combat ' 误伤普通词。
  'military', ' war ', ' clash ', 'invade', 'invasion', 'troops', 'airstrike',
  'missile', 'nuke', 'nuclear strike', 'nuclear war', 'nuclear attack',
  'nuclear test', 'nuclear weapon', 'nuclear bomb', 'nuclear missile',
  'ceasefire', ' annex ', 'wartime', ' combat ',
  ' army ', 'soldier', 'warfare', 'strike on', 'attack on', 'blockade',
  'nato', 'pentagon', 'warship', 'drone strike', 'bombing',
  // 政变/暗杀/恐袭/政权
  'coup', 'assassinat', 'terror', 'overthrow', 'regime', 'martial law',
  'rebellion', 'putsch', 'junta', 'dictator', 'hostage', 'genocide',
  // 政治敏感（外国政要下台/选举/弹劾）
  'election', 'impeach', 'president', 'prime minister', 'out by', 'resign',
  'sanction',
  // （性犯罪词 pedophile/epstein/weinstein/sexual assault 等已上移到 SEXCRIME_PATTERNS，
  //   始终生效、不受 ALLOW_POLITICAL_MILITARY 影响，避免重复。）
  // 地缘冲突热点。注意：不放裸 'iran'（需求要中性伊朗盘：核协议/油价/和谈可进），
  // 伊朗军事盘由下方 IRAN_MILITARY_COMBO 组合过滤拦截。
  'ukraine', 'russia', 'putin', 'zelensky', 'israel', 'gaza', 'hamas',
  'hezbollah', 'north korea', 'kim jong', 'venezuela', 'syria',
  // 中国相关政治军事敏感（台海武统等）。注意：不放宽词 'china'，避免误伤
  // "China GDP / China tariff / 中国央行" 这类中性经济题材。
  'taiwan', 'cross-strait', 'xi jinping', 'ccp', 'tiananmen', 'hong kong',
  // 军事实体全称(独立成敏感,不依赖 china 同现)。注意:不加缩写 'pla',
  // 因 includes 子串会误伤 plan/player/display 等中性词。
  "people's liberation army", 'liberation army',
  // 中文敏感词（中性经济词如关税/GDP/央行/贸易不在其列，可正常进盘）
  '台海', '武统', '统一台湾', '政变', '解放军',
]

// 中国军事政治的「组合词」过滤：单看 'china'/'中国' 不敏感（经济类要放进来），
// 但与军事/主权敏感词同现时才剔除，精准挡掉台海武统类、放过中国经济类。
const CHINA_MILITARY_COMBO = [
  'invade', 'invasion', 'attack', 'military', 'war', 'strait', 'reunif',
  'blockade', 'missile', '入侵', '军事', '开战', '武力', // 去裸'pla'(误伤player/plan/display;PLA实体已由 SENSITIVE 的 liberation army 覆盖)
]
function normalizeSearchText(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
}

function isChinaMilitary(text) {
  text = normalizeSearchText(text)
  const mentionsChina = text.includes('china') || text.includes('chinese') || text.includes('中国')
  if (!mentionsChina) return false
  return CHINA_MILITARY_COMBO.some((kw) => text.includes(kw))
}

// 伊朗军事政治的「组合词」过滤（仿 CHINA_MILITARY_COMBO）：单看 'iran'/'伊朗' 不敏感
// （核协议/油价/和谈这类中性盘要放进来），但与军事/封锁/核打击等词同现时才剔除。
// 这样：霍尔木兹封锁/伊朗开战 → 拦；伊朗核协议/油价 → 放行（再交 DeepSeek 语义复查兜底）。
const IRAN_MILITARY_COMBO = [
  ' war ', 'strike', 'attack', 'military', 'invade', 'invasion', 'nuclear strike',
  'nuke', 'missile', 'blockade', 'strait', 'hormuz', 'bomb', 'troops', 'airstrike',
  '霍尔木兹', '开战', '封锁', '袭击', '空袭', '核打击', '军事', '入侵', '导弹',
]
function isIranMilitary(text) {
  text = normalizeSearchText(text)
  const mentionsIran = text.includes('iran') || text.includes('伊朗')
  if (!mentionsIran) return false
  return IRAN_MILITARY_COMBO.some((kw) => text.includes(kw))
}

function eventSearchText(event) {
  const tags = (event.tags || []).map((t) => t.label || '').join(' ')
  const markets = (event.markets || []).map((m) => m.question || '').join(' ')
  // 首尾留空格，让 ' ai ' 这类带空格的整词匹配在标题开头/结尾也能命中（避免误伤 retail/haiti 子串）。
  return normalizeSearchText(` ${event.title || ''} ${event.description || ''} ${tags} ${markets} `)
}

// 台海红线（独立底线，**不受 ALLOW_POLITICAL_MILITARY 开关影响，始终拦死**）。
// 爹地2026-06-07拍板：台海/武统/侵台是国内最高敏感红线(国家主权核心),即使C全放开也单独挡。
// 中性台湾盘(经济/半导体TSMC/选举)放行——仅台湾与军事/主权词同现才拦。
const TAIWAN_REDLINE_ZH = ['台海', '武统', '统一台湾', '侵台', '解放台湾', '攻台']
const TAIWAN_MILITARY_COMBO = [
  'invade', 'invasion', ' war ', 'military', 'conflict', 'reunif', 'reunification',
  'independence', ' annex ', 'attack', 'blockade', 'strait', 'liberate',
  '统一', '侵', '开战', '武力', '军事', '独立', '收复',
]
export function isTaiwanRedline(text) {
  text = normalizeSearchText(text)
  if (TAIWAN_REDLINE_ZH.some((k) => text.includes(k))) return true
  if (text.includes('cross-strait')) return true
  const mentionsTaiwan = text.includes('taiwan') || text.includes('台湾')
  if (!mentionsTaiwan) return false
  return TAIWAN_MILITARY_COMBO.some((k) => text.includes(k))
}

// 习近平红线（独立底线，**不受 ALLOW_POLITICAL_MILITARY 开关影响，始终拦死**）。
// 爹地2026-06-08拍板：习近平相关信息全部不能出现（国内最高敏感，领导人）。
// 用 'jinping' 独特词避免误伤 xi'an(西安)/taxi 等含 'xi' 子串。
const XI_REDLINE = ['xi jinping', 'jinping', '习近平', '习主席', '总书记', 'general secretary', 'president xi']
export function isXiJinpingRedline(text) {
  text = normalizeSearchText(text)
  return XI_REDLINE.some((k) => text.includes(k))
}

// 中国相关(中性)判定：用于系统盘排序加权（爹地2026-06-08要中国题材增加比重、多露出）。
// 仅中性中国题材(经济/科技/金融/品牌)加权；台海/习近平等红线由 isSensitiveEvent 另行挡死。
const CHINA_RELATED = [
  'china', 'chinese', '中国', '人民币', 'rmb', 'yuan', 'a股', 'a-share', '恒生', 'hang seng',
  '上证', 'csi', '中概', 'alibaba', 'tencent', 'byd', 'huawei', '华为', '比亚迪', '腾讯', '阿里巴巴',
]
export function isChinaRelated(event) {
  const text = eventSearchText(event)
  return CHINA_RELATED.some((k) => text.includes(k))
}

// 原政治军事过滤（关键词 + 中国/伊朗军事组合词）。开关 false 时由 isSensitiveEvent 调用。
// 单独导出供测试验证「开关 false 回退」逻辑完整（不依赖运行期改 const）。
export function isPoliticalMilitaryEvent(event) {
  const text = eventSearchText(event)
  if (SENSITIVE_PATTERNS.some((kw) => text.includes(kw))) return true
  return isChinaMilitary(text) || isIranMilitary(text)
}

export function isSensitiveEvent(event) {
  const text = eventSearchText(event)
  // ① 性犯罪底线：始终拦死，全放开也挡（最明确的红线）。
  if (SEXCRIME_PATTERNS.some((kw) => text.includes(kw))) return true
  // ①.5 台海红线：始终拦死，不受全放开开关影响（国内最高敏感红线，爹地拍板单独挡）。
  if (isTaiwanRedline(text)) return true
  // ①.6 习近平红线：始终拦死，不受开关（爹地2026-06-08拍板，领导人信息全不出现）。
  if (isXiJinpingRedline(text)) return true
  // ② 开关关闭 → 走原政治军事过滤（关键词 + 中国/伊朗军事组合词）。
  if (!ALLOW_POLITICAL_MILITARY) return isPoliticalMilitaryEvent(event)
  // ③ 全放开：政治军事伊朗放行。
  return false
}

// 死盘过滤：主盘所有结果概率都极端(>99% 或 <1%)，已无博弈空间，玩着没劲，剔除。
// 阈值放宽到 0.99/0.01（原 0.97/0.03 一刀切太狠，错杀 BTC到价/AI发布类天然极端概率盘）。
function isDeadMarket(event) {
  const m = event.markets?.[0]
  if (!m) return true
  const probs = parseOutcomes(m).map((o) => o.prob)
  if (!probs.length) return true
  return probs.every((p) => p > 0.99 || p < 0.01)
}

// 可玩 = 不敏感 且 非死盘。
export function isPlayableEvent(event) {
  return !isSensitiveEvent(event) && !isDeadMarket(event)
}

// Polymarket 的 outcomes / outcomePrices 是 JSON 字符串，需要解析。
export function parseOutcomes(market) {
  let outcomes = []
  let prices = []
  try {
    outcomes = JSON.parse(market.outcomes || '[]')
  } catch {
    outcomes = []
  }
  try {
    prices = JSON.parse(market.outcomePrices || '[]')
  } catch {
    prices = []
  }
  return outcomes.map((name, i) => ({
    name,
    prob: parseFloat(prices[i] ?? '0') || 0,
  }))
}

// ============ P1 体育盘玩法识别（Polymarket 风：1 event 多 market = 多玩法）============
// 从 market 的 question / groupItemTitle 解析玩法类型。一场 NBA 单场可有 118 个 market，
// 世界杯夺冠/出线/晋级等 event 每个候选(国家/球员)是一个 Yes/No market。
// 返回：
//   'moneyline' 胜负线 | 'spread' 让分 | 'total' 大小分 | 'outright' 冠军/榜单候选(Yes/No)
//   'player_prop' 球员道具(个人得分/篮板/助攻 O/U) | 'novelty' 趣味(先得分/奇偶) | 'half' 半场盘 | 'other'
// 纯展示/分组用；下注、结算的守恒命脉仍走真实英文 outcome，不受本函数影响。
export function parseMarketPlayType(market) {
  if (!market) return 'other'
  const git = String(market.groupItemTitle || '')
  const q = String(market.question || '')
  const text = git || q
  // 半场盘（1H / 1st Half）单列一类，精选时砍掉。
  if (/\b1H\b|1st\s*Half/i.test(text)) return 'half'
  // 球员道具盘：git 形如 "球员名: Points/Rebounds/Assists/... O/U X.5"——精选时砍。
  if (/:\s*(Points|Rebounds|Assists|Steals|Blocks|Threes|3-Pointers|Made Threes|PRA|Pts\b)\b/i.test(text) && /O\/U|Over\/Under/i.test(text)) {
    return 'player_prop'
  }
  // 趣味盘：谁先得分 / 总分奇偶——精选时砍。
  if (/Score First|Odd\/Even|Odd or Even/i.test(text)) return 'novelty'
  // 大小分：O/U 或 Over/Under。
  if (/O\/U|Over\/Under/i.test(text)) return 'total'
  // 让分：Spread。
  if (/Spread/i.test(text)) return 'spread'
  // 显式胜负线。
  if (/Moneyline/i.test(text)) return 'moneyline'
  // outright：Yes/No 二元（夺冠/出线/晋级/金靴的候选）。
  const opts = parseOutcomes(market)
  const names = opts.map((o) => String(o.name).toLowerCase())
  if (names.length === 2 && names[0] === 'yes' && names[1] === 'no') return 'outright'
  // 兜底主胜负盘：两队/两人对阵（git 空、question 含 "vs"、两个非 Yes/No 选项）。
  if (opts.length === 2 && /\bvs\.?\b/i.test(q)) return 'moneyline'
  return 'other'
}

// 精选主玩法（爹地拍板）：只保留 胜负线/让分/大小分/冠军期货，砍球员道具/趣味/半场。
const MAIN_PLAY_TYPES = ['moneyline', 'spread', 'total', 'outright']
export function isMainPlayType(type) {
  return MAIN_PLAY_TYPES.includes(type)
}

// 提取让分/大小分的盘口线数值（如 Spread -2.5 → -2.5，O/U 215.5 → 215.5）。
// 取文本里第一个带符号/小数的数字；取不到返回 null（如 moneyline/outright 无盘口线）。
export function parseMarketLine(market) {
  if (!market) return null
  const text = String(market.groupItemTitle || market.question || '')
  const m = text.match(/[-+]?\d+(?:\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

// 把一个 event 的 outright 玩法（夺冠/出线/晋级/金靴——每个候选国家/球员是一个 Yes/No market）
// 聚合成榜单：取每个候选的 Yes 概率为其夺冠/出线概率，按降序排。供世界杯榜单卡片/详情展示。
// 每行保留 marketId + 真实英文 outcomes，供下注绑定与结算守恒。
export function aggregateOutright(event) {
  const markets = (event && event.markets) || []
  const rows = []
  for (const m of markets) {
    if (parseMarketPlayType(m) !== 'outright') continue
    const opts = parseOutcomes(m)
    const yes = opts.find((o) => String(o.name).toLowerCase() === 'yes')
    rows.push({
      marketId: m.id != null ? String(m.id) : null,
      name: m.groupItemTitle || m.question || '', // 候选实体名（国家/球员，英文，展示层再翻中文）
      prob: yes ? yes.prob : 0, // 夺冠/出线概率
      outcomes: m.outcomes, // 真实英文 outcomes（["Yes","No"]），下注守恒用
    })
  }
  rows.sort((a, b) => b.prob - a.prob)
  return rows
}

function marketIdOf(market) {
  return market?.id != null ? String(market.id) : null
}

function marketVolume(market) {
  const v = Number(market?.volume24hr ?? market?.volume ?? 0)
  return Number.isFinite(v) ? v : 0
}

function optionScore(market, preferName) {
  const opts = parseOutcomes(market)
  if (!opts.length) return Infinity
  const preferred = opts.find((o) => String(o.name).toLowerCase() === preferName)
  const picked = preferred || opts[0]
  return Math.abs((picked?.prob ?? 0) - 0.5)
}

function marketOptions(market) {
  return parseOutcomes(market).map((o) => ({ name: o.name, prob: o.prob }))
}

function matchMarketRow(market) {
  if (!market) return null
  return {
    marketId: marketIdOf(market),
    options: marketOptions(market),
  }
}

function lineMarketRow(market) {
  if (!market) return null
  return {
    marketId: marketIdOf(market),
    line: parseMarketLine(market),
    options: marketOptions(market),
  }
}

// P3 单场比赛精选主玩法：胜负线 + 让分主线 + 大小分主线。
// 只保留 marketId 与真实英文 options，中文只在缓存展示层补，守住下注/结算 outcome。
export function groupMatchMarkets(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : []
  const moneylineCandidates = markets.filter((m) => parseMarketPlayType(m) === 'moneyline')
  const primaryMoneylines = moneylineCandidates.filter((m) => {
    const git = String(m.groupItemTitle || '').trim()
    return !git || /Moneyline/i.test(git)
  })
  const moneylinePool = primaryMoneylines.length ? primaryMoneylines : moneylineCandidates
  const moneylineMarket = moneylinePool
    .map((m, i) => ({ m, i }))
    .sort((a, b) => marketVolume(b.m) - marketVolume(a.m) || a.i - b.i)[0]?.m || null
  const spreadMarket = markets
    .filter((m) => parseMarketPlayType(m) === 'spread')
    .map((m, i) => ({ m, i, score: optionScore(m, 'yes') }))
    .sort((a, b) => a.score - b.score || marketVolume(b.m) - marketVolume(a.m) || a.i - b.i)[0]?.m || null
  const totalMarket = markets
    .filter((m) => parseMarketPlayType(m) === 'total')
    .map((m, i) => ({ m, i, score: optionScore(m, 'over') }))
    .sort((a, b) => a.score - b.score || marketVolume(b.m) - marketVolume(a.m) || a.i - b.i)[0]?.m || null
  const moneyline = matchMarketRow(moneylineMarket)
  const moneylineOptions = moneyline?.options || []
  return {
    teams: moneylineOptions.length === 2 ? moneylineOptions.map((o) => o.name) : null,
    moneyline,
    spread: lineMarketRow(spreadMarket),
    total: lineMarketRow(totalMarket),
  }
}

// P3 有胜负线，且至少有让分或大小分，才视为单场对阵。
export function isMatchEvent(event) {
  const grouped = groupMatchMarkets(event)
  return !!(grouped.moneyline && (grouped.spread || grouped.total))
}

// S11 真实揭晓探测：从已结算盘口里取真实获胜结果名。
// Polymarket 盘口结束后 market.closed=true，且 outcomePrices 里获胜结果价格→1、其余→0。
// 返回获胜结果名（如 "Yes"），未结算 / 取不到则返回 null（前端转走「模拟揭晓」）。
export function pmResolvedOutcome(market) {
  if (!market) return null
  const closed = market.closed === true || market.closed === 'true'
  if (!closed) return null
  const opts = parseOutcomes(market)
  if (!opts.length) return null
  // 价格逼近 1 的那个结果即真实赢家（容忍浮点误差）。
  const win = opts.find((o) => o.prob >= 0.99)
  return win ? win.name : null
}

// S16 按 id 查真实结果：盘口结束后从拉取范围(active&closed=false)消失，按 id 单独查 gamma API
// 拿到已结束盘口的真实结果（即使 closed=true 也能查到）。走 /pm proxy（来源隐藏、无 key）。
// 试两种端点：/pm/markets?id={id}（盘口）与 /pm/events?id={id}（事件，取主盘）。
// 返回 { closed:bool, winningOutcome:string|null }；查不到/未结束/网络错 → { closed:false }（容错不抛）。
export async function fetchPmResultById(id, { preferMarket = false } = {}) {
  if (id == null || id === '') return { closed: false, winningOutcome: null }
  const eid = encodeURIComponent(String(id))
  // gamma 按 id 查可能回数组或单对象；events 里盘口在 markets[]，markets 直接是盘口。
  // 旧押注默认优先 events（eventId）；P1 多 market 押注传 marketId 时优先 markets，避免串台。
  const urls = preferMarket
    ? [`/pm/markets?id=${eid}`, `/pm/events?id=${eid}`]
    : [`/pm/events?id=${eid}`, `/pm/markets?id=${eid}`]
  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const data = await res.json()
      const market = pickMarketFromResult(data)
      if (!market) continue
      const closed = market.closed === true || market.closed === 'true'
      if (!closed) return { closed: false, winningOutcome: null }
      const win = pmResolvedOutcome(market)
      return { closed: true, winningOutcome: win }
    } catch {
      // 网络错/解析错 → 试下一个端点，全失败按未结束容错
    }
  }
  return { closed: false, winningOutcome: null }
}

// 从 gamma 按 id 查的返回里取出一个可判定的主盘（兼容 数组/单对象、event/market 两种形态）。
//   - events 形态：{ markets:[...] } 或 [{ markets:[...] }] → 取 markets[0]
//   - markets 形态：{ closed, outcomePrices } 或 [{...}] → 直接是盘口
function pickMarketFromResult(data) {
  const node = Array.isArray(data) ? data[0] : data
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node.markets) && node.markets.length) return node.markets[0]
  // 自身就是盘口（有 outcomePrices/closed 字段）。
  if ('outcomePrices' in node || 'closed' in node) return node
  return null
}

// 让 DeepSeek 分析我这一押大概率赢还是输。
export async function askDeepSeek({ eventTitle, marketQuestion, options, myPick }) {
  const optionsText = options
    .map((o) => `- ${o.name}: 当前市场概率 ${(o.prob * 100).toFixed(1)}%`)
    .join('\n')

  const userContent = `预测事件：${eventTitle}
具体盘口：${marketQuestion}
各选项当前市场概率：
${optionsText}

我押注的是：「${myPick}」

请基于事件信息和你的常识推理，分析我这一押大概率会赢还是输，并给出理由。`

  const body = {
    model: 'deepseek-chat',
    messages: [
      {
        role: 'system',
        content:
          '你是一名资深预测市场分析师。注意：你无法联网获取实时信息，你的判断完全基于事件本身的信息、市场给出的概率以及常识推理。请用中文回答，先给出明确结论（大概率赢/大概率输/胜负难料），再用 2-4 条要点说明理由，最后用一句话提醒用户这是基于推理的分析、并非实时数据。语气专业、简洁。' +
          SAFE_TOPIC_RULE,
      },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 600,
  }

  const content = await dsChat(body)
  if (!content) throw new Error('DeepSeek 返回内容为空')
  return content
}

// ============ DeepSeek 通用底座（S6）============
// 统一走 /ds proxy（vite.config.js 在 proxyReq 阶段注入 Authorization，
// key 只在 .env.local，绝不进前端代码/git）。返回 message.content 文本。
async function dsChat(body) {
  const res = await fetch('/ds/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`DeepSeek 请求失败 (${res.status}) ${txt.slice(0, 120)}`)
  }
  const data = await res.json()
  return data?.choices?.[0]?.message?.content || ''
}

// ============ S15 系统盘 DeepSeek 加工：批量翻译 + 分类 + 合规复查 ============
// 对漏斗后的盘口批量（每批 BATCH_SIZE 条）调 DeepSeek：
//   ① 翻译 title + description(事件描述) + 各 market 的 question(盘口问题) + 各 outcome 选项名 → 中文；
//   ② 确认/修正分类（归入 体育/加密/国际/财经/科技/文化/其他）；
//   ③ 合规复查（硬边界）：中性(谈成什么/经济怎么走) compliant:true；
//      军事冲突(开战/封锁/霍尔木兹封锁/伤亡/政权更迭) compliant:false 剔除。
// 返回 [{ id, zhTitle, zhDescription, zhOutcomes:[], zhQuestions:[], category, compliant }]。
// 降级（单批失败/限流）：保留英文文案 + 关键词分类 + compliant = !isSensitiveEvent(ev)
//   （信任关键词初筛层：已过初筛的放行，初筛挡的本不会进到这；防 DeepSeek 限流致空）。
// key 只在 .env.local 走 /ds proxy，绝不硬编码。

const PM_BATCH_SIZE = 8

// 本地化 + 分类规则，写进 system prompt，要求只输出 JSON。
// 全放开（ALLOW_POLITICAL_MILITARY=true）下，DeepSeek 不再做政治军事合规复查，只做翻译+分类，
//   compliant 固定 true；性犯罪底线由漏斗 isSensitiveEvent(SEXCRIME_PATTERNS) 在进 enrich 前挡掉。
const PM_ENRICH_SYSTEM =
  '你是预测盘口的本地化助手。给你一批英文预测盘口，逐条做两件事：' +
  '①把 title(标题)、description(事件描述)、每个 market 的 question(盘口问题) 和每个 outcome 选项名都翻译成简洁中文；' +
  '②归入唯一分类，只能取这七个之一：体育/加密/国际/财经/科技/文化/其他（归不到前六类的中性盘归"其他"）。' +
  '严格只输出 JSON 数组，每条格式：' +
  '{"id":"原样回传的id","zhTitle":"中文标题","zhDescription":"中文描述","zhQuestions":["中文盘口问题1"],"zhOutcomes":["中文选项1","中文选项2"],"category":"分类","compliant":true}。' +
  'compliant 一律填 true。zhQuestions 按输入 questions 顺序一一对应。不要 markdown、不要解释、不要多余文字。'

// 把单条 event 压成喂给 DeepSeek 的精简结构（省 token）。
// description 截断到 300 字省 token；questions 取各 market 的 question（与缓存里 market 一一对应）。
function pmEnrichInput(ev) {
  const outcomes = parseOutcomes(ev.markets?.[0] || {}).map((o) => o.name)
  const questions = (ev.markets || []).map((m) => m.question || '')
  return {
    id: String(ev.id),
    title: ev.title || '',
    description: String(ev.description || '').slice(0, 300),
    questions,
    outcomes,
  }
}

// 关键词分类降级（DeepSeek 失败时用）：复用 classifyEvent，取不到给 '国际' 兜底。
function fallbackCategory(ev) {
  return classifyEvent(ev) || '国际'
}

// 单批 enrich：调一次 DeepSeek，解析返回，对齐回每个 id。失败 → 整批降级。
async function enrichBatch(batch) {
  const items = batch.map(pmEnrichInput)
  const body = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: PM_ENRICH_SYSTEM },
      { role: 'user', content: '盘口列表（JSON）：\n' + JSON.stringify(items) },
    ],
    temperature: 0.2,
    max_tokens: 2000,
  }
  try {
    const raw = await dsChat(body)
    const parsed = parseJsonLoose(raw)
    if (Array.isArray(parsed) && parsed.length) {
      const byId = new Map(parsed.map((p) => [String(p.id), p]))
      return batch.map((ev) => {
        const p = byId.get(String(ev.id))
        if (p && p.zhTitle) {
          return {
            id: String(ev.id),
            zhTitle: String(p.zhTitle).trim(),
            zhDescription: String(p.zhDescription || '').trim(), // 中文事件描述（查不到回退英文交前端降级）
            zhOutcomes: alignZhOutcomes(p.zhOutcomes, ev),
            zhQuestions: alignZhQuestions(p.zhQuestions, ev), // 各盘口中文问题（按 market 对齐）
            category: VALID_CATS.includes(p.category) ? p.category : fallbackCategory(ev),
            // 全放开下不再以政治军事判 false：compliant = !isSensitiveEvent(ev)。
            //   漏斗已挡性犯罪/(开关关时的)政治军事，进 enrich 的都 !sensitive → true。
            //   开关 false 回退时，sensitive 盘本就被漏斗剔不会到这，此处仍是 true，逻辑自洽。
            compliant: !isSensitiveEvent(ev),
          }
        }
        // 该条没对上 → 降级（信任关键词初筛层）
        return enrichFallback(ev)
      })
    }
  } catch (e) {
    // 整批失败 → 全降级
  }
  return batch.map(enrichFallback)
}

const VALID_CATS = ['体育', '加密', '国际', '财经', '科技', '文化', '其他']

// 单条降级结果（DeepSeek 失败/限流/没对上）：英文文案 + 关键词分类 +
//   compliant = !isSensitiveEvent(ev)（信任关键词初筛层）。
// 反向放行模式下：funnel 已用 isSensitiveEvent 挡掉军事/政治，能进到 enrich 的都是初筛
// 放行的中性盘。DeepSeek 降级时若一律判 false 会致限流时系统盘全空——改为信任初筛结果放行，
// DeepSeek 正常时再用其军事语义判定额外剔 false。关键词层是反向模式的合规保底防线。
function enrichFallback(ev) {
  return {
    id: String(ev.id),
    zhTitle: ev.title || '',
    zhDescription: ev.description || '', // 降级回英文描述
    zhOutcomes: parseOutcomes(ev.markets?.[0] || {}).map((o) => o.name),
    zhQuestions: (ev.markets || []).map((m) => m.question || ''), // 降级回英文盘口问题
    category: fallbackCategory(ev),
    compliant: !isSensitiveEvent(ev), // 信任关键词初筛：已过初筛的放行（防限流致空）
  }
}

// 中文选项与英文 outcomes 长度对齐：一致才用译文，否则降级英文(防 DeepSeek 多/漏项致显示错位/张冠李戴)。
function alignZhOutcomes(zh, ev) {
  const en = parseOutcomes(ev.markets?.[0] || {}).map((o) => o.name)
  if (Array.isArray(zh) && zh.length === en.length) return zh.map((x) => String(x).trim())
  return en
}

// 中文盘口问题与英文 questions 长度对齐：一致才用译文，否则降级英文（防错位）。
function alignZhQuestions(zh, ev) {
  const en = (ev.markets || []).map((m) => m.question || '')
  if (Array.isArray(zh) && zh.length === en.length) return zh.map((x) => String(x).trim())
  return en
}

// 批量 enrich 入口：分批串行调 DeepSeek（减少并发限流），汇总返回。
export async function enrichEventsWithDS(events) {
  if (!Array.isArray(events) || !events.length) return []
  const out = []
  for (let i = 0; i < events.length; i += PM_BATCH_SIZE) {
    const batch = events.slice(i, i + PM_BATCH_SIZE)
    out.push(...(await enrichBatch(batch)))
  }
  return out
}

function rnd(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// prompt 公共合规约束：禁军事政治敏感题材，只聊体育/娱乐/生活/经济。
const SAFE_TOPIC_RULE =
  '严禁涉及任何军事、政治、政权、选举、战争、地缘冲突、暴恐、民族宗教等敏感题材；' +
  '只允许体育、娱乐、影视综艺、游戏电竞、生活日常、消费、天气、财经经济等中性轻松话题。'

// ---- ① 毒舌庄家解说：揭晓后的犀利吐槽（§5.7 引流主角）----
// 入参：{ title 题目, ownerSideLabel 我押的边, resultLabel 真实结果,
//        iWon 我是否赢, takerName 对手名(可空) }
// 返回：一段 30-80 字毒舌解说文本。失败 → 本地毒舌模板库随机降级。
export async function roastSettle({ title, ownerSideLabel, resultLabel, iWon, takerName }) {
  const winner = iWon ? '我' : (takerName || '对手')
  const loser = iWon ? (takerName || '对手') : '我'
  const userContent = `赌局题目：${title}
我押的是：「${ownerSideLabel}」
真实结果：「${resultLabel}」
${iWon ? '我押中了，赢家是「我」' : `我押错了，赢家是「${takerName || '对手'}」`}
${takerName ? `对手是「${takerName}」` : '无人接盘'}

请以"毒舌庄家"人格，对这一局揭晓做一段犀利吐槽：调侃赢家「${winner}」运气/眼光，奚落输家「${loser}」看走眼。`
  const body = {
    model: 'deepseek-chat',
    messages: [
      {
        role: 'system',
        content:
          '你是《買定離手》里那个嘴贱毒舌的庄家解说，人格鲜明、爱玩梗、敢开赢家也敢损输家。' +
          '只针对赌局结果吐槽，对人不刻薄、不人身攻击、不涉及隐私。' +
          SAFE_TOPIC_RULE +
          '输出一段中文，30-80 字，犀利带梗，不要换行、不要前缀、不要引号。',
      },
      { role: 'user', content: userContent },
    ],
    temperature: 1.0,
    max_tokens: 200,
  }
  try {
    const content = (await dsChat(body)).trim()
    if (content) return content
  } catch (e) {
    // 静默降级
  }
  return rnd(iWon ? ROAST_WIN : ROAST_LOSE)
}

// 毒舌模板库（降级）：赢/输各一组，结算照常出解说不阻塞。
const ROAST_WIN = [
  '这把赢得漂亮，庄家都想给你递根烟——眼光是真毒，对面怕是要回家面壁。',
  '稳得一批，押中的就是大爷。输的那位，建议下次先问问黄历再下注。',
  '神预测达成！这运气挡都挡不住，对面已哭晕在厕所。',
  '赢麻了赢麻了，这一把把对面的自信按在地上摩擦，舒坦。',
]
const ROAST_LOSE = [
  '哎哟喂这都能押反？庄家替你捏把汗。回去复盘吧，这波是真看走眼了。',
  '输得明明白白，下次下注前先冷静三秒，别一上头就梭哈。',
  '这一押精准避开正确答案，反向天才说的就是你，鼓掌👏。',
  '没事，亏的是积分又不能提现，权当交学费——交得有点多。',
]

// ---- ② AI 开盘助手：把口水题锻造成无歧义判定标准（§5.7/§5.8）----
// 入参：{ title 大白话题目 }
// 返回：{ criteria 判定标准, optionA, optionB }。失败 → 提示手填降级。
export async function forgeCriteria({ title }) {
  const userContent = `玩家用大白话出的赌题：「${title}」

请把它锻造成一个可对赌、无歧义的判定标准：
1. criteria：清晰说明"怎么算赢、以什么为准、何时揭晓"，消除扯皮空间；
2. optionA / optionB：两个互斥、对立的下注选项（各 2-6 字，简短）。`
  const body = {
    model: 'deepseek-chat',
    messages: [
      {
        role: 'system',
        content:
          '你是预测对赌平台的"开盘助手"，专把含糊的口水题打磨成无歧义判定标准。' +
          SAFE_TOPIC_RULE +
          '严格只输出 JSON，格式：{"criteria":"...","optionA":"...","optionB":"..."}，' +
          'criteria 控制在 60 字内，不要 markdown、不要多余文字。',
      },
      { role: 'user', content: userContent },
    ],
    temperature: 0.5,
    max_tokens: 300,
  }
  try {
    const raw = await dsChat(body)
    const parsed = parseJsonLoose(raw)
    if (parsed && parsed.criteria) {
      return {
        criteria: String(parsed.criteria).trim(),
        optionA: String(parsed.optionA || '').trim() || '是',
        optionB: String(parsed.optionB || '').trim() || '否',
        fallback: false,
      }
    }
  } catch (e) {
    // 静默降级
  }
  return {
    criteria: '',
    optionA: '',
    optionB: '',
    fallback: true,
    hint: 'AI 暂时没空，请手动写清：怎么算赢、以什么为准、何时揭晓。',
  }
}

// ---- ③ AI 每日出题：返回 3-5 个适合熟人对赌的中性热点话题 ----
// 返回：string[]（题目文案）。失败 → 本地话题模板库随机降级。
export async function dailyTopics() {
  const body = {
    model: 'deepseek-chat',
    messages: [
      {
        role: 'system',
        content:
          '你是熟人对赌局的"每日出题官"，给饭桌上那帮朋友出适合互相对赌的轻松话题。' +
          SAFE_TOPIC_RULE +
          '每条都是一句可以二选一对赌的疑问句（如"这周末会下雨吗"）。' +
          '严格只输出 JSON 数组，格式：["题1","题2","题3","题4"]，4 条，每条不超过 20 字，不要多余文字。',
      },
      { role: 'user', content: '出 4 个今天适合熟人对赌的中性热点话题。' },
    ],
    temperature: 1.0,
    max_tokens: 300,
  }
  try {
    const raw = await dsChat(body)
    const parsed = parseJsonLoose(raw)
    if (Array.isArray(parsed) && parsed.length) {
      const list = parsed.map((t) => String(t).trim()).filter(Boolean).slice(0, 5)
      if (list.length) return list
    }
  } catch (e) {
    // 静默降级
  }
  // 降级：本地中性话题库随机取 4 条。
  return shuffle(LOCAL_TOPICS).slice(0, 4)
}

const LOCAL_TOPICS = [
  '这周末本地会下雨吗？',
  '这部新上映的电影豆瓣能上 7 分吗？',
  '今晚那场球主队能赢吗？',
  '本月这只热门股会涨吗？',
  '这季综艺冠军会是大热门那位吗？',
  '下周油价会涨吗？',
  '这款新手机首发会破发吗？',
  '今年双十一你的快递三天内能到吗？',
  '这位顶流的新歌能进热搜前三吗？',
  '这局电竞比赛能打满 BO5 吗？',
]

function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 宽松 JSON 解析：DeepSeek 有时会用 ```json 包裹或夹带文字，抠出第一段 {…} 或 […]。
function parseJsonLoose(raw) {
  if (!raw) return null
  let s = String(raw).trim()
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(s)
  } catch {
    // 先贪婪取第一个 { 或 [ 到最后一个 } 或 ]；失败再用非贪婪取首个平衡块。
    // (防 AI 在 JSON 后夹带含 }/] 的说明文字时，贪婪匹配把整段吞进来导致解析失败)
    const greedy = s.match(/[[{][\s\S]*[\]}]/)
    if (greedy) {
      try { return JSON.parse(greedy[0]) } catch { /* 落到非贪婪 */ }
    }
    const nonGreedy = s.match(/\{[\s\S]*?\}/) || s.match(/\[[\s\S]*?\]/)
    if (nonGreedy) {
      try { return JSON.parse(nonGreedy[0]) } catch { /* 放弃 */ }
    }
    return null
  }
}
