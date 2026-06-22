import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ok = (data) => ({ ok: true, data })

function jsonResponse(body, status = 200) {
  return {
    status,
    headers: { get: () => null },
    json: async () => body,
  }
}

async function loadStore() {
  vi.resetModules()
  return import('../src/store.js')
}

describe('store online API mirror', () => {
  let mem

  beforeEach(() => {
    mem = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('login posts credentials, stores token, and mirrors me', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ok({
      token: 'tok-1',
      me: { id: 7, name: '阿甲', emoji: '🎯', balance: 900, frozen: 100 },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const { login, store } = await loadStore()

    await login({ name: '阿甲', password: 'secret1' })

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: '阿甲', password: 'secret1' }),
    }))
    expect(mem.get('bo_token')).toBe('tok-1')
    expect(store.balance).toBe(900)
    expect(store.frozen).toBe(100)
    expect(store.players.find((p) => p.isMe)).toMatchObject({ id: 7, name: '阿甲' })
  })

  it('createMatch posts /matches and mirrors returned match without optimistic balance edits', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/matches')) {
        return jsonResponse(ok({
          match: { id: 11, mode: 'match', title: 'A 赢', optionA: 'A', optionB: 'B', ownerSide: 'A', ownerStake: 100, status: 'open' },
        }))
      }
      return jsonResponse(ok({}))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { createMatch, store } = await loadStore()
    store.balance = 1000

    const match = await createMatch({ title: 'A 赢', optionA: 'A', optionB: 'B', ownerSide: 'A', odds: 2, ownerStake: 100, mode: 'match' })

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/matches', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ title: 'A 赢', mode: 'match', ownerStake: 100 })
    expect(fetchMock.mock.calls[0][1].headers['X-Idempotency-Key']).toMatch(/^match-/)
    expect(match.id).toBe(11)
    expect(store.matches.map((m) => m.id)).toEqual([11])
    expect(store.balance).toBe(1000)
  })

  it('sync mirrors feed, cursor, online count, and me balances', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ok({
      now: 1000,
      onlineCount: 4,
      feed: [{ id: 9, type: 'open', actorId: 2, text: '开盘', ref: 'match:1', createdAt: 900 }],
      cursor: 9,
      me: { balance: 777, frozen: 33, unread: 1, unreadChats: 2, friendRequests: 3 },
      banner: { newMarketsToday: 1 },
      announcement: { id: 1, text: '公告' },
    }))))
    const { syncNow, store } = await loadStore()

    await syncNow()

    expect(store.balance).toBe(777)
    expect(store.frozen).toBe(33)
    expect(store.feed[0]).toMatchObject({ id: 9, text: '开盘' })
    expect(store.syncCursor).toBe(9)
    expect(store.onlineCount).toBe(4)
    expect(store.unreadChats).toBe(2)
    expect(store.friendRequestCount).toBe(3)
  })

  it('load mirrors /me even when /friends fails on stale deleted friendships', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/me')) {
        return jsonResponse(ok({
          me: { id: 13, name: '阿狐', emoji: '🦊', balance: 1_000_000, frozen: 0 },
        }))
      }
      if (url.endsWith('/friends')) {
        return jsonResponse({ ok: false, code: 'SERVER_BUSY' }, 503)
      }
      return jsonResponse(ok({}))
    })
    vi.stubGlobal('fetch', fetchMock)
    mem.set('bo_token', 'tok-13')
    const { load, store, me } = await loadStore()

    await load()
    await Promise.resolve()

    expect(store.currentId).toBe(13)
    expect(store.balance).toBe(1_000_000)
    expect(store.frozen).toBe(0)
    expect(me()).toMatchObject({ id: 13, name: '阿狐', emoji: '🦊' })
  })

  it('placePmBet posts with an idempotency key and mirrors returned bet', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ok({
      bet: { id: 5, eventId: 'ev1', marketId: 'mk1', outcome: 'Yes', prob: 0.4, odds: 2.5, stake: 200, status: 'pending' },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const { placePmBet, store } = await loadStore()

    const bet = await placePmBet({ eventId: 'ev1', marketId: 'mk1', outcome: 'Yes', stake: 200 })

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/pm-bets', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ eventId: 'ev1', marketId: 'mk1', outcome: 'Yes', stake: 200 }),
    }))
    expect(fetchMock.mock.calls[0][1].headers['X-Idempotency-Key']).toMatch(/^pm-bet-/)
    expect(bet.id).toBe(5)
    expect(store.pmBets).toHaveLength(1)
  })

  it('sendChat can resolve a friend from /friends mirror and normalize server messages', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ok({
      message: { id: 9, fromId: 1, toId: 2, text: '今晚开一把', createdAt: 1234 },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const { sendChat, store } = await loadStore()
    store.currentId = 1
    store.players = [{ id: 1, name: '我', isMe: true }]
    store.friends = [{ id: 2, name: '朋友', emoji: 'f', title: '玩家' }]

    const list = await sendChat('朋友', '今晚开一把')

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/chats/2', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ text: '今晚开一把' }),
    }))
    expect(list).toEqual([
      expect.objectContaining({ id: 9, from: 'me', text: '今晚开一把', at: 1234 }),
    ])
  })

  it('NETWORK errors propagate without clearing existing mirror state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    const { syncNow, store } = await loadStore()
    store.balance = 123

    await expect(syncNow()).rejects.toMatchObject({ code: 'NETWORK' })

    expect(store.balance).toBe(123)
  })
})
