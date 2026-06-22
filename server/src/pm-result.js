function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function pmResolvedOutcome(market) {
  if (!market) return null
  const closed = market.closed === true || market.closed === 'true'
  if (!closed) return null
  const outcomes = parseJsonArray(market.outcomes)
  const prices = parseJsonArray(market.outcomePrices).map((price) => Number(price))
  const index = prices.findIndex((price) => price >= 0.99)
  return index >= 0 ? String(outcomes[index]) : null
}

function sameId(a, b) {
  return String(a ?? '') === String(b ?? '')
}

function pickMarketFromResult(data, expectedMarketId = null) {
  const node = Array.isArray(data) ? data[0] : data
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node.markets) && node.markets.length) {
    if (expectedMarketId != null) return node.markets.find((market) => sameId(market?.id, expectedMarketId)) || null
    return node.markets[0]
  }
  if ('outcomePrices' in node || 'closed' in node) {
    if (expectedMarketId != null && !sameId(node.id, expectedMarketId)) return null
    return node
  }
  return null
}

export async function fetchPmResultById(id, { preferMarket = false } = {}) {
  if (id == null || id === '') return { closed: false, winningOutcome: null }
  const base = process.env.PM_GAMMA_BASE || 'https://gamma-api.polymarket.com'
  const eid = encodeURIComponent(String(id))
  // gamma 的 /markets?id=<numericId>（query 形式）查不到"世界杯 series"盘（赛后仍返回空数组），
  // 但 /markets/<numericId>（路径形式）能查到——路径形式是超集，普通盘也通用，故双端点互为兜底。
  // 两者都是 market 端点：preferMarket 时绝不掉到 /events——marketId 与 eventId 可能撞号，会误结算远期冠军盘。
  const marketLookups = [
    { url: `${base}/markets?id=${eid}`, expectedMarketId: String(id) },
    { url: `${base}/markets/${eid}`, expectedMarketId: String(id) },
  ]
  const lookups = preferMarket
    ? marketLookups
    : [{ url: `${base}/events?id=${eid}` }, ...marketLookups]
  let lastError = null
  for (const { url, expectedMarketId } of lookups) {
    try {
      const res = await fetch(url)
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}: ${url}`)
        continue
      }
      const data = await res.json()
      const market = pickMarketFromResult(data, expectedMarketId)
      if (!market) {
        lastError = new Error(`响应无可解析盘口: ${url}`)
        continue
      }
      const closed = market.closed === true || market.closed === 'true'
      if (!closed) return { closed: false, winningOutcome: null }
      return { closed: true, winningOutcome: pmResolvedOutcome(market) }
    } catch (err) {
      lastError = err
    }
  }
  // 两端点全失败必须抛错让结算轮记 partial 进告警链路——
  // 静默当"未结束"会让 Polymarket 故障期间 pending 无限卡且监控全瞎
  throw lastError || new Error(`查询 Polymarket 结果失败: ${id}`)
}
