import { apiError } from './errors.js'
import { shanghaiDay } from './time.js'

const OPEN_STATUSES = ['open', 'matched', 'consensus']

function positiveInt(value, field) {
  const out = Math.round(Number(value) || 0)
  if (!(out > 0)) throw apiError('VALIDATION', `${field} 必须大于 0`)
  return out
}

function intAmount(value) {
  const out = Math.round(Number(value) || 0)
  if (out === 0) throw apiError('VALIDATION', 'amount 不能为 0')
  return out
}

function requiredReason(value) {
  const out = String(value || '').trim()
  if (!out) throw apiError('VALIDATION', 'reason 不能为空')
  return out
}

function boundedLimit(value, fallback = 50, max = 100) {
  return Math.min(max, Math.max(1, Math.round(Number(value || fallback) || fallback)))
}

function matchRef(id) {
  return `match:${id}`
}

function balanceAfter(db, userId) {
  return db.prepare('SELECT balance FROM users WHERE id=?').get(userId).balance
}

function insertLedger(db, { userId, type, kind = 'player', amount, ref, ts, requestId, actorAdminId, reason, balanceAfterValue }) {
  db.prepare(`
    INSERT INTO ledger (user_id, type, kind, amount, balance_after, ref, actor_admin_id, reason, request_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    type,
    kind,
    amount,
    balanceAfterValue ?? balanceAfter(db, userId),
    ref || null,
    actorAdminId || null,
    reason || null,
    requestId || null,
    ts,
  )
}

function refundFrozen(db, userId, amount, ts, ref, requestId, adminId, reason) {
  if (!(amount > 0)) return
  const info = db.prepare('UPDATE users SET balance=balance+?, frozen=frozen-? WHERE id=? AND frozen>=?')
    .run(amount, amount, userId, amount)
  if (info.changes === 0) throw apiError('CONFLICT', '冻结余额不足，无法退款')
  insertLedger(db, {
    userId,
    type: 'void_refund',
    kind: 'player',
    amount: 0,
    ref,
    ts,
    requestId,
    actorAdminId: adminId,
    reason,
  })
}

function participantRefunds(db, match, deletedUserId) {
  const refunds = []
  if (match.mode === 'match') {
    if (match.owner_id !== deletedUserId) refunds.push({ userId: match.owner_id, amount: match.owner_stake || 0 })
    if (match.taker_id && match.taker_id !== deletedUserId) refunds.push({ userId: match.taker_id, amount: match.taker_stake || 0 })
    return refunds
  }
  if (match.mode === 'banker' && match.owner_id !== deletedUserId) {
    refunds.push({ userId: match.owner_id, amount: match.banker_cap || 0 })
  }
  const bets = db.prepare('SELECT user_id, stake FROM match_bets WHERE match_id=?').all(match.id)
  for (const bet of bets) {
    if (bet.user_id !== deletedUserId) refunds.push({ userId: bet.user_id, amount: bet.stake })
  }
  return refunds
}

function matchesInvolvingUser(db, userId) {
  return db.prepare(`
    SELECT DISTINCT m.*
    FROM matches m
    LEFT JOIN match_bets b ON b.match_id=m.id
    WHERE m.status IN ('open', 'matched', 'consensus')
      AND (m.owner_id=? OR m.taker_id=? OR b.user_id=?)
    ORDER BY m.id
  `).all(userId, userId, userId)
}

function assertNoDeletionResidue(db, userId, requestId) {
  const openDirect = db.prepare(`
    SELECT COUNT(*) AS n FROM matches
    WHERE (owner_id=? OR taker_id=?) AND status IN ('open', 'matched', 'consensus')
  `).get(userId, userId).n
  const openBet = db.prepare(`
    SELECT COUNT(*) AS n
    FROM match_bets b JOIN matches m ON m.id=b.match_id
    WHERE b.user_id=? AND m.status IN ('open', 'matched', 'consensus')
  `).get(userId).n
  const pendingPm = db.prepare("SELECT COUNT(*) AS n FROM pm_bets WHERE user_id=? AND status='pending'").get(userId).n
  const pendingAppeals = db.prepare("SELECT COUNT(*) AS n FROM appeals WHERE user_id=? AND status='pending'").get(userId).n
  const user = db.prepare('SELECT status, balance, frozen FROM users WHERE id=?').get(userId)
  if (openDirect || openBet || pendingPm || pendingAppeals || user?.status !== 'deleted' || user.balance !== 0 || user.frozen !== 0) {
    throw apiError('CONFLICT', '删除用户后验证失败')
  }
  const playerSum = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE kind='player' AND request_id=?").get(requestId).total
  if (playerSum !== 0) throw apiError('CONFLICT', '删除用户退款账本不守恒')
  assertGlobalConservation(db)
}

function assertGlobalConservation(db) {
  const held = db.prepare("SELECT COALESCE(SUM(balance + frozen), 0) AS total FROM users WHERE status != 'deleted'").get().total
  const issued = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE kind='system'").get().total
  if (held !== issued) throw apiError('CONFLICT', '全局守恒校验失败')
}

// §10 删人事务核心（admin 删人 + 用户自助注销共用）：
//   作废被删者未结局并全额退对手 → 作废 pending 系统盘注 → 驳回未决申诉 →
//   清零回收记 system ledger → status='deleted'(释放手机号/昵称) + token_version+1(踢下线) → 守恒校验。
// actorAdminId=null 即用户自助注销（无 admin 经手）。前置检查(admin/npc/密码)由各 route 自理。
export function performUserDeletion(db, targetId, ts, key, { actorAdminId = null, reason = '注销账号，余额冻结回收', ledgerType = 'admin_adjust' } = {}) {
  for (const match of matchesInvolvingUser(db, targetId)) {
    for (const refund of participantRefunds(db, match, targetId)) {
      refundFrozen(db, refund.userId, refund.amount, ts, matchRef(match.id), key, actorAdminId, reason)
    }
    db.prepare("UPDATE match_bets SET payout=stake WHERE match_id=? AND user_id != ? AND payout IS NULL")
      .run(match.id, targetId)
    db.prepare("UPDATE matches SET status='voided', updated_at=? WHERE id=?").run(ts, match.id)
  }
  db.prepare("UPDATE pm_bets SET status='voided', settled_at=? WHERE user_id=? AND status='pending'").run(ts, targetId)
  db.prepare(`
    UPDATE appeals
    SET status='resolved', verdict='uphold', resolved_at=?, resolved_by=?
    WHERE user_id=? AND status='pending'
  `).run(ts, actorAdminId, targetId)

  const current = db.prepare('SELECT balance, frozen FROM users WHERE id=?').get(targetId)
  const recovered = current.balance + current.frozen
  insertLedger(db, {
    userId: targetId,
    type: ledgerType, // admin 删人=admin_adjust(需带 actor)；自助注销=account_close(无 actor)
    kind: 'system',
    amount: -recovered,
    ref: `user:${targetId}:delete`,
    ts,
    requestId: key,
    actorAdminId,
    reason,
    balanceAfterValue: 0,
  })
  db.prepare(`
    UPDATE users
    SET status='deleted', deleted_at=?, token_version=token_version+1, balance=0, frozen=0
    WHERE id=?
  `).run(ts, targetId)
  assertNoDeletionResidue(db, targetId, key)
  return recovered
}

function dayStartMs(ts) {
  const day = shanghaiDay(ts)
  return new Date(`${day}T00:00:00+08:00`).getTime()
}

function retentionPercent(db, days, ts = Date.now()) {
  const today = shanghaiDay(ts)
  const row = db.prepare(`
    WITH cohort AS (
      SELECT id, date(created_at/1000,'unixepoch','+8 hours') AS reg_day
      FROM users
      WHERE is_npc=0 AND is_admin=0 -- 已删用户留在 cohort 分母（§8c Dn 定义不排除，排了会虚高漏报）
        AND date(created_at/1000,'unixepoch','+8 hours') BETWEEN date(?, ?) AND date(?, ?)
    )
    SELECT COUNT(*) AS cohort_size,
           SUM(EXISTS(
             SELECT 1 FROM activity_days a
             WHERE a.user_id=cohort.id AND a.day=date(cohort.reg_day, ?)
           )) AS retained
    FROM cohort
  `).get(today, `-${days + 6} days`, today, `-${days} days`, `+${days} days`)
  if (!row.cohort_size) return null
  return Math.round((1000 * row.retained) / row.cohort_size) / 10
}

export function maybeCreateRetentionD3Alert(db, ts = Date.now()) {
  const first = db.prepare('SELECT MIN(created_at) AS first FROM users WHERE is_admin=0 AND is_npc=0').get().first
  if (!first || ts - first < 7 * 24 * 60 * 60 * 1000) return null
  const d3 = retentionPercent(db, 3, ts)
  if (d3 == null || d3 >= 30) return null
  const start = dayStartMs(ts)
  const exists = db.prepare(`
    SELECT id FROM admin_alerts
    WHERE kind='retention_d3' AND created_at>=?
    LIMIT 1
  `).get(start)
  if (exists) return null
  db.prepare("INSERT INTO admin_alerts (level, kind, message, created_at) VALUES ('warn', 'retention_d3', ?, ?)")
    .run(`D3 留存 ${d3}%，按 v2 §2.1 该补微信播报了`, ts)
  return d3
}

function countToday(db, table, ts) {
  const start = dayStartMs(ts)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at>=?`).get(start)
  return row.n
}

function rowToUser(row) {
  return {
    id: row.id,
    name: row.name,
    balance: row.balance,
    frozen: row.frozen,
    status: row.status,
    reputation: row.reputation,
    lastActiveDay: row.last_active_day,
    mutedUntil: row.muted_until,
    createdAt: row.created_at,
  }
}

export function trafficHour(ts = Date.now()) {
  return `${new Date(ts).toISOString().slice(0, 13)}:00:00Z`
}

export function registerAdminRoutes(app, { db, requireAdmin, ok, runIdempotent, idempotencyKey, now, onlineCount, flushTraffic }) {
  app.post('/api/v1/admin/users/:id/delete', { preHandler: requireAdmin }, async (req) => {
    const ts = now()
    const targetId = positiveInt(req.params.id, 'id')
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const target = db.prepare('SELECT * FROM users WHERE id=? AND status != ?').get(targetId, 'deleted')
      if (!target) throw apiError('NOT_FOUND')
      if (target.is_admin) throw apiError('FORBIDDEN', '不能删除管理员')
      if (target.is_npc) throw apiError('FORBIDDEN', 'NPC 是系统资产，不走删人流程')
      const recovered = performUserDeletion(db, targetId, ts, key, {
        actorAdminId: req.user.id,
        reason: '删除用户，余额冻结回收',
      })
      return { userId: targetId, status: 'deleted', recovered }
    }))
  })

  app.post('/api/v1/admin/users/:id/adjust', { preHandler: requireAdmin }, async (req) => {
    const ts = now()
    const targetId = positiveInt(req.params.id, 'id')
    const amount = intAmount(req.body?.amount)
    const reason = requiredReason(req.body?.reason)
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      const target = db.prepare('SELECT id, balance FROM users WHERE id=? AND status != ?').get(targetId, 'deleted')
      if (!target) throw apiError('NOT_FOUND')
      if (target.balance + amount < 0) throw apiError('INSUFFICIENT_BALANCE')
      db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amount, targetId)
      insertLedger(db, {
        userId: targetId,
        type: 'admin_adjust',
        kind: 'system',
        amount,
        ref: `user:${targetId}:adjust`,
        ts,
        requestId: idempotencyKey(req),
        actorAdminId: req.user.id,
        reason,
      })
      assertGlobalConservation(db)
      return { userId: targetId, balance: balanceAfter(db, targetId) }
    }))
  })

  app.get('/api/v1/admin/overview', { preHandler: requireAdmin }, async () => {
    const ts = now()
    const users = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(status='banned') AS banned
      FROM users
      WHERE is_npc=0 AND status != 'deleted'
    `).get()
    const lastRun = db.prepare('SELECT * FROM settlement_runs ORDER BY started_at DESC, id DESC LIMIT 1').get()
    const alerts = db.prepare(`
      SELECT id, level, kind, message, created_at AS createdAt
      FROM admin_alerts
      WHERE read_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 10
    `).all()
    return ok({
      users: {
        total: users.total || 0,
        online: onlineCount(),
        banned: users.banned || 0,
      },
      today: {
        activeUsers: db.prepare('SELECT COUNT(*) AS n FROM activity_days WHERE day=?').get(shanghaiDay(ts)).n,
        newUsers: countToday(db, 'users', ts),
        matchesOpened: countToday(db, 'matches', ts),
        pmBets: countToday(db, 'pm_bets', ts),
      },
      retention: {
        d1: retentionPercent(db, 1, ts),
        d3: retentionPercent(db, 3, ts),
        d7: retentionPercent(db, 7, ts),
      },
      settlement: {
        lastRunAt: lastRun?.started_at || null,
        lastStatus: lastRun?.status || null,
        pendingBets: db.prepare("SELECT COUNT(*) AS n FROM pm_bets WHERE status='pending'").get().n,
      },
      alerts,
    })
  })

  app.get('/api/v1/admin/users', { preHandler: requireAdmin }, async (req) => {
    const limit = boundedLimit(req.query?.limit, 50, 200)
    const q = String(req.query?.q || '').trim()
    const rows = q
      ? db.prepare(`
          SELECT u.*, MAX(a.day) AS last_active_day
          FROM users u LEFT JOIN activity_days a ON a.user_id=u.id
          WHERE u.name LIKE ? OR u.phone LIKE ?
          GROUP BY u.id
          ORDER BY u.created_at DESC, u.id DESC
          LIMIT ?
        `).all(`%${q}%`, `%${q}%`, limit)
      : db.prepare(`
          SELECT u.*, MAX(a.day) AS last_active_day
          FROM users u LEFT JOIN activity_days a ON a.user_id=u.id
          GROUP BY u.id
          ORDER BY u.created_at DESC, u.id DESC
          LIMIT ?
        `).all(limit)
    return ok({ users: rows.map(rowToUser) })
  })

  app.get('/api/v1/admin/speech', { preHandler: requireAdmin }, async (req) => {
    const limit = boundedLimit(req.query?.limit, 50, 200)
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT c.id, 'comment' AS type, c.user_id AS userId, u.name, c.text, c.created_at AS createdAt,
               c.scope, c.ref_id AS refId, c.deleted_at AS deletedAt
        FROM comments c JOIN users u ON u.id=c.user_id
        UNION ALL
        SELECT ch.id, 'chat' AS type, ch.from_id AS userId, u.name, ch.text, ch.created_at AS createdAt,
               'chat' AS scope, CAST(ch.to_id AS TEXT) AS refId, NULL AS deletedAt
        FROM chats ch JOIN users u ON u.id=ch.from_id
      )
      ORDER BY createdAt DESC, id DESC
      LIMIT ?
    `).all(limit)
    return ok({ items: rows })
  })

  app.get('/api/v1/admin/traffic', { preHandler: requireAdmin }, async (req) => {
    flushTraffic?.() // 读之前把内存累计冲进库，admin 看到的是实时数
    const hours = Math.min(168, Math.max(1, Math.round(Number(req.query?.hours || 24) || 24)))
    const cutoff = trafficHour(now() - (hours - 1) * 60 * 60 * 1000)
    const rows = db.prepare(`
      SELECT hour, source, requests, bytes_out AS bytesOut
      FROM traffic_hourly
      WHERE hour>=?
      ORDER BY hour ASC, source ASC
    `).all(cutoff)
    return ok({ rows })
  })

  app.post('/api/v1/admin/alerts/:id/ack', { preHandler: requireAdmin }, async (req) => {
    const ts = now()
    const alertId = positiveInt(req.params.id, 'id')
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      const info = db.prepare('UPDATE admin_alerts SET read_at=? WHERE id=? AND read_at IS NULL').run(ts, alertId)
      if (info.changes === 0 && !db.prepare('SELECT id FROM admin_alerts WHERE id=?').get(alertId)) throw apiError('NOT_FOUND')
      return { id: alertId, readAt: db.prepare('SELECT read_at FROM admin_alerts WHERE id=?').get(alertId).read_at }
    }))
  })

  app.post('/api/v1/admin/users/:id/mute', { preHandler: requireAdmin }, async (req) => {
    const ts = now()
    const targetId = positiveInt(req.params.id, 'id')
    const minutes = Math.max(0, Math.round(Number(req.body?.minutes ?? req.body?.hours * 60) || 0))
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      const target = db.prepare('SELECT id FROM users WHERE id=? AND status != ?').get(targetId, 'deleted')
      if (!target) throw apiError('NOT_FOUND')
      const mutedUntil = minutes > 0 ? ts + minutes * 60 * 1000 : null
      db.prepare('UPDATE users SET muted_until=? WHERE id=?').run(mutedUntil, targetId)
      return { userId: targetId, mutedUntil }
    }))
  })

  app.post('/api/v1/admin/users/:id/unmute', { preHandler: requireAdmin }, async (req) => {
    const ts = now()
    const targetId = positiveInt(req.params.id, 'id')
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      const info = db.prepare('UPDATE users SET muted_until=NULL WHERE id=? AND status != ?').run(targetId, 'deleted')
      if (info.changes === 0) throw apiError('NOT_FOUND')
      return { userId: targetId, mutedUntil: null }
    }))
  })
}
