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
    INSERT INTO users (name, phone, password_hash, is_admin, is_npc, balance, emoji, title, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    opts.phone || `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    hashPassword('pass1234'),
    opts.isAdmin ? 1 : 0,
    opts.isNpc ? 1 : 0,
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

async function openMatch(token, body, key = `open-${tick}`) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/matches',
    headers: idem(token, key),
    payload: {
      title: '社交局',
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

describe('P4 社交：好友和私信', () => {
  it('好友申请 none→requested→friend，重复申请幂等，接受写 feed', async () => {
    const aId = seedUser('甲')
    const bId = seedUser('乙')
    const [ta, tb] = await Promise.all([login('甲'), login('乙')])

    const requested = await app.inject({ method: 'POST', url: `/api/v1/friends/${bId}/request`, headers: auth(ta) })
    expect(requested.statusCode).toBe(200)
    expect(requested.json().data.status).toBe('requested')
    const repeated = await app.inject({ method: 'POST', url: `/api/v1/friends/${bId}/request`, headers: auth(ta) })
    expect(repeated.statusCode).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS n FROM friendships').get().n).toBe(1)

    const listBefore = await app.inject({ method: 'GET', url: '/api/v1/friends', headers: auth(tb) })
    expect(listBefore.statusCode).toBe(200)
    expect(listBefore.json().data.incoming.map((u) => u.id)).toContain(aId)

    const accepted = await app.inject({ method: 'POST', url: `/api/v1/friends/${aId}/accept`, headers: auth(tb) })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().data.status).toBe('friend')
    expect(db.prepare("SELECT status FROM friendships WHERE user_a=? AND user_b=?").get(aId, bId).status).toBe('accepted')
    expect(db.prepare("SELECT COUNT(*) AS n FROM feed WHERE type='friend'").get().n).toBe(1)

    const friends = await app.inject({ method: 'GET', url: '/api/v1/friends', headers: auth(ta) })
    expect(friends.json().data.friends.map((u) => u.id)).toContain(bId)
  })

  it('非好友私信 403，好友私信可读且 unreadChats 并入 /sync', async () => {
    const aId = seedUser('私信甲')
    const bId = seedUser('私信乙')
    const [ta, tb] = await Promise.all([login('私信甲'), login('私信乙')])

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${bId}`,
      headers: auth(ta),
      payload: { text: 'hello' },
    })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json().code).toBe('NOT_FRIENDS')

    db.prepare("INSERT INTO friendships (user_a, user_b, status, created_at, accepted_at) VALUES (?, ?, 'accepted', ?, ?)")
      .run(aId, bId, now(), now())
    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${bId}`,
      headers: auth(ta),
      payload: { text: 'hello' },
    })
    expect(sent.statusCode).toBe(200)
    const sync = await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(tb) })
    expect(sync.statusCode).toBe(200)
    expect(sync.json().data.me.unreadChats).toBe(1)
    const read = await app.inject({ method: 'GET', url: `/api/v1/chats/${aId}?since=0`, headers: auth(tb) })
    expect(read.statusCode).toBe(200)
    expect(read.json().data.messages).toHaveLength(1)
    const syncAfter = await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(tb) })
    expect(syncAfter.json().data.me.unreadChats).toBe(0)
  })

  it('残留 deleted 好友关系不影响 /me，/friends 返回正常空数组', async () => {
    const meId = seedUser('阿狐', 1_000_000, { emoji: '🦊' })
    const deletedA = seedUser('旧友甲', 0)
    const deletedB = seedUser('旧友乙', 0)
    db.prepare("UPDATE users SET status='deleted', deleted_at=?, balance=0, frozen=0 WHERE id IN (?, ?)")
      .run(now(), deletedA, deletedB)
    db.prepare(`
      INSERT INTO friendships (user_a, user_b, status, created_at, accepted_at)
      VALUES (?, ?, 'accepted', ?, ?), (?, ?, 'accepted', ?, ?)
    `).run(meId, deletedA, now(), now(), deletedB, meId, now(), now())
    const token = await login('阿狐')

    const meRes = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(token) })
    expect(meRes.statusCode).toBe(200)
    expect(meRes.json().data.me).toMatchObject({ id: meId, name: '阿狐', emoji: '🦊', balance: 1_000_000 })

    const friends = await app.inject({ method: 'GET', url: '/api/v1/friends', headers: auth(token) })
    expect(friends.statusCode).toBe(200)
    expect(friends.json().data).toEqual({ friends: [], incoming: [], outgoing: [] })
  })
})

describe('P4 社交：留言、搜索、关注、彩头', () => {
  it('match/pm 留言可写可读，搜索返回 friendStatus，观察列表可增删', async () => {
    const ownerId = seedUser('开盘人')
    const friendId = seedUser('朋友', 1_000_000, { emoji: 'f' })
    const [owner, friend] = await Promise.all([login('开盘人'), login('朋友')])
    db.prepare("INSERT INTO friendships (user_a, user_b, status, created_at, accepted_at) VALUES (?, ?, 'accepted', ?, ?)")
      .run(ownerId, friendId, now(), now())
    const opened = await expectConserved(() => openMatch(owner, { sideBetText: '奶茶' }, 'social-open'))
    const matchId = opened.json().data.match.id

    const matchComment = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/comments`, headers: auth(friend), payload: { text: '我来了' } })
    expect(matchComment.statusCode).toBe(200)
    const matchComments = await app.inject({ method: 'GET', url: `/api/v1/matches/${matchId}/comments`, headers: auth(owner) })
    expect(matchComments.statusCode).toBe(200)
    expect(matchComments.json().data.comments[0]).toMatchObject({ text: '我来了', userId: friendId })

    const pmComment = await app.inject({ method: 'POST', url: '/api/v1/pm/ev1/comments', headers: auth(owner), payload: { text: '系统盘留言' } })
    expect(pmComment.statusCode).toBe(200)
    const pmComments = await app.inject({ method: 'GET', url: '/api/v1/pm/ev1/comments', headers: auth(friend) })
    expect(pmComments.json().data.comments[0]).toMatchObject({ text: '系统盘留言', userId: ownerId })

    const search = await app.inject({ method: 'GET', url: '/api/v1/users/search?q=朋', headers: auth(owner) })
    expect(search.statusCode).toBe(200)
    expect(search.json().data.users).toEqual([
      expect.objectContaining({ id: friendId, name: '朋友', friendStatus: 'friend' }),
    ])

    const putWatch = await app.inject({ method: 'PUT', url: '/api/v1/me/watchlist', headers: auth(owner), payload: { eventId: 'ev1' } })
    expect(putWatch.statusCode).toBe(200)
    const watch = await app.inject({ method: 'GET', url: '/api/v1/me/watchlist', headers: auth(owner) })
    expect(watch.json().data.items.map((x) => x.eventId)).toContain('ev1')
    const delWatch = await app.inject({ method: 'DELETE', url: '/api/v1/me/watchlist/ev1', headers: auth(owner) })
    expect(delWatch.statusCode).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS n FROM watchlist').get().n).toBe(0)
  })

  it('回复评论会带引用信息，并只给被回复人发铃铛通知', async () => {
    const ownerId = seedUser('回复开盘人')
    const friendId = seedUser('回复朋友')
    const thirdId = seedUser('路人')
    const [owner, friend, third] = await Promise.all([login('回复开盘人'), login('回复朋友'), login('路人')])
    const opened = await expectConserved(() => openMatch(owner, {}, 'reply-open'))
    const matchId = opened.json().data.match.id

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/matches/${matchId}/comments`,
      headers: auth(friend),
      payload: { text: '我先说一句' },
    })
    expect(first.statusCode).toBe(200)
    const firstId = first.json().data.comment.id

    const reply = await app.inject({
      method: 'POST',
      url: `/api/v1/matches/${matchId}/comments`,
      headers: auth(owner),
      payload: { text: '@回复朋友 收到', replyToCommentId: firstId },
    })
    expect(reply.statusCode).toBe(200)
    expect(reply.json().data.comment).toMatchObject({
      replyToCommentId: firstId,
      replyToUserId: friendId,
      replyToName: '回复朋友',
      replyToText: '我先说一句',
    })

    const friendSync = await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(friend) })
    expect(friendSync.statusCode).toBe(200)
    expect(friendSync.json().data.me.unread).toBe(2) // 开盘动态 + 回复通知
    expect(friendSync.json().data.feed.map((f) => f.type)).toContain('comment_reply')
    expect(friendSync.json().data.feed.find((f) => f.type === 'comment_reply')).toMatchObject({
      actorId: ownerId,
      targetUserId: friendId,
      ref: `match:${matchId}`,
    })

    const thirdSync = await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(third) })
    expect(thirdSync.statusCode).toBe(200)
    expect(thirdSync.json().data.feed.map((f) => f.type)).not.toContain('comment_reply')
    expect(thirdId).toBeGreaterThan(0)
  })

  it('PATCH /me 可改 emoji/privacy，彩头 fulfill/nag 不动钱', async () => {
    seedUser('彩头人')
    const token = await login('彩头人')
    const opened = await expectConserved(() => openMatch(token, { sideBetText: '请喝奶茶' }, 'sidebet-open'))
    const matchId = opened.json().data.match.id

    const patched = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: auth(token), payload: { emoji: 'z', privacy: 1 } })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().data.me).toMatchObject({ emoji: 'z', privacy: 1 })

    const nag = await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/sidebet/nag`, headers: auth(token) }))
    expect(nag.statusCode).toBe(200)
    const fulfilled = await expectConserved(() => app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/sidebet/fulfill`, headers: auth(token) }))
    expect(fulfilled.statusCode).toBe(200)
    expect(db.prepare('SELECT side_bet_fulfilled FROM matches WHERE id=?').get(matchId).side_bet_fulfilled).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM feed WHERE type='sidebet'").get().n).toBe(2)
  })
})

describe('P4 /sync 收尾', () => {
  it('/sync 返回 feed 增量、真人在线数、unreadChats；空增量响应小于 300B', async () => {
    seedUser('同步甲')
    seedUser('同步乙')
    seedUser('同步NPC', 1_000_000, { isNpc: true })
    const [ta, tb] = await Promise.all([login('同步甲'), login('同步乙')])
    db.prepare("INSERT INTO feed (type, actor_id, text, ref, created_at) VALUES ('test', NULL, '一条动态', NULL, ?)").run(now())

    const first = await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(ta) })
    expect(first.statusCode).toBe(200)
    const data = first.json().data
    expect(data.feed).toHaveLength(1)
    expect(data.cursor).toBe(data.feed[0].id)
    expect(data.onlineCount).toBe(1)
    expect(data.me).toMatchObject({ balance: 1_000_000, frozen: 0, unread: 1, unreadChats: 0 })
    expect(data.banner).toMatchObject({ newMarketsToday: 0 })

    await app.inject({ method: 'GET', url: '/api/v1/sync?since=0', headers: auth(tb) })
    const second = await app.inject({ method: 'GET', url: `/api/v1/sync?since=${data.cursor}`, headers: auth(ta) })
    expect(second.statusCode).toBe(200)
    expect(second.json().data.feed).toEqual([])
    expect(second.body.length).toBeLessThan(300)
  })
})
