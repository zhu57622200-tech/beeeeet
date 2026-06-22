import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiClientError, ERROR_MESSAGES, newIdempotencyKey, setAuthExpiredHandler, setToken, getToken } from '../src/api-client.js'

function mockFetch(status, body, headers = {}) {
  globalThis.fetch = vi.fn(async () => ({
    status,
    headers: { get: (k) => headers[k] ?? null },
    json: async () => body,
  }))
}

beforeEach(() => {
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  setAuthExpiredHandler(null)
})

describe('api-client', () => {
  it('成功信封解包返回 data', async () => {
    mockFetch(200, { ok: true, data: { me: { name: '甲' } } })
    const data = await api.get('/me')
    expect(data.me.name).toBe('甲')
  })

  it('失败信封抛 ApiClientError，message 优先用服务端、否则查中文表', async () => {
    mockFetch(409, { ok: false, code: 'MATCH_TAKEN', message: '慢了一步，已被人接走' })
    await expect(api.post('/matches/1/take', {})).rejects.toMatchObject({ code: 'MATCH_TAKEN', message: '慢了一步，已被人接走' })
    mockFetch(403, { ok: false, code: 'NOT_FRIENDS' })
    await expect(api.post('/chats/2', {})).rejects.toMatchObject({ message: ERROR_MESSAGES.NOT_FRIENDS })
  })

  it('AUTH_EXPIRED 清 token 并触发跳登录回调', async () => {
    setToken('old-token')
    const handler = vi.fn()
    setAuthExpiredHandler(handler)
    mockFetch(401, { ok: false, code: 'AUTH_EXPIRED' })
    await expect(api.get('/me')).rejects.toBeInstanceOf(ApiClientError)
    expect(getToken()).toBe('')
    expect(handler).toHaveBeenCalledWith('AUTH_EXPIRED')
  })

  it('GET 遇到 NETWORK 会重试并最终成功', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new TypeError('still offline'))
      .mockResolvedValueOnce({
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, data: { me: { name: '甲' } } }),
      })
    globalThis.fetch = fetchMock

    const request = api.get('/me')
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(1000)

    await expect(request).resolves.toEqual({ me: { name: '甲' } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('GET 遇到 401 不重试并立即触发跳登录回调', async () => {
    setToken('old-token')
    const handler = vi.fn()
    setAuthExpiredHandler(handler)
    mockFetch(401, { ok: false, code: 'AUTH_REQUIRED' })

    await expect(api.get('/me')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('AUTH_REQUIRED')
    expect(getToken()).toBe('')
  })

  it('GET 遇到 4xx 业务错误不重试', async () => {
    mockFetch(409, { ok: false, code: 'CONFLICT' })

    await expect(api.get('/matches/1')).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('POST 写操作遇到 NETWORK 不自动重试，避免重复入账', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('request may have reached server'))
      .mockResolvedValueOnce({
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, data: { ledgerEntry: { id: 1 } } }),
      })
    globalThis.fetch = fetchMock

    await expect(api.post('/transfers', { toUserId: 2, amount: 100 })).rejects.toMatchObject({ code: 'NETWORK' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('idempotent POST retries on NETWORK and reuses same key', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline before response'))
      .mockResolvedValueOnce({
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, data: { ledgerEntry: { id: 1 } } }),
      })
    globalThis.fetch = fetchMock

    const request = api.post('/transfers', { toUserId: 2, amount: 100 }, { idempotencyKey: 'transfer-same-key' })
    await vi.advanceTimersByTimeAsync(500)

    await expect(request).resolves.toEqual({ ledgerEntry: { id: 1 } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstHeaders = fetchMock.mock.calls[0][1].headers
    const secondHeaders = fetchMock.mock.calls[1][1].headers
    expect(firstHeaders['X-Idempotency-Key']).toBe('transfer-same-key')
    expect(secondHeaders['X-Idempotency-Key']).toBe(firstHeaders['X-Idempotency-Key'])
  })

  it('POST without idempotencyKey does not retry on NETWORK', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('request may have reached server'))
      .mockResolvedValueOnce({
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, data: { ledgerEntry: { id: 1 } } }),
      })
    globalThis.fetch = fetchMock

    await expect(api.post('/transfers', { toUserId: 2, amount: 100 })).rejects.toMatchObject({ code: 'NETWORK' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('idempotent POST with 4xx does not retry', async () => {
    mockFetch(400, { ok: false, code: 'INSUFFICIENT_BALANCE' })

    await expect(api.post('/transfers', { toUserId: 2, amount: 100 }, { idempotencyKey: 'transfer-low-balance' }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('idempotent POST with 5xx does not retry', async () => {
    mockFetch(503, null)

    await expect(api.post('/transfers', { toUserId: 2, amount: 100 }, { idempotencyKey: 'transfer-server-busy' }))
      .rejects.toMatchObject({ code: 'SERVER_BUSY' })

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('RATE_LIMITED 透出 Retry-After；5xx 统一 SERVER_BUSY；网络异常归 NETWORK', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    mockFetch(429, { ok: false, code: 'RATE_LIMITED' }, { 'Retry-After': '60' })
    await expect(api.get('/sync')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 60 })
    mockFetch(503, null)
    const busyRequest = api.get('/sync')
    const busyExpectation = expect(busyRequest).rejects.toMatchObject({ code: 'SERVER_BUSY' })
    await vi.advanceTimersByTimeAsync(1500)
    await busyExpectation
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed') })
    const networkRequest = api.get('/sync')
    const networkExpectation = expect(networkRequest).rejects.toMatchObject({ code: 'NETWORK' })
    await vi.advanceTimersByTimeAsync(1500)
    await networkExpectation
  })

  it('mutate 自动带幂等键且每次不同', async () => {
    mockFetch(200, { ok: true, data: {} })
    await api.mutate('/transfers', { to: 2, amount: 100 }, 'transfer')
    const headers = globalThis.fetch.mock.calls[0][1].headers
    expect(headers['X-Idempotency-Key']).toMatch(/^transfer-/)
    expect(newIdempotencyKey('x')).not.toBe(newIdempotencyKey('x'))
  })
})
