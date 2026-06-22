import fs from 'node:fs'
import path from 'node:path'
import { apiError } from './errors.js'

let cachedPath = null
let cachedMtime = -1
let cachedBody = null

export function pmCachePath() {
  return process.env.PM_CACHE_PATH || path.resolve(process.cwd(), 'pm-cache.json')
}

export function readPmCache(filePath = pmCachePath()) {
  const stat = fs.statSync(filePath)
  if (cachedBody && cachedPath === filePath && cachedMtime === stat.mtimeMs) return cachedBody
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  cachedPath = filePath
  cachedMtime = stat.mtimeMs
  cachedBody = parsed
  return parsed
}

export function pmCacheMeta(filePath = pmCachePath()) {
  const body = readPmCache(filePath)
  const byId = body?.byId && typeof body.byId === 'object' ? body.byId : {}
  return {
    generatedAt: body?.generatedAt ?? body?.fetchedAt ?? null,
    count: Object.keys(byId).length,
  }
}

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

function marketCandidates(card) {
  const out = []
  if (card?.market && typeof card.market === 'object') out.push(card.market)
  if (Array.isArray(card?.markets)) {
    for (const market of card.markets) if (market && typeof market === 'object') out.push(market)
  }
  return out
}

export function findCachedMarket({ eventId, marketId, outcome }, filePath = pmCachePath()) {
  const body = readPmCache(filePath)
  const byId = body?.byId && typeof body.byId === 'object' ? body.byId : {}
  const cards = eventId != null && byId[String(eventId)] ? [byId[String(eventId)]] : Object.values(byId)
  const wantedMarket = String(marketId || '')
  const wantedOutcome = String(outcome || '')
  if (!wantedMarket || !wantedOutcome) throw apiError('VALIDATION', 'marketId/outcome 参数不合法')

  for (const card of cards) {
    for (const market of marketCandidates(card)) {
      if (String(market.id || '') !== wantedMarket) continue
      const outcomes = parseJsonArray(market.outcomes)
      const prices = parseJsonArray(market.outcomePrices).map((price) => Number(price))
      const index = outcomes.findIndex((name) => String(name) === wantedOutcome)
      if (index < 0) throw apiError('VALIDATION', 'outcome 不存在')
      const prob = prices[index]
      if (!(prob > 0 && prob < 1)) throw apiError('VALIDATION', '该盘口概率异常，暂不可下注')
      const zhOutcomes = Array.isArray(card?.zhOutcomes) ? card.zhOutcomes : []
      // wcgame 卡的中文显示名在 groups 里按 marketId 存（韩国胜/2-1/半场平局…），账单别显示裸 Yes
      let zhFromGroups = ''
      if (card?.kind === 'wcgame' && card.groups) {
        for (const list of Object.values(card.groups)) {
          const hit = Array.isArray(list) && list.find((o) => String(o.marketId) === wantedMarket)
          if (hit) { zhFromGroups = String(hit.zhName || ''); break }
        }
      }
      return {
        eventId: String(card?.id ?? eventId),
        marketId: wantedMarket,
        eventTitle: String(card?.zhTitle || card?.enTitle || card?.title || eventId || ''),
        marketQuestion: String(market.zhQuestion || market.question || ''),
        outcome: wantedOutcome,
        zhOutcome: String(zhFromGroups || zhOutcomes[index] || wantedOutcome),
        prob,
        odds: 1 / prob,
      }
    }
  }
  throw apiError('VALIDATION', 'marketId 不存在')
}
