import { apiError } from './errors.js'
import { shanghaiDay } from './time.js'
import {
  applyRepPenalty,
  deadbeatBoard,
  SUPPLY_AMOUNT,
  TRANSFER_LIMIT,
  canClaimSupply,
} from '../../src/core/economy.js'

const INITIAL_BALANCE = 1_000_000
const DAILY_TRANSFER_LIMIT = 100_000
const DAILY_TRANSFER_COUNT = 5

function positiveInt(value, field) {
  const out = Math.round(Number(value) || 0)
  if (!(out > 0)) throw apiError('VALIDATION', `${field} 必须大于 0`)
  return out
}

function limited(message) {
  const err = apiError('TRANSFER_LIMITED', message)
  err.statusCode = 403
  return err
}

function shanghaiDayStart(ts) {
  return new Date(`${shanghaiDay(ts)}T00:00:00+08:00`).getTime()
}

function balanceAfter(db, userId) {
  return db.prepare('SELECT balance FROM users WHERE id=?').get(userId).balance
}

function insertLedger(db, { userId, type, kind = 'player', amount, ref, ts, requestId, actorAdminId, reason }) {
  db.prepare(`
    INSERT INTO ledger (user_id, type, kind, amount, balance_after, ref, actor_admin_id, reason, request_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, type, kind, amount, balanceAfter(db, userId), ref, actorAdminId || null, reason || null, requestId || null, ts)
}

function feed(db, type, actorId, text, ref, ts) {
  db.prepare('INSERT INTO feed (type, actor_id, text, ref, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(type, actorId || null, text, ref || null, ts)
}

function userCard(row) {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    title: row.title,
    balance: row.balance,
    frozen: row.frozen,
    wins: row.wins,
    losses: row.losses,
    streak: row.streak,
    maxStreak: row.max_streak,
    reputation: row.reputation,
    isNpc: Boolean(row.is_npc),
  }
}

function openWorkExists(db) {
  const openMatches = db.prepare("SELECT COUNT(*) AS n FROM matches WHERE status IN ('open','matched','consensus')").get().n
  const pendingAppeals = db.prepare("SELECT COUNT(*) AS n FROM appeals WHERE status='pending'").get().n
  const pendingPm = db.prepare("SELECT COUNT(*) AS n FROM pm_bets WHERE status='pending'").get().n
  return openMatches + pendingAppeals + pendingPm > 0
}

function readJson(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function participantIds(db, match) {
  const ids = new Set([match.owner_id])
  if (match.taker_id) ids.add(match.taker_id)
  for (const bet of db.prepare('SELECT user_id FROM match_bets WHERE match_id=?').all(match.id)) ids.add(bet.user_id)
  return ids
}

export function registerEconomyRoutes(app, { db, requireAuth, requireAdmin, ok, runIdempotent, idempotencyKey, now }) {
  app.post('/api/v1/transfers', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const amount = positiveInt(req.body?.amount, 'amount')
      const toUserId = positiveInt(req.body?.toUserId ?? req.body?.to_user_id, 'toUserId')
      if (toUserId === req.user.id) throw apiError('VALIDATION', '不能转给自己')
      if (amount > TRANSFER_LIMIT) throw limited(`单笔最多转 ${TRANSFER_LIMIT} 积分`)
      const toUser = db.prepare("SELECT id, name FROM users WHERE id=? AND status='approved' AND is_npc=0").get(toUserId)
      if (!toUser) throw apiError('NOT_FOUND')
      const fromUser = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id)
      if (fromUser.balance < amount) throw apiError('INSUFFICIENT_BALANCE')

      const dayStart = shanghaiDayStart(ts)
      const daily = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(-amount), 0) AS total
        FROM ledger
        WHERE user_id=? AND type='transfer_out' AND created_at >= ?
      `).get(req.user.id, dayStart)
      if (daily.count >= DAILY_TRANSFER_COUNT) throw limited(`每日最多转赠 ${DAILY_TRANSFER_COUNT} 笔`)
      if (daily.total + amount > DAILY_TRANSFER_LIMIT) throw limited(`每日最多转赠 ${DAILY_TRANSFER_LIMIT} 积分`)

      db.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(amount, req.user.id, amount)
      db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amount, toUserId)
      const transferNo = db.prepare("SELECT COUNT(*) + 1 AS n FROM feed WHERE type='transfer'").get().n
      const ref = `transfer:${transferNo}`
      insertLedger(db, { userId: req.user.id, type: 'transfer_out', amount: -amount, ref, ts, requestId: key })
      insertLedger(db, { userId: toUserId, type: 'transfer_in', amount, ref, ts, requestId: key })
      feed(db, 'transfer', req.user.id, `转赠了 ${amount.toLocaleString('en-US')} 积分给 ${toUser.name}`, ref, ts)
      return { amount, toUserId, ref }
    }))
  })

  app.post('/api/v1/checkin', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const day = shanghaiDay(ts)
    const existing = db.prepare('SELECT amount, streak FROM checkins WHERE user_id=? AND day=?').get(req.user.id, day)
    if (existing) return ok({ amount: 0, streak: existing.streak, already: true })

    const tx = db.transaction(() => {
      const again = db.prepare('SELECT amount, streak FROM checkins WHERE user_id=? AND day=?').get(req.user.id, day)
      if (again) return { amount: 0, streak: again.streak, already: true }
      const yesterday = shanghaiDay(shanghaiDayStart(ts) - 1)
      const prev = db.prepare('SELECT streak FROM checkins WHERE user_id=? AND day=?').get(req.user.id, yesterday)
      const streak = prev ? prev.streak + 1 : 1
      const amount = streak >= 7 ? 4000 : 2000
      db.prepare('INSERT INTO checkins (user_id, day, amount, streak, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, day, amount, streak, ts)
      db.prepare('UPDATE users SET balance=balance+?, checkin_streak=? WHERE id=?').run(amount, streak, req.user.id)
      insertLedger(db, { userId: req.user.id, type: 'checkin', kind: 'system', amount, ref: day, ts })
      if (streak === 7 || streak === 30) {
        feed(db, 'checkin', req.user.id, `${req.user.name} 连签 ${streak} 天`, `checkin:${day}`, ts)
      }
      return { amount, streak }
    })
    return ok(tx.immediate())
  })

  app.post('/api/v1/supply/claim', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      const user = db.prepare('SELECT last_supply_at FROM users WHERE id=?').get(req.user.id)
      if (!canClaimSupply(user.last_supply_at, ts)) return { amount: 0, already: true }
      db.prepare('UPDATE users SET balance=balance+?, last_supply_at=? WHERE id=?').run(SUPPLY_AMOUNT, ts, req.user.id)
      insertLedger(db, { userId: req.user.id, type: 'grant', kind: 'system', amount: SUPPLY_AMOUNT, ref: 'weekly_supply', ts, requestId: idempotencyKey(req) })
      feed(db, 'supply', req.user.id, `领取了本周补给 +${SUPPLY_AMOUNT.toLocaleString('en-US')} 积分`, 'weekly_supply', ts)
      return { amount: SUPPLY_AMOUNT }
    }))
  })

  app.post('/api/v1/admin/season/reset', { preHandler: requireAdmin }, async (req) => {
    const ts = now()
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      if (openWorkExists(db)) throw apiError('CONFLICT', '仍有未结局、未决申诉或待结算系统盘')
      const champion = db.prepare(`
        SELECT * FROM users
        WHERE status != 'deleted'
        ORDER BY (balance + frozen) DESC, id ASC
        LIMIT 1
      `).get()
      if (!champion) return { resetUsers: 0, championUserId: null }
      db.prepare(`
        INSERT INTO season_archives (user_id, season_start, ended_at, wins, losses, max_streak, best_win_odds, balance, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(champion.id, 0, ts, champion.wins, champion.losses, champion.max_streak, champion.best_win_odds, champion.balance + champion.frozen, ts)

      const users = db.prepare("SELECT * FROM users WHERE status != 'deleted'").all()
      for (const user of users) {
        const oldTotal = user.balance + user.frozen
        const delta = INITIAL_BALANCE - oldTotal
        db.prepare(`
          UPDATE users
          SET balance=?, frozen=0, wins=0, losses=0, streak=0, max_streak=0, best_win_odds=0, checkin_streak=0
          WHERE id=?
        `).run(INITIAL_BALANCE, user.id)
        insertLedger(db, {
          userId: user.id,
          type: 'season_reset',
          kind: 'system',
          amount: delta,
          ref: `season:${ts}`,
          ts,
          requestId: idempotencyKey(req),
          actorAdminId: req.user.id,
          reason: '赛季重置',
        })
      }
      feed(db, 'season', req.user.id, '开启新赛季，积分和战绩已重置', `season:${ts}`, ts)
      return { resetUsers: users.length, championUserId: champion.id }
    }))
  })

  app.post('/api/v1/reports', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const targetUserId = positiveInt(req.body?.targetUserId ?? req.body?.target_user_id, 'targetUserId')
    const kind = String(req.body?.kind || '').trim()
    // 举报必须挂在具体局上，且举报人和被举报人都是该局参与者——否则任何人可凭空刷低他人信誉
    const matchId = positiveInt(req.body?.matchId ?? req.body?.match_id, 'matchId')
    const target = db.prepare("SELECT id, name, reputation FROM users WHERE id=? AND status='approved'").get(targetUserId)
    if (!target) throw apiError('NOT_FOUND')
    if (!['delay', 'misjudge', 'litigation', 'deadbeat'].includes(kind)) throw apiError('VALIDATION', 'kind 参数不合法')
    const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId)
    if (!match) throw apiError('NOT_FOUND')
    const isParticipant = (uid) => match.owner_id === uid || match.taker_id === uid
      || Boolean(db.prepare('SELECT id FROM match_bets WHERE match_id=? AND user_id=?').get(match.id, uid))
    if (!isParticipant(req.user.id)) throw apiError('FORBIDDEN', '只有本局参与者可举报')
    if (!isParticipant(targetUserId)) throw apiError('VALIDATION', '对方不是本局参与者')
    const ref = `report:${matchId}:${targetUserId}`
    if (db.prepare("SELECT id FROM feed WHERE type='cheat' AND actor_id=? AND ref=?").get(req.user.id, ref)) {
      return ok({ targetUserId, reputation: target.reputation, already: true })
    }
    const reputation = applyRepPenalty(target.reputation, kind)
    db.prepare('UPDATE users SET reputation=? WHERE id=?').run(reputation, targetUserId)
    feed(db, 'cheat', req.user.id, `举报 ${target.name} 耍赖，信誉降至 ${reputation}`, ref, ts)
    return ok({ targetUserId, reputation })
  })

  app.get('/api/v1/leaderboards/main', { preHandler: requireAuth }, async () => {
    // 爹地红线：NPC 不进真实榜（展示位走 /users 列表，不混榜单）
    const users = db.prepare(`
      SELECT * FROM users
      WHERE status='approved' AND is_npc=0
      ORDER BY (balance + frozen) DESC, id ASC
    `).all().map(userCard)
    return ok({ users })
  })

  app.get('/api/v1/leaderboards/deadbeat', { preHandler: requireAuth }, async (req) => {
    const players = db.prepare("SELECT *, id AS id FROM users WHERE status='approved' AND is_npc=0").all()
      .map((u) => ({ ...userCard(u), isMe: u.id === req.user?.id }))
    return ok(deadbeatBoard({ players }))
  })

  app.get('/api/v1/me/rivals', { preHandler: requireAuth }, async (req) => {
    const rows = db.prepare(`
      SELECT * FROM matches
      WHERE mode='match' AND status='settled' AND result IS NOT NULL
        AND (owner_id=? OR taker_id=?)
      ORDER BY settled_at DESC, id DESC
    `).all(req.user.id, req.user.id)
    const byUser = new Map()
    for (const match of rows) {
      if (!match.taker_id) continue
      const iAmOwner = match.owner_id === req.user.id
      const rivalId = iAmOwner ? match.taker_id : match.owner_id
      const ownerWon = match.result === match.owner_side
      const iWon = iAmOwner ? ownerWon : !ownerWon
      if (!byUser.has(rivalId)) byUser.set(rivalId, { wins: 0, losses: 0, history: [] })
      const item = byUser.get(rivalId)
      if (iWon) item.wins += 1
      else item.losses += 1
      item.history.push({ matchId: match.id, title: match.title, result: match.result, won: iWon, settledAt: match.settled_at })
    }
    const rivals = []
    for (const [id, record] of byUser.entries()) {
      const user = db.prepare('SELECT id, name, emoji FROM users WHERE id=?').get(id)
      if (!user) continue
      rivals.push({
        id,
        name: user.name,
        emoji: user.emoji,
        wins: record.wins,
        losses: record.losses,
        total: record.wins + record.losses,
        lead: record.wins - record.losses,
        history: record.history,
      })
    }
    rivals.sort((a, b) => b.total - a.total)
    return ok({ rivals })
  })

  app.get('/api/v1/matches/:id/arbiter-candidates', { preHandler: requireAuth }, async (req) => {
    const match = db.prepare('SELECT * FROM matches WHERE id=?').get(Number(req.params.id))
    if (!match) throw apiError('NOT_FOUND')
    const excluded = participantIds(db, match)
    const candidates = db.prepare("SELECT id, name, emoji, title FROM users WHERE status='approved' AND is_npc=0 ORDER BY name").all()
      .filter((user) => !excluded.has(user.id))
    return ok({ candidates, consensus: readJson(match.consensus, null) })
  })
}
