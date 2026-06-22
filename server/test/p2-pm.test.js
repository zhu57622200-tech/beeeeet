import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { openDb } from '../src/db.js'
import { fetchPmResultById } from '../src/pm-result.js'
import { runSettlement } from '../src/settle.js'

const SECRET = 'test-secret'
const T0 = 1_800_000_000_000

let app
let db
let tick
let tmpDir
let cachePath

function now() {
  return T0 + tick++
}

function auth(token) {
  return { authorization: `Bearer ${token}` }
}

function idem(token, key) {
  return { ...auth(token), 'x-idempotency-key': key }
}

function writeCache(body) {
  fs.writeFileSync(cachePath, JSON.stringify(body))
}

function cacheBody() {
  return {
    generatedAt: T0,
    byId: {
      ev1: {
        id: 'ev1',
        enTitle: 'Will BTC hit 100k?',
        zhTitle: '比特币破十万',
        zhOutcomes: ['会', '不会'],
        market: {
          id: 'm1',
          question: 'Will BTC hit 100k?',
          zhQuestion: 'BTC 会破十万吗',
          outcomes: '["Yes","No"]',
          outcomePrices: '["0.25","0.75"]',
        },
      },
      ev2: {
        id: 'ev2',
        enTitle: 'NBA finals',
        zhTitle: 'NBA 决赛',
        markets: [
          {
            id: 'm2',
            question: 'Who wins?',
            outcomes: '["Lakers","Celtics"]',
            outcomePrices: '["0.4","0.6"]',
          },
        ],
      },
    },
  }
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

function insertPmBet(userId, overrides = {}) {
  const body = {
    user_id: userId,
    event_id: 'ev1',
    market_id: 'm1',
    event_title: '比特币破十万',
    market_question: 'BTC 会破十万吗',
    outcome: 'Yes',
    zh_outcome: '会',
    prob: 0.25,
    odds: 4,
    stake: 100,
    status: 'pending',
    result: null,
    payout: 0,
    settled_at: null,
    created_at: now(),
    ...overrides,
  }
  const info = db.prepare(`
    INSERT INTO pm_bets (
      user_id, event_id, market_id, event_title, market_question, outcome, zh_outcome,
      prob, odds, stake, status, result, payout, settled_at, created_at
    ) VALUES (
      @user_id, @event_id, @market_id, @event_title, @market_question, @outcome, @zh_outcome,
      @prob, @odds, @stake, @status, @result, @payout, @settled_at, @created_at
    )
  `).run(body)
  return Number(info.lastInsertRowid)
}

beforeEach(() => {
  tick = 1
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeeeet-p2-'))
  cachePath = path.join(tmpDir, 'pm-cache.json')
  process.env.PM_CACHE_PATH = cachePath
  writeCache(cacheBody())
  db = openDb(':memory:')
  app = buildApp({ db, jwtSecret: SECRET, now })
})

afterEach(async () => {
  await app.close()
  db.close()
  delete process.env.PM_CACHE_PATH
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('P2 系统盘后端', () => {
  it('下注从 pm-cache 权威重算赔率，忽略客户端篡改 prob；marketId 不存在返回 VALIDATION', async () => {
    const userId = seedUser('系统盘玩家')
    const token = await login('系统盘玩家')

    const bet = await expectConserved(() => app.inject({
      method: 'POST',
      url: '/api/v1/pm-bets',
      headers: idem(token, 'pm-bet-1'),
      payload: { eventId: 'ev1', marketId: 'm1', outcome: 'Yes', stake: 100, prob: 0.99, odds: 999 },
    }))
    expect(bet.statusCode).toBe(200)
    const row = db.prepare('SELECT * FROM pm_bets WHERE user_id=?').get(userId)
    expect(row).toMatchObject({
      event_id: 'ev1',
      market_id: 'm1',
      outcome: 'Yes',
      prob: 0.25,
      odds: 4,
      stake: 100,
      status: 'pending',
    })
    expect(db.prepare('SELECT balance FROM users WHERE id=?').get(userId).balance).toBe(999_900)

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/pm-bets',
      headers: idem(token, 'pm-bet-bad'),
      payload: { eventId: 'ev1', marketId: 'missing', outcome: 'Yes', stake: 100 },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('VALIDATION')
  })

  it('结算幂等：同一批 pending 连跑两遍只派彩一次', async () => {
    const userId = seedUser('赢一次')
    insertPmBet(userId, { stake: 100, odds: 4 })
    const first = await expectConserved(() => runSettlement(db, {
      fetchResult: async () => ({ closed: true, winningOutcome: 'Yes' }),
      now,
    }))
    expect(first).toMatchObject({ scanned: 1, settled: 1, errors: [] })
    expect(db.prepare('SELECT balance FROM users WHERE id=?').get(userId).balance).toBe(1_000_400)

    const second = await expectConserved(() => runSettlement(db, {
      fetchResult: async () => ({ closed: true, winningOutcome: 'Yes' }),
      now,
    }))
    expect(second).toMatchObject({ scanned: 0, settled: 0, errors: [] })
    expect(db.prepare('SELECT balance FROM users WHERE id=?').get(userId).balance).toBe(1_000_400)
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='pm_win'").get().n).toBe(1)
  })

  it('部分成功：一个分组失败不影响另一个，失败组下轮可重试成功', async () => {
    const okUser = seedUser('成功组')
    const badUser = seedUser('失败组')
    insertPmBet(okUser, { market_id: 'm-ok', outcome: 'Yes', stake: 100, odds: 2 })
    insertPmBet(badUser, { market_id: 'm-bad', outcome: 'No', stake: 100, odds: 3 })

    const partial = await expectConserved(() => runSettlement(db, {
      fetchResult: async (id) => {
        if (id === 'm-bad') throw new Error('upstream down')
        return { closed: true, winningOutcome: 'Yes' }
      },
      now,
    }))
    expect(partial.scanned).toBe(2)
    expect(partial.settled).toBe(1)
    expect(partial.errors).toHaveLength(1)
    expect(db.prepare('SELECT status FROM settlement_runs ORDER BY id DESC LIMIT 1').get().status).toBe('partial')
    expect(db.prepare('SELECT status FROM pm_bets WHERE market_id=?').get('m-bad').status).toBe('pending')

    const retry = await expectConserved(() => runSettlement(db, {
      fetchResult: async () => ({ closed: true, winningOutcome: 'No' }),
      now,
    }))
    expect(retry).toMatchObject({ scanned: 1, settled: 1, errors: [] })
    expect(db.prepare('SELECT status FROM pm_bets WHERE market_id=?').get('m-bad').status).toBe('won')
  })

  it('盘口已关闭但解析不出赢家：记 errors 走 partial，注单保持 pending', async () => {
    const userId = seedUser('取消盘玩家')
    insertPmBet(userId, { market_id: 'm-void', stake: 100, odds: 2 })
    const run = await expectConserved(() => runSettlement(db, {
      fetchResult: async () => ({ closed: true, winningOutcome: null }),
      now,
    }))
    expect(run.settled).toBe(0)
    expect(run.errors).toHaveLength(1)
    expect(run.errors[0].stage).toBe('resolve')
    expect(db.prepare('SELECT status FROM settlement_runs ORDER BY id DESC LIMIT 1').get().status).toBe('partial')
    expect(db.prepare('SELECT status FROM pm_bets WHERE market_id=?').get('m-void').status).toBe('pending')
  })

  it('preferMarket 查询：两个 market 端点（query+路径）都试，但绝不 fallback 到同号 event（防远期冠军盘误结算）', async () => {
    const realFetch = globalThis.fetch
    const calls = []
    const fakeFetch = vi.fn(async (url) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/markets')) throw new Error('market endpoint down')
      // events 端点若被调到，这场 558936 远期冠军盘会被误当结果——必须永不发生
      if (u.includes('/events?id=558936')) {
        return { ok: true, json: async () => [{ id: '558936', markets: [{ id: 'wrong-market', closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0","1"]' }] }] }
      }
      throw new Error(`unexpected url ${u}`)
    })
    globalThis.fetch = fakeFetch
    try {
      await expect(fetchPmResultById('558936', { preferMarket: true })).rejects.toThrow('market endpoint down')
      // query + 路径两个 market 端点都试过，但绝不碰 events
      expect(calls.length).toBe(2)
      expect(calls.every((u) => u.includes('/markets'))).toBe(true)
      expect(calls.some((u) => u.includes('/events'))).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('世界杯 series 盘：/markets?id= 返回空数组时 fallback 到 /markets/<id> 路径形式取结果', async () => {
    const realFetch = globalThis.fetch
    const calls = []
    const fakeFetch = vi.fn(async (url) => {
      const u = String(url)
      calls.push(u)
      // 线上现象：世界杯 series 盘 /markets?id= 返回 HTTP 200 空数组（查不到）
      if (u.includes('/markets?id=1897040')) return { ok: true, json: async () => [] }
      // 路径形式能查到：加拿大胜=No（prices Yes=0,No=1）
      if (u.includes('/markets/1897040')) return { ok: true, json: async () => ({ id: '1897040', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0","1"]' }) }
      throw new Error(`unexpected url ${u}`)
    })
    globalThis.fetch = fakeFetch
    try {
      const result = await fetchPmResultById('1897040', { preferMarket: true })
      expect(result).toEqual({ closed: true, winningOutcome: 'No' })
      // 先试 query 形式（空），再 fallback 到路径形式；全程不碰 events（防撞号误结算）
      expect(calls[0]).toContain('/markets?id=1897040')
      expect(calls[1]).toContain('/markets/1897040')
      expect(calls.some((u) => u.includes('/events'))).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('连续失败告警只在跨过 3 轮阈值时发一条，连败持续不刷屏', async () => {
    const userId = seedUser('告警玩家')
    insertPmBet(userId, { market_id: 'm-stuck' })
    const failing = { fetchResult: async () => { throw new Error('upstream down') }, now }
    for (let i = 0; i < 5; i++) await runSettlement(db, failing)
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_alerts WHERE kind='settle_stuck'").get().n).toBe(1)
  })

  it('行级守卫：网络段后已被处理的 bet 跳过，不重复派彩', async () => {
    const guardedUser = seedUser('守卫跳过')
    const normalUser = seedUser('正常派彩')
    const guardedBet = insertPmBet(guardedUser, { market_id: 'm-race', stake: 100, odds: 4 })
    insertPmBet(normalUser, { market_id: 'm-race', stake: 100, odds: 4 })

    const result = await expectConserved(() => runSettlement(db, {
      fetchResult: async () => {
        db.prepare("UPDATE pm_bets SET status='won', result='Yes', payout=400, settled_at=? WHERE id=?")
          .run(now(), guardedBet)
        return { closed: true, winningOutcome: 'Yes' }
      },
      now,
    }))
    expect(result).toMatchObject({ scanned: 2, settled: 1, errors: [] })
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type='pm_win'").get().n).toBe(1)
    expect(db.prepare('SELECT balance FROM users WHERE id=?').get(guardedUser).balance).toBe(1_000_000)
    expect(db.prepare('SELECT balance FROM users WHERE id=?').get(normalUser).balance).toBe(1_000_400)
  })

  it('下注加结算守恒：SUM(balance+frozen) 变化量等于 system ledger SUM', async () => {
    seedUser('守恒玩家')
    const token = await login('守恒玩家')
    await expectConserved(() => app.inject({
      method: 'POST',
      url: '/api/v1/pm-bets',
      headers: idem(token, 'pm-conserve-bet'),
      payload: { eventId: 'ev1', marketId: 'm1', outcome: 'Yes', stake: 125 },
    }))
    await expectConserved(() => runSettlement(db, {
      fetchResult: async () => ({ closed: true, winningOutcome: 'No' }),
      now,
    }))
    expect(db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE type IN ('pm_bet','pm_win','pm_lose')").get().total).toBe(-125)
  })

  it('/pm/markets 只返回轻量元信息，不泄露 byId 全量缓存', async () => {
    seedUser('看盘人')
    const token = await login('看盘人')
    const res = await app.inject({ method: 'GET', url: '/api/v1/pm/markets', headers: auth(token) })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data).toMatchObject({ generatedAt: T0, count: 2 })
    expect(data.byId).toBeUndefined()
    expect(res.body.length).toBeLessThan(200)
  })

  it('/me 与 /sync 返回我的系统盘押注历史，刷新后仍能看到已结算记录', async () => {
    const userId = seedUser('历史玩家')
    insertPmBet(userId, {
      event_id: 'wcgame-kr-cz',
      market_id: 'm-kr',
      event_title: '韩国 vs 捷克',
      market_question: '韩国胜',
      outcome: 'Yes',
      zh_outcome: '韩国胜',
      stake: 100,
      odds: 2,
      status: 'won',
      result: 'Yes',
      payout: 200,
      settled_at: now(),
    })
    const token = await login('历史玩家')

    const meRes = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(token) })
    expect(meRes.statusCode).toBe(200)
    expect(meRes.json().data.pmBets).toHaveLength(1)
    expect(meRes.json().data.pmBets[0]).toMatchObject({
      eventId: 'wcgame-kr-cz',
      eventTitle: '韩国 vs 捷克',
      zhOutcome: '韩国胜',
      status: 'won',
      payout: 200,
    })

    const syncRes = await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(token) })
    expect(syncRes.statusCode).toBe(200)
    expect(syncRes.json().data.pmBets[0]).toMatchObject({
      eventId: 'wcgame-kr-cz',
      status: 'won',
    })
  })
})
