import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { hashPassword } from '../src/auth.js'

const SECRET = 'test-secret'
const T0 = 1_800_000_000_000

let db
let app
let tick

function now() {
  return T0 + tick++
}

function auth(token) {
  return { authorization: `Bearer ${token}` }
}

function idem(token, key) {
  return { ...auth(token), 'x-idempotency-key': key }
}

function seedUser(name, balance = 1_000_000, opts = {}) {
  const info = db.prepare(`
    INSERT INTO users (name, phone, password_hash, is_admin, balance, emoji, title, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    opts.phone || `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    hashPassword('pass1234'),
    opts.isAdmin ? 1 : 0,
    balance,
    opts.emoji || 'x',
    opts.title || '玩家',
    opts.createdAt || now(),
  )
  const userId = Number(info.lastInsertRowid)
  db.prepare(`
    INSERT INTO ledger (user_id, type, kind, amount, balance_after, ref, created_at)
    VALUES (?, 'grant', 'system', ?, ?, 'seed', ?)
  `).run(userId, balance, balance, opts.createdAt || now())
  return userId
}

async function login(name) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { name, password: 'pass1234' },
  })
  expect(res.statusCode).toBe(200)
  return res.json().data.token
}

function totals() {
  return db.prepare("SELECT COALESCE(SUM(balance + frozen), 0) AS total FROM users WHERE status != 'deleted'").get().total
}

function systemIssued() {
  return db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE kind='system'").get().total
}

function user(id) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(id)
}

async function openMatch(token, body, key = `open-${tick}`) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/matches',
    headers: idem(token, key),
    payload: {
      title: '删人局',
      optionA: 'A队',
      optionB: 'B队',
      deadline: T0 + 60_000,
      mode: 'match',
      ownerSide: 'A',
      ownerStake: 100,
      odds: 2,
      ...body,
    },
  })
}

beforeEach(() => {
  tick = 1
  db = openDb(':memory:')
  app = buildApp({ db, jwtSecret: SECRET, now })
})

afterEach(async () => {
  await app.close()
  db.close()
})

describe('P5 admin 删除与调分', () => {
  it('删除用户会作废未结局、退对手、清零回收、踢 token 且释放昵称', async () => {
    const adminId = seedUser('群主', 1_000_000, { isAdmin: true })
    const targetId = seedUser('误入者')
    const peerId = seedUser('对手')
    const [admin, target, peer] = await Promise.all([login('群主'), login('误入者'), login('对手')])

    const opened = await openMatch(target, { ownerStake: 100, odds: 2 }, 'delete-open')
    expect(opened.statusCode).toBe(200)
    const matchId = opened.json().data.match.id
    const taken = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/take`, headers: idem(peer, 'delete-take') })
    expect(taken.statusCode).toBe(200)
    db.prepare(`
      INSERT INTO pm_bets (user_id, event_id, event_title, outcome, prob, odds, stake, created_at)
      VALUES (?, 'ev-delete', '系统盘', 'Yes', 0.5, 2, 50, ?)
    `).run(targetId, now())

    expect(user(peerId)).toMatchObject({ balance: 999_900, frozen: 100 })
    const beforeIssued = systemIssued()
    const deleted = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/delete`,
      headers: idem(admin, 'delete-user'),
    })

    expect(deleted.statusCode).toBe(200)
    expect(user(peerId)).toMatchObject({ balance: 1_000_000, frozen: 0 })
    expect(user(targetId)).toMatchObject({ status: 'deleted', balance: 0, frozen: 0, token_version: 1 })
    expect(db.prepare('SELECT status FROM matches WHERE id=?').get(matchId).status).toBe('voided')
    expect(db.prepare('SELECT status FROM pm_bets WHERE user_id=?').get(targetId).status).toBe('voided')
    expect(db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE kind='player' AND request_id='delete-user'").get().total).toBe(0)
    expect(totals()).toBe(systemIssued())
    expect(systemIssued()).toBe(beforeIssued - 1_000_000)
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='admin_adjust' AND kind='system' AND actor_admin_id=? AND user_id=?").get(adminId, targetId).n).toBe(1)

    const oldToken = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(target) })
    expect(oldToken.statusCode).toBe(401)
    db.prepare(`
      INSERT INTO invite_codes (code, max_uses, used_count, status, created_by, created_at)
      VALUES ('p5code', 5, 0, 'active', ?, ?)
    `).run(adminId, now())
    const reused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { name: '误入者', phone: '13800000001', password: 'pass1234', inviteCode: 'P5CODE', agreedTerms: true },
    })
    expect(reused.statusCode).toBe(201)

    // NPC 是系统资产，不许走删人流程
    db.prepare(`
      INSERT INTO users (name, phone, password_hash, is_npc, balance, emoji, title, created_at)
      VALUES ('气氛组', NULL, '', 1, 100, '🤖', 'NPC', ?)
    `).run(now())
    const npcId = db.prepare("SELECT id FROM users WHERE name='气氛组'").get().id
    const npcDel = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${npcId}/delete`, headers: idem(admin, 'delete-npc') })
    expect(npcDel.statusCode).toBe(403)
  })

  it('调分正负都走 system ledger，余额不足的负调被拒', async () => {
    const adminId = seedUser('调分群主', 1_000_000, { isAdmin: true })
    const targetId = seedUser('调分用户', 500)
    const admin = await login('调分群主')

    const plus = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/adjust`,
      headers: idem(admin, 'adjust-plus'),
      payload: { amount: 200, reason: '测试补偿' },
    })
    expect(plus.statusCode).toBe(200)
    expect(totals()).toBe(systemIssued())
    expect(user(targetId).balance).toBe(700)

    const minus = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/adjust`,
      headers: idem(admin, 'adjust-minus'),
      payload: { amount: -300, reason: '测试回收' },
    })
    expect(minus.statusCode).toBe(200)
    expect(totals()).toBe(systemIssued())
    expect(user(targetId).balance).toBe(400)
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='admin_adjust' AND kind='system' AND actor_admin_id=? AND user_id=?").get(adminId, targetId).n).toBe(2)

    const overdrawn = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/adjust`,
      headers: idem(admin, 'adjust-overdrawn'),
      payload: { amount: -401, reason: '测试不足' },
    })
    expect(overdrawn.statusCode).toBe(400)
    expect(overdrawn.json().code).toBe('INSUFFICIENT_BALANCE')
  })
})

describe('P5 admin 看板、流量和禁言', () => {
  it('overview/users/speech/traffic 出数且普通用户 403', async () => {
    const adminId = seedUser('看板群主', 1_000_000, { isAdmin: true })
    seedUser('看板用户')
    const [admin, normal] = await Promise.all([login('看板群主'), login('看板用户')])

    db.prepare("INSERT INTO comments (scope, ref_id, user_id, text, created_at) VALUES ('pm', 'ev1', ?, '留言', ?)").run(adminId, now())
    db.prepare("INSERT INTO chats (from_id, to_id, text, created_at) VALUES (?, ?, '私信', ?)").run(adminId, adminId, now())
    db.prepare("INSERT INTO settlement_runs (started_at, finished_at, status, scanned, settled) VALUES (?, ?, 'done', 2, 2)").run(now(), now())
    db.prepare("INSERT INTO admin_alerts (level, kind, message, created_at) VALUES ('warn', 'retention_d3', 'D3 留存 20%', ?)").run(now())

    const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: auth(admin) })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().data).toMatchObject({
      users: { total: 2, online: 1, banned: 0 },
      today: expect.objectContaining({ activeUsers: expect.any(Number), newUsers: expect.any(Number), matchesOpened: 0, pmBets: 0 }),
      settlement: { lastStatus: 'done', pendingBets: 0 },
    })
    expect(overview.json().data.alerts).toHaveLength(1)

    const users = await app.inject({ method: 'GET', url: '/api/v1/admin/users?q=看板&limit=5', headers: auth(admin) })
    expect(users.statusCode).toBe(200)
    expect(users.json().data.users.map((u) => u.name)).toContain('看板用户')

    const speech = await app.inject({ method: 'GET', url: '/api/v1/admin/speech?limit=10', headers: auth(admin) })
    expect(speech.statusCode).toBe(200)
    expect(speech.json().data.items.map((item) => item.type)).toEqual(['chat', 'comment'])

    await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(admin) })
    const traffic = await app.inject({ method: 'GET', url: '/api/v1/admin/traffic?hours=24', headers: auth(admin) })
    expect(traffic.statusCode).toBe(200)
    expect(traffic.json().data.rows.some((row) => row.source === 'api' && row.requests > 0)).toBe(true)

    const ack = await app.inject({ method: 'POST', url: '/api/v1/admin/alerts/1/ack', headers: idem(admin, 'ack-1') })
    expect(ack.statusCode).toBe(200)
    expect(db.prepare('SELECT read_at FROM admin_alerts WHERE id=1').get().read_at).toBeGreaterThan(0)

    const blocked = await app.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: auth(normal) })
    expect(blocked.statusCode).toBe(403)
  })

  it('mute 后发言被拒 MUTED，unmute 后恢复', async () => {
    const adminId = seedUser('禁言群主', 1_000_000, { isAdmin: true })
    const targetId = seedUser('话多')
    const [admin, target] = await Promise.all([login('禁言群主'), login('话多')])

    const muted = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/mute`,
      headers: idem(admin, 'mute-1'),
      payload: { minutes: 10 },
    })
    expect(muted.statusCode).toBe(200)
    expect(user(targetId).muted_until).toBeGreaterThan(T0)

    const rejected = await app.inject({ method: 'POST', url: '/api/v1/pm/ev1/comments', headers: auth(target), payload: { text: '发言' } })
    expect(rejected.statusCode).toBe(403)
    expect(rejected.json().code).toBe('MUTED')

    const unmuted = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/unmute`,
      headers: idem(admin, 'unmute-1'),
    })
    expect(unmuted.statusCode).toBe(200)
    expect(user(targetId).muted_until).toBeNull()

    const restored = await app.inject({ method: 'POST', url: '/api/v1/pm/ev1/comments', headers: auth(target), payload: { text: '恢复发言' } })
    expect(restored.statusCode).toBe(200)
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE actor_admin_id=?").get(adminId).n).toBe(0)
  })
})
