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

function user(id) {
  return db.prepare('SELECT id, balance, frozen, wins, losses FROM users WHERE id=?').get(id)
}

function totals() {
  return db.prepare('SELECT COALESCE(SUM(balance + frozen), 0) AS total FROM users').get().total
}

function systemLedgerSince(ledgerId) {
  return db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE kind='system' AND id > ?").get(ledgerId).total
}

function ledgerId() {
  return db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM ledger').get().id
}

async function expectConserved(work) {
  const beforeTotal = totals()
  const beforeLedger = ledgerId()
  const out = await work()
  expect(totals() - beforeTotal).toBe(systemLedgerSince(beforeLedger))
  return out
}

async function openMatch(token, body, key = `open-${tick}`) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/matches',
    headers: idem(token, key),
    payload: {
      title: '谁赢',
      optionA: 'A队',
      optionB: 'B队',
      deadline: T0 + 60_000,
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

describe('P1 真人对赌：match 全链路', () => {
  it('开盘、接盘、列表可见、揭晓结算，全程接盘方真扣减且守恒', async () => {
    const a = seedUser('A')
    const b = seedUser('B')
    seedUser('C')
    const [ta, tb, tc] = await Promise.all([login('A'), login('B'), login('C')])

    const opened = await expectConserved(() => openMatch(ta, {
      mode: 'match',
      ownerSide: 'A',
      ownerStake: 100,
      odds: 2.5,
    }, 'm-open'))
    expect(opened.statusCode).toBe(200)
    const matchId = opened.json().data.match.id
    expect(user(a)).toMatchObject({ balance: 999_900, frozen: 100 })

    const taken = await expectConserved(() => app.inject({
      method: 'POST',
      url: `/api/v1/matches/${matchId}/take`,
      headers: idem(tb, 'm-take'),
      payload: {},
    }))
    expect(taken.statusCode).toBe(200)
    expect(taken.json().data.match.takerStake).toBe(150)
    expect(user(b)).toMatchObject({ balance: 999_850, frozen: 150 })

    const list = await app.inject({ method: 'GET', url: '/api/v1/matches?status=matched&limit=10', headers: auth(tc) })
    expect(list.statusCode).toBe(200)
    expect(list.json().data.matches.map((m) => m.id)).toContain(matchId)

    const revealed = await expectConserved(() => app.inject({
      method: 'POST',
      url: `/api/v1/matches/${matchId}/reveal`,
      headers: idem(ta, 'm-reveal'),
      payload: { result: 'A' },
    }))
    expect(revealed.statusCode).toBe(200)
    expect(user(a)).toMatchObject({ balance: 1_000_150, frozen: 0, wins: 1 })
    expect(user(b)).toMatchObject({ balance: 999_850, frozen: 0, losses: 1 })
    expect(db.prepare("SELECT status, result FROM matches WHERE id=?").get(matchId)).toMatchObject({ status: 'settled', result: 'A' })
  })

  it('同一幂等键重复接盘只扣一次且总额守恒', async () => {
    seedUser('幂等庄')
    const takerId = seedUser('幂等客')
    const [owner, taker] = await Promise.all([login('幂等庄'), login('幂等客')])
    const opened = await openMatch(owner, { mode: 'match', ownerSide: 'A', ownerStake: 100, odds: 2 }, 'idem-open')
    const matchId = opened.json().data.match.id
    const beforeTaker = user(takerId)
    const initialTotal = totals()

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/matches/${matchId}/take`,
      headers: idem(taker, 'idem-take-same-key'),
      payload: {},
    })
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/matches/${matchId}/take`,
      headers: idem(taker, 'idem-take-same-key'),
      payload: {},
    })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json().data.replayed).toBe(true)
    expect(user(takerId)).toMatchObject({
      balance: beforeTaker.balance - 100,
      frozen: beforeTaker.frozen + 100,
    })
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE request_id='idem-take-same-key' AND type='freeze'").get().n).toBe(1)
    expect(totals()).toBe(initialTotal)
  })

  it('两个请求同时接同一 open 局，恰好一个成功一个 MATCH_TAKEN', async () => {
    const a = seedUser('庄')
    const b = seedUser('乙')
    const c = seedUser('丙')
    const [ta, tb, tc] = await Promise.all([login('庄'), login('乙'), login('丙')])
    const opened = await openMatch(ta, { mode: 'match', ownerSide: 'A', ownerStake: 100, odds: 2 }, 'race-open')
    const matchId = opened.json().data.match.id

    const before = totals()
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/take`, headers: idem(tb, 'race-b'), payload: {} }),
      app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/take`, headers: idem(tc, 'race-c'), payload: {} }),
    ])
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409])
    expect([r1.json().code, r2.json().code]).toContain('MATCH_TAKEN')
    expect([b, c]).toContain(db.prepare('SELECT taker_id FROM matches WHERE id=?').get(matchId).taker_id)
    expect(totals()).toBe(before)
    expect(user(a).frozen).toBe(100)
  })

  it('接盘取整只使用入库 taker_stake，结算、改判、再改回没有 1 分漂移', async () => {
    const a = seedUser('取整A')
    const b = seedUser('取整B')
    const admin = seedUser('群主', 1_000_000, { isAdmin: true })
    const [ta, tb, tAdmin] = await Promise.all([login('取整A'), login('取整B'), login('群主')])
    const opened = await openMatch(ta, { mode: 'match', ownerSide: 'A', ownerStake: 101, odds: 1.5 }, 'round-open')
    const matchId = opened.json().data.match.id
    await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/take`, headers: idem(tb, 'round-take'), payload: {} })
    await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/reveal`, headers: idem(ta, 'round-reveal'), payload: { result: 'A' } })
    expect(db.prepare('SELECT taker_stake FROM matches WHERE id=?').get(matchId).taker_stake).toBe(51)

    const appeal = await expectConserved(() => app.inject({
      method: 'POST',
      url: '/api/v1/appeals',
      headers: idem(tb, 'round-appeal'),
      payload: { matchId, stake: 1000, reason: '错了' },
    }))
    expect(appeal.statusCode).toBe(200)
    const appealId = appeal.json().data.appeal.id
    const afterSettle = { a: user(a), b: user(b), admin: user(admin) }

    const overturned = await expectConserved(() => app.inject({
      method: 'POST',
      url: `/api/v1/admin/appeals/${appealId}/resolve`,
      headers: idem(tAdmin, 'round-overturn'),
      payload: { verdict: 'overturn', newResult: 'B' },
    }))
    expect(overturned.statusCode).toBe(200)
    expect(user(a).balance + user(b).balance + user(admin).balance + user(a).frozen + user(b).frozen + user(admin).frozen)
      .toBe(afterSettle.a.balance + afterSettle.b.balance + afterSettle.admin.balance + 1000)

    const appeal2 = await app.inject({
      method: 'POST',
      url: '/api/v1/appeals',
      headers: idem(ta, 'round-appeal-2'),
      payload: { matchId, stake: 1000, reason: '再审' },
    })
    expect(appeal2.statusCode).toBe(200)
    const reverted = await expectConserved(() => app.inject({
      method: 'POST',
      url: `/api/v1/admin/appeals/${appeal2.json().data.appeal.id}/resolve`,
      headers: idem(tAdmin, 'round-revert'),
      payload: { verdict: 'overturn', newResult: 'A' },
    }))
    expect(reverted.statusCode).toBe(200)
    expect(user(a)).toMatchObject({ balance: 1_000_051, frozen: 0 })
    expect(user(b)).toMatchObject({ balance: 999_949, frozen: 0 })
  })
})

describe('P1 真人对赌：彩池/坐庄/共识/作废', () => {
  it('彩池多赢家整数派彩总额等于总池，并且每条用例后守恒', async () => {
    seedUser('池主')
    seedUser('赢家大')
    seedUser('赢家小')
    seedUser('输家')
    const [owner, w1, w2, loser] = await Promise.all([login('池主'), login('赢家大'), login('赢家小'), login('输家')])
    const opened = await expectConserved(() => openMatch(owner, {
      mode: 'pool',
      ownerSide: 'A',
      ownerStake: 3,
    }, 'pool-open'))
    const matchId = opened.json().data.match.id
    await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/pool-bets`, headers: idem(w1, 'pool-w1'), payload: { side: 'A', stake: 7 } }))
    await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/pool-bets`, headers: idem(w2, 'pool-w2'), payload: { side: 'A', stake: 5 } }))
    await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/pool-bets`, headers: idem(loser, 'pool-l'), payload: { side: 'B', stake: 10 } }))
    const settled = await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/reveal`, headers: idem(owner, 'pool-reveal'), payload: { result: 'A' } }))
    expect(settled.statusCode).toBe(200)
    const payouts = db.prepare('SELECT COALESCE(SUM(payout), 0) AS total FROM match_bets WHERE match_id=?').get(matchId).total
    expect(payouts).toBe(25)
  })

  it('进入 consensus 后拒绝新注，投票达阈值后同事务结算', async () => {
    seedUser('共识主')
    seedUser('共识客')
    seedUser('迟到者')
    const [owner, taker, late] = await Promise.all([login('共识主'), login('共识客'), login('迟到者')])
    const opened = await openMatch(owner, { mode: 'match', ownerSide: 'A', ownerStake: 100, odds: 2 }, 'cons-open')
    const matchId = opened.json().data.match.id
    await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/take`, headers: idem(taker, 'cons-take'), payload: {} })
    const dispute = await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/dispute`, headers: idem(taker, 'cons-dispute'), payload: { proposed: 'B' } }))
    expect(dispute.statusCode).toBe(200)
    const lateBet = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/pool-bets`, headers: idem(late, 'cons-late'), payload: { side: 'A', stake: 10 } })
    expect(lateBet.statusCode).toBe(409)
    expect(lateBet.json().code).toBe('MATCH_NOT_OPEN')

    const vote1 = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/vote`, headers: idem(owner, 'cons-v1'), payload: { vote: 'agree' } })
    expect(vote1.statusCode).toBe(200)
    expect(db.prepare('SELECT status FROM matches WHERE id=?').get(matchId).status).toBe('consensus')
    const vote2 = await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/vote`, headers: idem(taker, 'cons-v2'), payload: { vote: 'agree' } }))
    expect(vote2.statusCode).toBe(200)
    expect(db.prepare('SELECT status, result FROM matches WHERE id=?').get(matchId)).toMatchObject({ status: 'settled', result: 'B' })
  })

  it('坐庄超出剩余敞口前置拒绝，正常注不触发 haircut', async () => {
    seedUser('庄家')
    seedUser('押客1')
    seedUser('押客2')
    const [banker, p1, p2] = await Promise.all([login('庄家'), login('押客1'), login('押客2')])
    const opened = await openMatch(banker, { mode: 'banker', bankerOdds: 3, bankerCap: 100 }, 'banker-open')
    const matchId = opened.json().data.match.id
    const okBet = await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/banker-bets`, headers: idem(p1, 'banker-b1'), payload: { side: 'A', stake: 40 } }))
    expect(okBet.statusCode).toBe(200)
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/banker-bets`, headers: idem(p2, 'banker-b2'), payload: { side: 'A', stake: 20 } })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toMatchObject({ code: 'VALIDATION' })
    expect(rejected.json().message).toContain('剩余可押额度')

    const settled = await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/reveal`, headers: idem(banker, 'banker-reveal'), payload: { result: 'A' } }))
    expect(settled.statusCode).toBe(200)
    expect(db.prepare('SELECT payout FROM match_bets WHERE match_id=?').get(matchId).payout).toBe(120)
  })

  it('彩池单边赢方为空时整局 voided，全额退款且不记胜负', async () => {
    const ownerId = seedUser('单边主')
    const bettorId = seedUser('单边押')
    const [owner, bettor] = await Promise.all([login('单边主'), login('单边押')])
    const opened = await openMatch(owner, { mode: 'pool', ownerSide: 'A', ownerStake: 10 }, 'single-open')
    const matchId = opened.json().data.match.id
    await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/pool-bets`, headers: idem(bettor, 'single-bet'), payload: { side: 'A', stake: 20 } })
    const settled = await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/reveal`, headers: idem(owner, 'single-reveal'), payload: { result: 'B' } }))
    expect(settled.statusCode).toBe(200)
    expect(db.prepare('SELECT status FROM matches WHERE id=?').get(matchId).status).toBe('voided')
    expect(user(ownerId)).toMatchObject({ balance: 1_000_000, frozen: 0, wins: 0, losses: 0 })
    expect(user(bettorId)).toMatchObject({ balance: 1_000_000, frozen: 0, wins: 0, losses: 0 })
  })

  it('owner cancel 和 sweepExpiredMatches 都退还冻结并写不同 feed', async () => {
    const { sweepExpiredMatches } = await import('../src/matches.js')
    seedUser('撤盘人')
    const token = await login('撤盘人')
    const opened = await openMatch(token, { mode: 'match', ownerSide: 'A', ownerStake: 100, odds: 2 }, 'cancel-open')
    const cancelId = opened.json().data.match.id
    const canceled = await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${cancelId}/cancel`, headers: idem(token, 'cancel-1') }))
    expect(canceled.statusCode).toBe(200)
    expect(db.prepare('SELECT status FROM matches WHERE id=?').get(cancelId).status).toBe('voided')

    const expired = await openMatch(token, { mode: 'match', ownerSide: 'A', ownerStake: 50, odds: 2, deadline: T0 - 1 }, 'expire-open')
    const expireId = expired.json().data.match.id
    await expectConserved(async () => sweepExpiredMatches(db, T0 + 10_000))
    expect(db.prepare('SELECT status FROM matches WHERE id=?').get(expireId).status).toBe('voided')
    expect(db.prepare("SELECT COUNT(*) AS n FROM feed WHERE type='cancel'").get().n).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM feed WHERE type='expire'").get().n).toBe(1)
  })
})

describe('P1 cc-check 修复回归', () => {
  it('坐庄敞口预检与结算取整口径对齐：浮点边界恰好等于 cap 的注被拒，庄家回款永不为负', async () => {
    const bankerId = seedUser('取整庄')
    seedUser('取整客1')
    seedUser('取整客2')
    const [banker, p1, p2] = await Promise.all([login('取整庄'), login('取整客1'), login('取整客2')])
    // odds=2.5 stake=1 → 结算 payout=round(2.5)=3，庄家整数风险 2/注；浮点口径只算 1.5/注
    const opened = await openMatch(banker, { mode: 'banker', bankerOdds: 2.5, bankerCap: 3 }, 'align-open')
    const matchId = opened.json().data.match.id
    const first = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/banker-bets`, headers: idem(p1, 'align-b1'), payload: { side: 'A', stake: 1 } })
    expect(first.statusCode).toBe(200)
    // 旧浮点口径：两注共 3.0 ≤ cap=3 放行 → 结算 round 后赔付 6 > cap+池 5，庄家回款 -1
    const second = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/banker-bets`, headers: idem(p2, 'align-b2'), payload: { side: 'A', stake: 1 } })
    expect(second.statusCode).toBe(400)
    expect(second.json().code).toBe('VALIDATION')
    const settled = await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/reveal`, headers: idem(banker, 'align-reveal'), payload: { result: 'A' } }))
    expect(settled.statusCode).toBe(200)
    expect(user(bankerId).frozen).toBe(0)
    expect(user(bankerId).balance).toBeGreaterThanOrEqual(1_000_000 - 3)
  })

  it('坐庄/彩池局申诉在入口被拒，不扣复议金不留 pending', async () => {
    seedUser('池东')
    const poolBettor = seedUser('池西')
    const [owner, bettor] = await Promise.all([login('池东'), login('池西')])
    const opened = await openMatch(owner, { mode: 'pool', ownerSide: 'A', ownerStake: 10 }, 'pa-open')
    const matchId = opened.json().data.match.id
    await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/pool-bets`, headers: idem(bettor, 'pa-bet'), payload: { side: 'B', stake: 10 } })
    await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/reveal`, headers: idem(owner, 'pa-reveal'), payload: { result: 'A' } })
    const beforeBalance = user(poolBettor).balance
    const appeal = await app.inject({ method: 'POST', url: '/api/v1/appeals', headers: idem(bettor, 'pa-appeal'), payload: { matchId, stake: 1000, reason: '不服' } })
    expect(appeal.statusCode).toBe(400)
    expect(appeal.json().code).toBe('VALIDATION')
    expect(user(poolBettor).balance).toBe(beforeBalance)
    expect(db.prepare('SELECT COUNT(*) AS n FROM appeals').get().n).toBe(0)
  })

  it('同 key 并发重放：只成一单，重放方拿 replayed 标记而非约束冲突', async () => {
    seedUser('重放人')
    const token = await login('重放人')
    const [r1, r2] = await Promise.all([
      openMatch(token, { mode: 'match', ownerSide: 'A', ownerStake: 100, odds: 2 }, 'same-key'),
      openMatch(token, { mode: 'match', ownerSide: 'A', ownerStake: 100, odds: 2 }, 'same-key'),
    ])
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS n FROM matches').get().n).toBe(1)
    expect([r1.json().data.replayed, r2.json().data.replayed]).toContain(true)
  })
})

describe('P1 真人对赌：申诉改判余额不足显式 system_absorb', () => {
  it('改判回收方余额不足时扣到 0，并用 system_absorb 记差额守恒', async () => {
    const a = seedUser('富赢')
    const b = seedUser('穷输')
    seedUser('裁判', 1_000_000, { isAdmin: true })
    const [ta, tb, admin] = await Promise.all([login('富赢'), login('穷输'), login('裁判')])
    const opened = await openMatch(ta, { mode: 'match', ownerSide: 'A', ownerStake: 100, odds: 2 }, 'absorb-open')
    const matchId = opened.json().data.match.id
    await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/take`, headers: idem(tb, 'absorb-take'), payload: {} })
    await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/reveal`, headers: idem(ta, 'absorb-reveal'), payload: { result: 'A' } })
    db.prepare('UPDATE users SET balance=10 WHERE id=?').run(a)
    const appeal = await app.inject({ method: 'POST', url: '/api/v1/appeals', headers: idem(tb, 'absorb-appeal'), payload: { matchId, stake: 1000, reason: '余额不足改判' } })
    expect(appeal.statusCode).toBe(200)
    const resolved = await expectConserved(() => app.inject({
      method: 'POST',
      url: `/api/v1/admin/appeals/${appeal.json().data.appeal.id}/resolve`,
      headers: idem(admin, 'absorb-resolve'),
      payload: { verdict: 'overturn', newResult: 'B' },
    }))
    expect(resolved.statusCode).toBe(200)
    expect(user(a).balance).toBe(0)
    const absorb = db.prepare("SELECT amount FROM ledger WHERE type='system_absorb' AND kind='system'").get()
    expect(absorb.amount).toBeGreaterThan(0)
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_alerts WHERE kind='conservation'").get().n).toBe(1)
  })
})

describe('P1 我的对赌 myMatches：只含我参与的局（Bug2 回归）', () => {
  it('match 局：owner 与 taker 的 /me.myMatches 含本局，旁观者为空', async () => {
    seedUser('开局人')
    seedUser('接盘人')
    seedUser('旁观人')
    const [tOwner, tTaker, tOther] = await Promise.all([login('开局人'), login('接盘人'), login('旁观人')])

    const opened = await openMatch(tOwner, { mode: 'match', ownerSide: 'A', ownerStake: 10_000, odds: 2 }, 'mine-open')
    expect(opened.statusCode).toBe(200)
    const matchId = opened.json().data.match.id
    const took = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/take`, headers: idem(tTaker, 'mine-take'), payload: {} })
    expect(took.statusCode).toBe(200)

    const ownerMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(tOwner) })
    expect(ownerMe.json().data.myMatches.map((m) => m.id)).toContain(matchId)
    const takerMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(tTaker) })
    expect(takerMe.json().data.myMatches.map((m) => m.id)).toContain(matchId)
    // Bug2 核心：没参与的旁观者，"我的对赌"绝不该出现这局
    const otherMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(tOther) })
    expect(otherMe.json().data.myMatches).toEqual([])
  })

  it('pool 局：下注者算参与（出现在 /sync.myMatches），未下注的旁观者不出现', async () => {
    seedUser('彩池庄')
    seedUser('彩池注')
    seedUser('彩池闲')
    const [tOwner, tBettor, tIdle] = await Promise.all([login('彩池庄'), login('彩池注'), login('彩池闲')])

    const opened = await openMatch(tOwner, { mode: 'pool', ownerSide: 'A', ownerStake: 5_000 }, 'mine-pool-open')
    expect(opened.statusCode).toBe(200)
    const matchId = opened.json().data.match.id
    const bet = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/pool-bets`, headers: idem(tBettor, 'mine-pool-bet'), payload: { side: 'B', stake: 3_000 } })
    expect(bet.statusCode).toBe(200)

    const bettorSync = await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(tBettor) })
    expect(bettorSync.json().data.myMatches.map((m) => m.id)).toContain(matchId)
    const idleSync = await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(tIdle) })
    expect(idleSync.json().data.myMatches.map((m) => m.id)).not.toContain(matchId)
  })
})
