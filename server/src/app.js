import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import cron from 'node-cron'
import bcrypt from 'bcrypt'
import { apiError, ApiError, errorBody } from './errors.js'
import {
  generateResetCode,
  hashPassword,
  normalizeResetCode,
  signToken,
  verifyPassword,
  verifyToken,
} from './auth.js'
import { shanghaiDay } from './time.js'
import { matchesForUser, registerMatchRoutes, sweepExpiredMatches } from './matches.js'
import { pmBetsForUser, registerPmRoutes } from './pm.js'
import { registerEconomyRoutes } from './economy.js'
import { registerSocialRoutes } from './social.js'
import { fetchPmResultById } from './pm-result.js'
import { runSettlement } from './settle.js'
import { maybeCreateRetentionD3Alert, performUserDeletion, registerAdminRoutes, trafficHour } from './admin.js'

const INITIAL_BALANCE = 1_000_000
const RESET_TTL_MS = 24 * 60 * 60 * 1000
const LOGIN_ACCOUNT_LIMIT = { limit: 5, windowMs: 60 * 1000 } // 单账号防爆破：5次/分（保持严）
const LOGIN_IP_LIMIT = { limit: 60, windowMs: 60 * 1000 } // 同出口IP多人登录放宽：60次/分
// 注册按 IP 放宽：熟人圈一群人常同 WiFi（同公网IP）扫码注册；真正的闸门是团码满 50。
const REGISTER_IP_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 }

function ok(data) {
  return { ok: true, data }
}

function normalizeInviteCode(code) {
  // 团码大小写不敏感：统一转小写存储+比对（团码对外显示为小写 beeeeet）
  return String(code || '').trim().toLowerCase()
}

function requireString(value, field, min = 1) {
  const out = String(value || '').trim()
  if (out.length < min) throw apiError('VALIDATION', `${field} 参数不合法`)
  return out
}

function requirePassword(value) {
  const out = String(value || '')
  if (out.length < 6) throw apiError('VALIDATION', '密码至少 6 位')
  return out
}

function requirePhone(value) {
  const out = String(value || '').trim()
  if (!/^1\d{10}$/.test(out)) throw apiError('VALIDATION', '手机号必须是 11 位中国手机号')
  return out
}

function rowToMe(row) {
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
    bestWinOdds: row.best_win_odds,
    reputation: row.reputation,
    privacy: row.privacy,
    checkinStreak: row.checkin_streak,
    canCheckin: true,
    canSupply: row.last_supply_at == null || Date.now() - row.last_supply_at >= 7 * 24 * 60 * 60 * 1000,
    supplyCountdownMs: row.last_supply_at == null ? 0 : Math.max(0, 7 * 24 * 60 * 60 * 1000 - (Date.now() - row.last_supply_at)),
    isAdmin: Boolean(row.is_admin),
  }
}

function sqliteCodeToApi(err) {
  const msg = String(err?.message || '')
  if (msg.includes('idx_users_name_alive') || msg.includes('users.name')) return apiError('NAME_TAKEN')
  if (msg.includes('idx_users_phone_alive') || msg.includes('users.phone')) return apiError('PHONE_TAKEN')
  if (msg.includes('SQLITE_BUSY')) return apiError('SERVER_BUSY')
  return err
}

function makeLimiter() {
  const buckets = new Map()
  return function assertLimit(key, { limit, windowMs }) {
    const ts = Date.now()
    const prev = buckets.get(key) || []
    const hits = prev.filter((hit) => ts - hit < windowMs)
    if (hits.length >= limit) throw apiError('RATE_LIMITED')
    hits.push(ts)
    buckets.set(key, hits)
  }
}

function idempotencyKey(req) {
  return String(req.headers['x-idempotency-key'] || '').trim()
}

function parseStoredResponse(row) {
  const stored = JSON.parse(row.response_json)
  return { ...stored, replayed: true }
}

function runIdempotent(db, userId, key, ts, work) {
  if (!key) throw apiError('VALIDATION', '缺少 X-Idempotency-Key')
  const stored = db.prepare('SELECT response_json FROM idempotency_keys WHERE user_id=? AND key=?').get(userId, key)
  if (stored) return parseStoredResponse(stored)
  const tx = db.transaction(() => {
    // 事务内二次核对：并发同 key 重放时第二个写者在此命中存量，返回 replayed 而非撞唯一约束
    const inTx = db.prepare('SELECT response_json FROM idempotency_keys WHERE user_id=? AND key=?').get(userId, key)
    if (inTx) return parseStoredResponse(inTx)
    const response = work()
    db.prepare('INSERT INTO idempotency_keys (user_id, key, response_json, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, key, JSON.stringify(response), ts)
    return response
  })
  return tx.immediate()
}

function settleLockPath() {
  return process.env.SETTLE_LOCK_PATH || path.resolve(process.cwd(), 'settle.lock')
}

function pidAlive(pid) {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireSettleLock(filePath = settleLockPath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    const fd = fs.openSync(filePath, 'wx')
    fs.writeFileSync(fd, `${process.pid}\n`)
    fs.closeSync(fd)
    return filePath
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err
    const pid = Number(String(fs.readFileSync(filePath, 'utf8')).trim())
    if (pidAlive(pid)) return null
    fs.unlinkSync(filePath)
    const fd = fs.openSync(filePath, 'wx')
    fs.writeFileSync(fd, `${process.pid}\n`)
    fs.closeSync(fd)
    return filePath
  }
}

function storeOptionalIdempotency(db, userId, key, ts, response) {
  if (!key) return
  db.prepare('INSERT INTO idempotency_keys (user_id, key, response_json, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, key, JSON.stringify(response), ts)
}

function activityHeartbeat(db, userId, ts) {
  db.prepare('INSERT OR IGNORE INTO activity_days (user_id, day) VALUES (?, ?)')
    .run(userId, shanghaiDay(ts))
}

function issueTokenAndMe(db, userId, jwtSecret, ts) {
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(userId)
  return { token: signToken(row, jwtSecret, ts), me: rowToMe(row) }
}

export function buildApp({
  db,
  jwtSecret = 'dev-only-change-me',
  now = () => Date.now(),
  enableCron = false,
  settlementFetchResult = fetchPmResultById,
} = {}) {
  // trustProxy：经 nginx 反代后从 X-Forwarded-For 解析真实客户端 IP。
  // 不开的话 req.ip 全是 nginx 回环 127.0.0.1 → 所有用户共用一个限流桶 → 注册超 10 次后全员被拦。
  const app = Fastify({ logger: false, trustProxy: true })
  const assertLimit = makeLimiter()
  const presence = new Map()
  let lastSettleRunAt = null

  app.decorate('db', db)

  app.setErrorHandler((err, req, reply) => {
    const mapped = err instanceof ApiError ? err : sqliteCodeToApi(err)
    const body = errorBody(mapped)
    if (mapped?.code === 'RATE_LIMITED') reply.header('Retry-After', '60') // 规格 §4：限流必带 Retry-After
    reply.code(mapped?.statusCode || 503).send(body)
  })

  async function requireAuth(req) {
    const header = String(req.headers.authorization || '')
    if (!header.startsWith('Bearer ')) throw apiError('AUTH_REQUIRED')
    let payload
    try {
      payload = verifyToken(header.slice(7), jwtSecret)
    } catch (err) {
      if (err?.name === 'TokenExpiredError') throw apiError('AUTH_EXPIRED')
      throw apiError('AUTH_REQUIRED')
    }
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid)
    if (!user || user.status === 'deleted') throw apiError('AUTH_EXPIRED')
    if (user.token_version !== payload.tv) throw apiError('AUTH_EXPIRED')
    if (user.status === 'banned') throw apiError('BANNED')
    req.user = user
    const ts = now()
    presence.set(user.id, ts)
    activityHeartbeat(db, user.id, ts)
  }

  async function requireAdmin(req) {
    await requireAuth(req)
    if (!req.user.is_admin) throw apiError('FORBIDDEN')
  }

  function onlineCount() {
    const cutoff = now() - 5 * 60 * 1000
    for (const [uid, lastSeen] of presence) if (lastSeen < cutoff) presence.delete(uid)
    let count = 0
    for (const uid of presence.keys()) {
      const row = db.prepare("SELECT is_npc FROM users WHERE id=? AND status='approved'").get(uid)
      if (row && !row.is_npc) count += 1
    }
    return count
  }

  // 流量采集走内存累计（§11b：不许每请求同步写库），跨小时或攒满 50 次才 flush 一行
  const trafficAcc = { hour: null, requests: 0, bytes: 0 }
  function flushTraffic() {
    if (!trafficAcc.hour || trafficAcc.requests === 0) return
    db.prepare(`
      INSERT INTO traffic_hourly (hour, source, requests, bytes_out)
      VALUES (?, 'api', ?, ?)
      ON CONFLICT(hour, source) DO UPDATE SET
        requests = requests + excluded.requests,
        bytes_out = bytes_out + excluded.bytes_out
    `).run(trafficAcc.hour, trafficAcc.requests, trafficAcc.bytes)
    trafficAcc.requests = 0
    trafficAcc.bytes = 0
  }
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/healthz' || req.user?.is_npc) return
    const hour = trafficHour(now())
    if (trafficAcc.hour !== hour) {
      flushTraffic()
      trafficAcc.hour = hour
    }
    trafficAcc.requests += 1
    trafficAcc.bytes += Number(reply.getHeader('content-length') || 0) || 0
    if (trafficAcc.requests >= 50) flushTraffic()
  })
  app.addHook('onClose', async () => flushTraffic())

  app.get('/healthz', async () => {
    db.prepare('SELECT 1').get()
    return { ok: true, db: true, lastSettleRunAt }
  })

  app.post('/api/v1/auth/register', async (req, reply) => {
    const ts = now()
    assertLimit(`register:ip:${req.ip}`, REGISTER_IP_LIMIT)
    const name = requireString(req.body?.name, 'name')
    const password = requirePassword(req.body?.password)
    const phone = requirePhone(req.body?.phone)
    const emoji = requireString(req.body?.emoji || '🫵', 'emoji')
    const note = String(req.body?.note || '').trim()
    const inviteCode = normalizeInviteCode(req.body?.inviteCode)
    if (!req.body?.agreedTerms) throw apiError('VALIDATION', '必须同意规则')
    if (!inviteCode) throw apiError('INVITE_INVALID')

    let payload
    try {
      const registerTx = db.transaction(() => {
        if (db.prepare('SELECT id FROM users WHERE name=? AND status != ?').get(name, 'deleted')) throw apiError('NAME_TAKEN')
        if (db.prepare('SELECT id FROM users WHERE phone=? AND status != ?').get(phone, 'deleted')) throw apiError('PHONE_TAKEN')

        const updated = db.prepare(`
          UPDATE invite_codes SET used_count = used_count + 1
          WHERE code = ? AND status = 'active' AND used_count < max_uses
        `).run(inviteCode)
        if (updated.changes === 0) {
          const codeRow = db.prepare('SELECT status, used_count, max_uses FROM invite_codes WHERE code=?').get(inviteCode)
          if (codeRow?.status === 'active') throw apiError('INVITE_FULL')
          throw apiError('INVITE_INVALID')
        }
        const codeRow = db.prepare('SELECT id FROM invite_codes WHERE code=?').get(inviteCode)
        const info = db.prepare(`
          INSERT INTO users (name, phone, password_hash, note, balance, emoji, invite_code_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(name, phone, hashPassword(password), note, INITIAL_BALANCE, emoji, codeRow.id, ts)
        const userId = Number(info.lastInsertRowid)
        db.prepare(`
          INSERT INTO ledger (user_id, type, kind, amount, balance_after, ref, created_at)
          VALUES (?, 'grant', 'system', ?, ?, 'signup', ?)
        `).run(userId, INITIAL_BALANCE, INITIAL_BALANCE, ts)

        const peers = db.prepare('SELECT id FROM users WHERE id != ? AND status != ?').all(userId, 'deleted')
        const addFriend = db.prepare(`
          INSERT OR IGNORE INTO friendships (user_a, user_b, status, created_at, accepted_at)
          VALUES (?, ?, 'accepted', ?, ?)
        `)
        for (const peer of peers) addFriend.run(userId, peer.id, ts, ts)

        const created = db.prepare('SELECT * FROM users WHERE id=?').get(userId)
        return { token: signToken(created, jwtSecret, ts), me: rowToMe(created) }
      })
      payload = registerTx.immediate()
    } catch (err) {
      throw sqliteCodeToApi(err)
    }

    reply.code(201).send(ok(payload))
  })

  app.post('/api/v1/auth/login', async (req) => {
    assertLimit(`login:ip:${req.ip}`, LOGIN_IP_LIMIT)
    const name = requireString(req.body?.name, 'name')
    assertLimit(`login:name:${name}`, LOGIN_ACCOUNT_LIMIT)
    const password = String(req.body?.password || '')
    const user = db.prepare('SELECT * FROM users WHERE name=? AND status != ?').get(name, 'deleted')
    if (!user || user.is_npc || !verifyPassword(password, user.password_hash)) throw apiError('BAD_CREDENTIALS')
    if (user.status === 'banned') throw apiError('BANNED')
    return ok({ token: signToken(user, jwtSecret, now()), me: rowToMe(user) })
  })

  app.post('/api/v1/auth/change-password', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    assertLimit(`chpwd:user:${req.user.id}`, LOGIN_ACCOUNT_LIMIT) // 防 token 泄露后爆破旧密码
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)
      if (!verifyPassword(String(req.body?.oldPassword || ''), user.password_hash)) throw apiError('BAD_CREDENTIALS')
      db.prepare('UPDATE users SET password_hash=?, token_version=token_version+1 WHERE id=?')
        .run(hashPassword(requirePassword(req.body?.newPassword)), user.id)
      const updated = db.prepare('SELECT * FROM users WHERE id=?').get(user.id)
      return { token: signToken(updated, jwtSecret, ts) }
    }))
  })

  // 自助找回：验证「昵称 + 手机号」匹配同一账号 → 当场重设新密码并登录（密码哈希存储，
  // 取不出原明文，故为"重设"而非"找回"；token_version+1 即时踢其他设备，防熟人知道昵称手机号后冒用）。
  app.post('/api/v1/auth/recover', async (req) => {
    const ts = now()
    assertLimit(`recover:ip:${req.ip}`, REGISTER_IP_LIMIT)
    const name = requireString(req.body?.name, 'name')
    const phone = requirePhone(req.body?.phone)
    const newPassword = requirePassword(req.body?.newPassword)
    assertLimit(`recover:name:${name}`, LOGIN_ACCOUNT_LIMIT)
    const user = db.prepare("SELECT * FROM users WHERE name=? AND phone=? AND status='approved'").get(name, phone)
    if (!user || user.is_npc) throw apiError('BAD_CREDENTIALS', '昵称和手机号对不上')
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, user.id, key, ts, () => {
      db.prepare('UPDATE users SET password_hash=?, token_version=token_version+1 WHERE id=?')
        .run(hashPassword(newPassword), user.id)
      return issueTokenAndMe(db, user.id, jwtSecret, ts)
    }))
  })

  // 自助注销：密码确认 → §10 删人事务（清账号/退对手/释放手机号昵称/踢下线）。
  // 注销后 status='deleted'，手机号与昵称的部分唯一索引(status != 'deleted')自动释放，可用原号重注册。
  app.post('/api/v1/account/delete', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    assertLimit(`acctdel:user:${req.user.id}`, LOGIN_ACCOUNT_LIMIT) // 防 token 泄露后爆破密码触发注销
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)
      if (user.is_admin) throw apiError('FORBIDDEN', '管理员账号不能自助注销')
      if (!verifyPassword(String(req.body?.password || ''), user.password_hash)) throw apiError('BAD_CREDENTIALS')
      const recovered = performUserDeletion(db, user.id, ts, key, {
        actorAdminId: null,
        reason: '用户自助注销，余额冻结回收',
        ledgerType: 'account_close',
      })
      return { status: 'deleted', recovered }
    }))
  })

  app.get('/api/v1/me', { preHandler: requireAuth }, async (req) => ok({
    me: rowToMe(req.user),
    pmBets: pmBetsForUser(db, req.user.id),
    myMatches: matchesForUser(db, req.user.id),
  }))

  app.patch('/api/v1/me', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const work = () => {
      const fields = []
      const values = []
      if (req.body?.emoji != null) {
        fields.push('emoji=?')
        values.push(requireString(req.body.emoji, 'emoji'))
      }
      if (req.body?.privacy != null) {
        const privacy = Number(req.body.privacy) ? 1 : 0
        fields.push('privacy=?')
        values.push(privacy)
      }
      if (fields.length === 0) throw apiError('VALIDATION', '没有可更新字段')
      values.push(req.user.id)
      db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id=?`).run(...values)
      return { me: rowToMe(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) }
    }
    const key = idempotencyKey(req)
    return ok(key ? runIdempotent(db, req.user.id, key, ts, work) : work())
  })

  app.post('/api/v1/admin/users/:id/reset-code', { preHandler: requireAdmin }, async (req) => {
    const ts = now()
    const targetId = Number(req.params.id)
    const target = db.prepare('SELECT id FROM users WHERE id=? AND status != ?').get(targetId, 'deleted')
    if (!target) throw apiError('NOT_FOUND')
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      const code = generateResetCode()
      db.prepare('UPDATE reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL').run(ts, targetId)
      db.prepare(`
        INSERT INTO reset_tokens (user_id, code_hash, expires_at, created_by, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(targetId, bcrypt.hashSync(normalizeResetCode(code), 10), ts + RESET_TTL_MS, req.user.id, ts)
      return { code }
    }))
  })

  app.post('/api/v1/auth/reset-password', async (req) => {
    const ts = now()
    assertLimit(`reset:ip:${req.ip}`, REGISTER_IP_LIMIT)
    const name = requireString(req.body?.name, 'name')
    const newPassword = requirePassword(req.body?.newPassword)
    const normalizedCode = normalizeResetCode(req.body?.code)
    const user = db.prepare('SELECT * FROM users WHERE name=? AND status != ?').get(name, 'deleted')
    if (!user || user.is_npc) throw apiError('RESET_CODE_INVALID')
    const key = idempotencyKey(req)
    const stored = key ? db.prepare('SELECT response_json FROM idempotency_keys WHERE user_id=? AND key=?').get(user.id, key) : null
    if (stored) return ok(parseStoredResponse(stored))

    const resetTx = db.transaction(() => {
      const tokenRow = db.prepare(`
        SELECT * FROM reset_tokens
        WHERE user_id=? AND used_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(user.id)
      if (!tokenRow || tokenRow.expires_at < ts || !bcrypt.compareSync(normalizedCode, tokenRow.code_hash)) {
        throw apiError('RESET_CODE_INVALID')
      }
      db.prepare('UPDATE reset_tokens SET used_at=? WHERE id=?').run(ts, tokenRow.id)
      db.prepare('UPDATE users SET password_hash=?, token_version=token_version+1 WHERE id=?')
        .run(hashPassword(newPassword), user.id)
      const payload = issueTokenAndMe(db, user.id, jwtSecret, ts)
      storeOptionalIdempotency(db, user.id, key, ts, payload)
      return payload
    })
    const response = resetTx.immediate()
    return ok(response)
  })

  app.post('/api/v1/admin/users/:id/ban', { preHandler: requireAdmin }, async (req) => {
    const ts = now()
    const targetId = Number(req.params.id)
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      const info = db.prepare(`
        UPDATE users SET status='banned', banned_at=?, token_version=token_version+1
        WHERE id=? AND status != 'deleted'
      `).run(ts, targetId)
      if (info.changes === 0) throw apiError('NOT_FOUND')
      return { userId: targetId, status: 'banned' }
    }))
  })

  app.post('/api/v1/admin/users/:id/unban', { preHandler: requireAdmin }, async (req) => {
    const ts = now()
    const targetId = Number(req.params.id)
    return ok(runIdempotent(db, req.user.id, idempotencyKey(req), ts, () => {
      const info = db.prepare(`
        UPDATE users SET status='approved', banned_at=NULL, token_version=token_version+1
        WHERE id=? AND status='banned'
      `).run(targetId)
      if (info.changes === 0) throw apiError('NOT_FOUND')
      return { userId: targetId, status: 'approved' }
    }))
  })

  app.get('/api/v1/sync', { preHandler: requireAuth }, async (req) => {
    const since = Math.max(0, Number(req.query?.since || 0) || 0)
    const ts = now()
    const feed = db.prepare(`
      SELECT id, type, actor_id AS actorId, target_user_id AS targetUserId, text, ref, created_at AS createdAt
      FROM feed
      WHERE id > ? AND (target_user_id IS NULL OR target_user_id = ?)
      ORDER BY id DESC
      LIMIT 50
    `).all(since, req.user.id)
    const cursorRow = db.prepare('SELECT COALESCE(MAX(id), ?) AS cursor FROM feed').get(since)
    const unread = db.prepare(`
      SELECT COUNT(*) AS n FROM feed
      WHERE id > ?
        AND (target_user_id IS NULL OR target_user_id = ?)
        AND (actor_id IS NULL OR actor_id != ?)
    `).get(since, req.user.id, req.user.id).n
    const unreadChats = db.prepare('SELECT COUNT(*) AS n FROM chats WHERE to_id=? AND read_at IS NULL').get(req.user.id).n
    const friendRequests = db.prepare("SELECT COUNT(*) AS n FROM friendships WHERE user_b=? AND status='requested'").get(req.user.id).n
    const announcement = db.prepare(`
      SELECT id, text FROM announcements
      WHERE expires_at IS NULL OR expires_at > ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(ts) || null
    return ok({
      now: ts,
      onlineCount: onlineCount(),
      feed,
      cursor: cursorRow.cursor,
      me: { balance: req.user.balance, frozen: req.user.frozen, unread, unreadChats, friendRequests },
      pmBets: pmBetsForUser(db, req.user.id),
      myMatches: matchesForUser(db, req.user.id),
      banner: { newMarketsToday: 0 },
      announcement,
    })
  })

  registerEconomyRoutes(app, { db, requireAuth, requireAdmin, ok, runIdempotent, idempotencyKey, now })
  registerSocialRoutes(app, { db, requireAuth, ok, now })
  registerMatchRoutes(app, { db, requireAuth, requireAdmin, ok, runIdempotent, idempotencyKey, now })
  registerAdminRoutes(app, { db, requireAdmin, ok, runIdempotent, idempotencyKey, now, onlineCount, flushTraffic })
  registerPmRoutes(app, {
    db,
    requireAuth,
    requireAdmin,
    ok,
    runIdempotent,
    idempotencyKey,
    now,
    fetchResult: settlementFetchResult,
    onSettleRun: () => { lastSettleRunAt = now() },
  })

  if (enableCron) {
    const lockedPath = acquireSettleLock()
    if (lockedPath) {
      const settleTask = cron.schedule('*/15 * * * *', async () => {
        const ts = now()
        try {
          sweepExpiredMatches(db, ts)
          await runSettlement(db, { fetchResult: settlementFetchResult, now })
          lastSettleRunAt = now()
        } catch (err) {
          db.prepare("INSERT INTO admin_alerts (level, kind, message, created_at) VALUES ('critical', 'cron_fail', ?, ?)")
            .run(`系统盘结算 cron 失败：${String(err?.message || err)}`, now())
        }
      })
      app.addHook('onClose', async () => {
        settleTask.stop()
        try {
          if (fs.existsSync(lockedPath) && Number(String(fs.readFileSync(lockedPath, 'utf8')).trim()) === process.pid) {
            fs.unlinkSync(lockedPath)
          }
        } catch {
          // 关闭期清锁失败不影响进程退出；下次启动会做 PID 检活。
        }
      })
    }

    cron.schedule('17 3 * * *', () => {
      // 每日清理与结算无关，不碰 lastSettleRunAt——否则会掩盖结算 cron 卡死
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff)
      db.prepare('DELETE FROM feed WHERE id NOT IN (SELECT id FROM feed ORDER BY id DESC LIMIT 500)').run()
      maybeCreateRetentionD3Alert(db, now())
    })
  }

  return app
}
