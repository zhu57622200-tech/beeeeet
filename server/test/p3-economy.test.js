import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { hashPassword } from '../src/auth.js'

const SECRET = 'test-secret'
const T0 = new Date('2026-06-11T01:00:00+08:00').getTime()
const DAY = 24 * 60 * 60 * 1000

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
    now(),
  )
  return Number(info.lastInsertRowid)
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
  return db.prepare('SELECT COALESCE(SUM(balance + frozen), 0) AS total FROM users').get().total
}

function ledgerId() {
  return db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM ledger').get().id
}

function systemLedgerSince(id) {
  return db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE kind='system' AND id > ?").get(id).total
}

async function expectConserved(work) {
  const beforeTotal = totals()
  const beforeLedger = ledgerId()
  const out = await work()
  expect(totals() - beforeTotal).toBe(systemLedgerSince(beforeLedger))
  return out
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

describe('P3 经济外围：转赠', () => {
  it('转赠执行三重限额，同事务写双边 player ledger 且 SUM==0', async () => {
    const fromId = seedUser('转出方')
    const toId = seedUser('转入方')
    const token = await login('转出方')

    const ok = await expectConserved(() => app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: idem(token, 'transfer-ok'),
      payload: { toUserId: toId, amount: 50_000 },
    }))
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data).toMatchObject({ amount: 50_000, toUserId: toId })
    expect(db.prepare('SELECT balance FROM users WHERE id=?').get(fromId).balance).toBe(950_000)
    expect(db.prepare('SELECT balance FROM users WHERE id=?').get(toId).balance).toBe(1_050_000)
    expect(db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE ref='transfer:1' AND kind='player'").get().total).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE ref='transfer:1' AND kind='player'").get().n).toBe(2)

    const single = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: idem(token, 'transfer-single-limit'),
      payload: { toUserId: toId, amount: 50_001 },
    })
    expect(single.statusCode).toBe(403)
    expect(single.json().code).toBe('TRANSFER_LIMITED')

    await expectConserved(() => app.inject({ method: 'POST', url: '/api/v1/transfers', headers: idem(token, 'transfer-2'), payload: { toUserId: toId, amount: 50_000 } }))
    const dailyAmount = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: idem(token, 'transfer-daily-amount'),
      payload: { toUserId: toId, amount: 1 },
    })
    expect(dailyAmount.statusCode).toBe(403)
    expect(dailyAmount.json().code).toBe('TRANSFER_LIMITED')

    const otherToken = await login('转入方')
    for (let i = 0; i < 5; i++) {
      await expectConserved(() => app.inject({
        method: 'POST',
        url: '/api/v1/transfers',
        headers: idem(otherToken, `to-many-${i}`),
        payload: { toUserId: fromId, amount: 1 },
      }))
    }
    const dailyCount = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: idem(otherToken, 'to-many-6'),
      payload: { toUserId: fromId, amount: 1 },
    })
    expect(dailyCount.statusCode).toBe(403)
    expect(dailyCount.json().code).toBe('TRANSFER_LIMITED')
  })
})

describe('P3 经济外围：签到和周补给', () => {
  it('签到按北京时间 day 幂等，连签第 7 天起发 4000', async () => {
    seedUser('签到人')
    const token = await login('签到人')
    for (let i = 0; i < 6; i++) {
      tick = i * DAY
      const res = await expectConserved(() => app.inject({ method: 'POST', url: '/api/v1/checkin', headers: auth(token) }))
      expect(res.statusCode).toBe(200)
      expect(res.json().data).toMatchObject({ amount: 2000, streak: i + 1 })
    }
    tick = 6 * DAY
    const seventh = await expectConserved(() => app.inject({ method: 'POST', url: '/api/v1/checkin', headers: auth(token) }))
    expect(seventh.statusCode).toBe(200)
    expect(seventh.json().data).toMatchObject({ amount: 4000, streak: 7 })
    const repeated = await expectConserved(() => app.inject({ method: 'POST', url: '/api/v1/checkin', headers: auth(token) }))
    expect(repeated.statusCode).toBe(200)
    expect(repeated.json().data).toMatchObject({ amount: 0, streak: 7, already: true })
    expect(db.prepare("SELECT COUNT(*) AS n FROM feed WHERE type='checkin'").get().n).toBe(1)
  })

  it('周补给复用 20000/7 天口径并落 system ledger', async () => {
    seedUser('补给人')
    const token = await login('补给人')
    const first = await expectConserved(() => app.inject({ method: 'POST', url: '/api/v1/supply/claim', headers: idem(token, 'supply-1') }))
    expect(first.statusCode).toBe(200)
    expect(first.json().data).toMatchObject({ amount: 20_000 })
    const second = await expectConserved(() => app.inject({ method: 'POST', url: '/api/v1/supply/claim', headers: idem(token, 'supply-2') }))
    expect(second.statusCode).toBe(200)
    expect(second.json().data).toMatchObject({ amount: 0, already: true })
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='grant' AND ref='weekly_supply' AND kind='system'").get().n).toBe(1)
  })
})

describe('P3 经济外围：赛季重置和举报', () => {
  it('赛季重置遇未结局拒绝，干净库重置守恒并归档冠军', async () => {
    const adminId = seedUser('群主', 1_000_000, { isAdmin: true })
    seedUser('冠军', 1_200_000)
    const playerId = seedUser('玩家', 800_000)
    const admin = await login('群主')
    db.prepare(`
      INSERT INTO matches (mode, title, option_a, option_b, status, owner_id, owner_side, odds, owner_stake, created_at, updated_at)
      VALUES ('match', '未结局', 'A', 'B', 'open', ?, 'A', 2, 100, ?, ?)
    `).run(playerId, now(), now())

    const blocked = await app.inject({ method: 'POST', url: '/api/v1/admin/season/reset', headers: idem(admin, 'season-block') })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().code).toBe('CONFLICT')

    db.prepare("UPDATE matches SET status='voided'").run()
    const reset = await expectConserved(() => app.inject({ method: 'POST', url: '/api/v1/admin/season/reset', headers: idem(admin, 'season-ok') }))
    expect(reset.statusCode).toBe(200)
    expect(reset.json().data).toMatchObject({ resetUsers: 3, championUserId: 2 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM season_archives').get().n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE balance=1000000 AND frozen=0 AND wins=0 AND losses=0 AND streak=0').get().n).toBe(3)
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='season_reset' AND kind='system' AND actor_admin_id=?").get(adminId).n).toBe(3)
  })

  it('举报仅限本局参与者互举，一局一报去重，按 store.js 口径扣信誉并发 feed', async () => {
    const reporterId = seedUser('举报人')
    const targetId = seedUser('被举报')
    seedUser('局外人')
    const [token, outsider] = await Promise.all([login('举报人'), login('局外人')])
    const info = db.prepare(`
      INSERT INTO matches (mode, title, option_a, option_b, status, owner_id, taker_id, owner_side, odds, owner_stake, taker_stake, created_at, updated_at)
      VALUES ('match', '赖账局', 'A', 'B', 'settled', ?, ?, 'A', 2, 100, 100, ?, ?)
    `).run(reporterId, targetId, now(), now())
    const matchId = Number(info.lastInsertRowid)

    // 局外人举报被拒；缺 matchId 被拒；对方非参与者被拒
    const byOutsider = await app.inject({ method: 'POST', url: '/api/v1/reports', headers: auth(outsider), payload: { targetUserId: targetId, kind: 'deadbeat', matchId } })
    expect(byOutsider.statusCode).toBe(403)
    const noMatch = await app.inject({ method: 'POST', url: '/api/v1/reports', headers: auth(token), payload: { targetUserId: targetId, kind: 'deadbeat' } })
    expect(noMatch.statusCode).toBe(400)
    const wrongTarget = await app.inject({ method: 'POST', url: '/api/v1/reports', headers: auth(token), payload: { targetUserId: 3, kind: 'deadbeat', matchId } })
    expect(wrongTarget.statusCode).toBe(400)

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: auth(token),
      payload: { targetUserId: targetId, kind: 'deadbeat', matchId },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().data.reputation).toBe(85)
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: auth(token),
      payload: { targetUserId: targetId, kind: 'deadbeat', matchId },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().data).toMatchObject({ reputation: 85, already: true })
    expect(db.prepare("SELECT COUNT(*) AS n FROM feed WHERE type='cheat'").get().n).toBe(1)
  })

  it('榜单与转赠排除 NPC；彩头操作仅限参与者', async () => {
    db.prepare(`
      INSERT INTO users (name, phone, password_hash, is_npc, balance, emoji, title, created_at)
      VALUES ('气氛组NPC', NULL, '', 1, 5_000_000, '🤖', 'NPC', ?)
    `).run(now())
    const npcId = db.prepare("SELECT id FROM users WHERE name='气氛组NPC'").get().id
    const ownerId = seedUser('彩头主')
    seedUser('路人甲')
    const [owner, stranger] = await Promise.all([login('彩头主'), login('路人甲')])

    const board = await app.inject({ method: 'GET', url: '/api/v1/leaderboards/main', headers: auth(owner) })
    expect(board.json().data.users.map((u) => u.name)).not.toContain('气氛组NPC')

    const toNpc = await app.inject({ method: 'POST', url: '/api/v1/transfers', headers: idem(owner, 'npc-tr'), payload: { toUserId: npcId, amount: 100 } })
    expect(toNpc.statusCode).toBe(404)

    const info = db.prepare(`
      INSERT INTO matches (mode, title, option_a, option_b, status, owner_id, owner_side, odds, owner_stake, side_bet_text, created_at, updated_at)
      VALUES ('match', '彩头局', 'A', 'B', 'settled', ?, 'A', 2, 100, '输的请喝奶茶', ?, ?)
    `).run(ownerId, now(), now())
    const matchId = Number(info.lastInsertRowid)
    const byStranger = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/sidebet/fulfill`, headers: auth(stranger) })
    expect(byStranger.statusCode).toBe(403)
    const byOwner = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/sidebet/fulfill`, headers: auth(owner) })
    expect(byOwner.statusCode).toBe(200)
  })
})
