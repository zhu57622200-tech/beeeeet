import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { hashPassword } from '../src/auth.js'
import { migrate } from '../src/schema.js'

const SECRET = 'test-secret'

let db
let app

function seedAdminAndInvite({ code = 'P0CODE', maxUses = 50 } = {}) {
  const now = Date.now()
  const adminInfo = db.prepare(`
    INSERT INTO users (name, phone, password_hash, is_admin, balance, emoji, title, created_at)
    VALUES ('admin', '13900000000', ?, 1, 1000000, '👑', '群主', ?)
  `).run(hashPassword('adminpass'), now)
  const adminId = Number(adminInfo.lastInsertRowid)
  // admin 的初始余额必须有对应 system ledger，否则全局守恒(held==system ledger)不平，
  // 注销/删人事务里的守恒校验会误报（生产 bootstrap 给 admin 发金时已记此账）。
  db.prepare(`
    INSERT INTO ledger (user_id, type, kind, amount, balance_after, created_at)
    VALUES (?, 'grant', 'system', 1000000, 1000000, ?)
  `).run(adminId, now)
  db.prepare(`
    INSERT INTO invite_codes (code, max_uses, used_count, status, created_by, created_at)
    VALUES (?, ?, 0, 'active', ?, ?)
  `).run(code.toLowerCase(), maxUses, adminId, now)
  return adminId
}

async function registerUser(name, phone, inviteCode = 'P0CODE') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      name,
      password: 'pass1234',
      phone,
      emoji: '🫵',
      note: '',
      inviteCode,
      agreedTerms: true,
    },
  })
}

async function login(name = 'admin', password = 'adminpass') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { name, password },
  })
  expect(res.statusCode).toBe(200)
  return res.json().data.token
}

function auth(token) {
  return { authorization: `Bearer ${token}` }
}

beforeEach(() => {
  db = openDb(':memory:')
  app = buildApp({ db, jwtSecret: SECRET })
})

afterEach(async () => {
  await app.close()
  db.close()
})

describe('P0 后端：团码事务', () => {
  it('两个注册抢最后一个名额只成功一个，注册发积分落 system ledger', async () => {
    seedAdminAndInvite({ code: 'LASTONE', maxUses: 1 })
    const [a, b] = await Promise.all([
      registerUser('甲', '13800000001', 'LASTONE'),
      registerUser('乙', '13800000002', 'LASTONE'),
    ])
    const statuses = [a.statusCode, b.statusCode].sort()
    expect(statuses).toEqual([201, 400])
    const failed = [a, b].find((res) => res.statusCode !== 201).json()
    expect(failed).toMatchObject({ ok: false, code: 'INVITE_FULL' })
    expect(db.prepare('SELECT used_count FROM invite_codes WHERE code=?').get('lastone').used_count).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin=0 AND is_npc=0").get().n).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='grant' AND kind='system' AND amount=1000000 AND user_id IN (SELECT id FROM users WHERE is_admin=0)").get().n).toBe(1)
  })
})

describe('P0 后端：JWT 失效矩阵', () => {
  it('改密后旧 token 全 401，新 token 可用', async () => {
    seedAdminAndInvite()
    const reg = await registerUser('改密用户', '13800000011')
    const oldToken = reg.json().data.token
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { ...auth(oldToken), 'x-idempotency-key': 'change-password-1' },
      payload: { oldPassword: 'pass1234', newPassword: 'newpass123' },
    })
    expect(changed.statusCode).toBe(200)
    const oldMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(oldToken) })
    expect(oldMe.statusCode).toBe(401)
    expect(oldMe.json().code).toBe('AUTH_EXPIRED')
    const newMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(changed.json().data.token) })
    expect(newMe.statusCode).toBe(200)
  })

  it('封禁后旧 token 全 401', async () => {
    seedAdminAndInvite()
    const reg = await registerUser('封禁用户', '13800000012')
    const userId = reg.json().data.me.id
    const oldToken = reg.json().data.token
    const adminToken = await login()
    const ban = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${userId}/ban`,
      headers: { ...auth(adminToken), 'x-idempotency-key': 'ban-user-1' },
    })
    expect(ban.statusCode).toBe(200)
    const oldMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(oldToken) })
    expect(oldMe.statusCode).toBe(401)
    expect(oldMe.json().code).toBe('AUTH_EXPIRED')
  })

  it('重置密码后旧 token 全 401，新 token 可用，重置码一次性', async () => {
    seedAdminAndInvite()
    const reg = await registerUser('重置用户', '13800000013')
    const userId = reg.json().data.me.id
    const oldToken = reg.json().data.token
    const adminToken = await login()
    const codeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${userId}/reset-code`,
      headers: { ...auth(adminToken), 'x-idempotency-key': 'reset-code-1' },
    })
    expect(codeRes.statusCode).toBe(200)
    const code = codeRes.json().data.code
    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: { 'x-idempotency-key': 'reset-password-1' },
      payload: { name: '重置用户', code, newPassword: 'resetpass123' },
    })
    expect(reset.statusCode).toBe(200)
    const oldMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(oldToken) })
    expect(oldMe.statusCode).toBe(401)
    expect(oldMe.json().code).toBe('AUTH_EXPIRED')
    const newMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(reset.json().data.token) })
    expect(newMe.statusCode).toBe(200)
    const reused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { name: '重置用户', code, newPassword: 'againpass123' },
    })
    expect(reused.statusCode).toBe(400)
    expect(reused.json().code).toBe('RESET_CODE_INVALID')
  })
})

describe('P0 后端：幂等与 sync', () => {
  it('同 user + key 重放返回首次结果并标记 replayed', async () => {
    seedAdminAndInvite()
    const reg = await registerUser('幂等用户', '13800000021')
    const token = reg.json().data.token
    const first = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { ...auth(token), 'x-idempotency-key': 'same-key' },
      payload: { emoji: '😎' },
    })
    const second = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { ...auth(token), 'x-idempotency-key': 'same-key' },
      payload: { emoji: '👑' },
    })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json().data.replayed).toBe(true)
    expect(second.json().data.me.emoji).toBe('😎')
    expect(db.prepare("SELECT emoji FROM users WHERE name='幂等用户'").get().emoji).toBe('😎')
  })

  it('/sync 空 feed 也返回合法结构', async () => {
    seedAdminAndInvite()
    const reg = await registerUser('同步用户', '13800000022')
    const token = reg.json().data.token
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(token) })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      feed: [],
      cursor: 0,
      me: { balance: 1000000, frozen: 0, unread: 0 },
      banner: { newMarketsToday: 0 },
      announcement: null,
    })
    expect(typeof res.json().data.now).toBe('number')
    expect(typeof res.json().data.onlineCount).toBe('number')
  })
})

describe('P0 后端：团码大小写 + 找回 + 自助注销（账号系统补强）', () => {
  it('团码大小写不敏感：seed 小写，输入大写也能注册成功', async () => {
    seedAdminAndInvite({ code: 'BEEEEET' })
    const reg = await registerUser('大写团码用户', '13800000031', 'BEEEEET')
    expect(reg.statusCode).toBe(201)
    const reg2 = await registerUser('小写团码用户', '13800000032', 'beeeeet')
    expect(reg2.statusCode).toBe(201)
  })

  it('迁移：老库存的大写团码自动转小写，重跑迁移幂等，输入仍可注册', async () => {
    const adminId = seedAdminAndInvite() // seed 已小写
    // 模拟老库残留大写记录
    db.prepare("UPDATE invite_codes SET code='BEEEEET'").run()
    migrate(db) // 迁移把它转小写
    expect(db.prepare('SELECT code FROM invite_codes').get().code).toBe('beeeeet')
    migrate(db) // 幂等：再跑不变
    expect(db.prepare('SELECT code FROM invite_codes').get().code).toBe('beeeeet')
    const reg = await registerUser('迁移后用户', '13800000033', 'BEEEEET')
    expect(reg.statusCode).toBe(201)
  })

  it('找回：昵称+手机号匹配则重设新密码并发新 token，旧密码失效、错手机号被拒', async () => {
    seedAdminAndInvite()
    await registerUser('找回员', '13800000041')
    const token0 = (await login('找回员', 'pass1234'))
    expect(typeof token0).toBe('string')

    const wrongPhone = await app.inject({
      method: 'POST', url: '/api/v1/auth/recover',
      headers: { 'x-idempotency-key': 'rec-wrong' },
      payload: { name: '找回员', phone: '13800009999', newPassword: 'newpass1' },
    })
    expect(wrongPhone.statusCode).toBe(401)
    expect(wrongPhone.json().code).toBe('BAD_CREDENTIALS')

    const ok = await app.inject({
      method: 'POST', url: '/api/v1/auth/recover',
      headers: { 'x-idempotency-key': 'rec-ok' },
      payload: { name: '找回员', phone: '13800000041', newPassword: 'newpass1' },
    })
    expect(ok.statusCode).toBe(200)
    expect(typeof ok.json().data.token).toBe('string')

    const newLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { name: '找回员', password: 'newpass1' } })
    expect(newLogin.statusCode).toBe(200)
    const oldLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { name: '找回员', password: 'pass1234' } })
    expect(oldLogin.statusCode).toBe(401)
  })

  it('自助注销：密码确认后清账号、手机号释放可重注册；错密码拒、admin 不可注销', async () => {
    seedAdminAndInvite()
    const reg = await registerUser('注销员', '13800000051')
    const token = reg.json().data.token

    const wrongPw = await app.inject({ method: 'POST', url: '/api/v1/account/delete', headers: { ...auth(token), 'x-idempotency-key': 'del-wrong' }, payload: { password: 'badpass' } })
    expect(wrongPw.statusCode).toBe(401)

    const del = await app.inject({ method: 'POST', url: '/api/v1/account/delete', headers: { ...auth(token), 'x-idempotency-key': 'del-ok' }, payload: { password: 'pass1234' } })
    expect(del.statusCode).toBe(200)
    expect(del.json().data.status).toBe('deleted')

    const after = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(token) })
    expect(after.statusCode).toBe(401)

    const reReg = await registerUser('注销员二代', '13800000051')
    expect(reReg.statusCode).toBe(201)

    const adminToken = await login('admin', 'adminpass')
    const adminDel = await app.inject({ method: 'POST', url: '/api/v1/account/delete', headers: { ...auth(adminToken), 'x-idempotency-key': 'del-admin' }, payload: { password: 'adminpass' } })
    expect(adminDel.statusCode).toBe(403)
  })
})
