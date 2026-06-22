import { apiError } from './errors.js'
import { findCachedMarket, pmCacheMeta } from './pm-cache.js'
import { runSettlement } from './settle.js'

function requireString(value, field) {
  const out = String(value || '').trim()
  if (!out) throw apiError('VALIDATION', `${field} 参数不合法`)
  return out
}

function positiveInt(value, field) {
  const out = Math.round(Number(value) || 0)
  if (!(out > 0)) throw apiError('VALIDATION', `${field} 必须大于 0`)
  return out
}

function balanceAfter(db, userId) {
  return db.prepare('SELECT balance FROM users WHERE id=?').get(userId).balance
}

export function rowToPmBet(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    marketId: row.market_id,
    eventTitle: row.event_title,
    marketQuestion: row.market_question,
    outcome: row.outcome,
    zhOutcome: row.zh_outcome,
    prob: row.prob,
    odds: row.odds,
    stake: row.stake,
    status: row.status,
    result: row.result,
    payout: row.payout,
    settledAt: row.settled_at,
    createdAt: row.created_at,
    at: row.created_at,
  }
}

export function pmBetsForUser(db, userId, limit = 100) {
  const safeLimit = Math.min(200, Math.max(1, Math.round(Number(limit) || 100)))
  return db.prepare(`
    SELECT * FROM pm_bets
    WHERE user_id=?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(userId, safeLimit).map(rowToPmBet)
}

export function registerPmRoutes(app, {
  db,
  requireAuth,
  requireAdmin,
  ok,
  runIdempotent,
  idempotencyKey,
  now,
  fetchResult,
  onSettleRun,
}) {
  app.get('/api/v1/pm/markets', { preHandler: requireAuth }, async () => ok(pmCacheMeta()))

  app.post('/api/v1/pm-bets', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const eventId = requireString(req.body?.eventId, 'eventId')
    const marketId = requireString(req.body?.marketId, 'marketId')
    const outcome = requireString(req.body?.outcome, 'outcome')
    const stake = positiveInt(req.body?.stake, 'stake')
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      const cached = findCachedMarket({ eventId, marketId, outcome })
      const paid = db.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?')
        .run(stake, req.user.id, stake)
      if (paid.changes === 0) throw apiError('INSUFFICIENT_BALANCE')
      const info = db.prepare(`
        INSERT INTO pm_bets (
          user_id, event_id, market_id, event_title, market_question, outcome, zh_outcome,
          prob, odds, stake, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        req.user.id,
        cached.eventId,
        cached.marketId,
        cached.eventTitle,
        cached.marketQuestion,
        cached.outcome,
        cached.zhOutcome,
        cached.prob,
        cached.odds,
        stake,
        ts,
      )
      const betId = Number(info.lastInsertRowid)
      db.prepare(`
        INSERT INTO ledger (user_id, type, kind, amount, balance_after, ref, created_at)
        VALUES (?, 'pm_bet', 'system', ?, ?, ?, ?)
      `).run(req.user.id, -stake, balanceAfter(db, req.user.id), `pm:${betId}`, ts)
      db.prepare('INSERT INTO feed (type, actor_id, text, ref, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('pm_bet', req.user.id, `跟系统盘对赌「${cached.eventTitle}」押「${cached.zhOutcome || cached.outcome}」`, `pm:${betId}`, ts)
      return { bet: rowToPmBet(db.prepare('SELECT * FROM pm_bets WHERE id=?').get(betId)) }
    }))
  })

  app.post('/api/v1/admin/settle/run', { preHandler: requireAdmin }, async () => {
    const result = await runSettlement(db, { fetchResult, now })
    onSettleRun?.()
    return ok(result)
  })
}
