import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchPmResultById } from '../src/api.js'
import {
  store,
  resetAll,
  register,
  placePmBet,
  toggleWatch,
  pmUpdateNow,
  autoSettlePendingBets,
} from '../src/store.js'

// Polymarket 风 event（与 pmdata 同口径）。
function ev({ id = 'e1', title = '', volume = 1000, outcomes = ['Yes', 'No'], prices = ['0.5', '0.5'], createdAt } = {}) {
  return {
    id,
    title,
    volume24hr: volume,
    createdAt: createdAt || '2026-06-01T00:00:00Z',
    tags: [],
    markets: [{ question: title, outcomes: JSON.stringify(outcomes), outcomePrices: JSON.stringify(prices) }],
  }
}

// ---- ① fetchPmResultById（mock /pm proxy）----
describe('S16 fetchPmResultById：按 id 查真实结果', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('events?id 返回已结束盘口（markets[]）→ closed + winningOutcome', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(String(url)).toContain('/pm/events?id=ev1')
      return {
        ok: true,
        json: async () => [
          { id: 'ev1', closed: true, markets: [{ closed: true, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' }] },
        ],
        text: async () => '',
      }
    }))
    const r = await fetchPmResultById('ev1')
    expect(r).toEqual({ closed: true, winningOutcome: 'Yes' })
  })

  it('markets 形态（自身就是盘口、单对象）→ 取真实赢家', async () => {
    // events 端点先返回空数组（无 markets）→ 降级到 markets 端点。
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/pm/events')) {
        return { ok: true, json: async () => [], text: async () => '' }
      }
      return { ok: true, json: async () => ({ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0","1"]' }), text: async () => '' }
    }))
    const r = await fetchPmResultById('m9')
    expect(r).toEqual({ closed: true, winningOutcome: 'Down' })
  })

  it('盘口未结束（closed=false）→ { closed:false }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'x', closed: false, markets: [{ closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]' }] }],
      text: async () => '',
    })))
    const r = await fetchPmResultById('x')
    expect(r.closed).toBe(false)
  })

  it('网络错（fetch reject）→ 容错返回 { closed:false }，不抛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const r = await fetchPmResultById('boom')
    expect(r).toEqual({ closed: false, winningOutcome: null })
  })

  it('空 id → 直接 { closed:false }，不发请求', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect(await fetchPmResultById('')).toEqual({ closed: false, winningOutcome: null })
    expect(await fetchPmResultById(null)).toEqual({ closed: false, winningOutcome: null })
    expect(f).not.toHaveBeenCalled()
  })
})

// ---- ② 钉住保护 ----
describe('S16 钉住保护：押注/关注的盘不被清理', () => {
  beforeEach(() => {
    resetAll()
    register({ name: '我', password: 'x', agreedTerms: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  function stubNet({ pmEvents, dsArr }) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url)
      if (s.includes('tag_slug=')) return { ok: true, json: async () => [], text: async () => '' }
      if (s.startsWith('/pm')) return { ok: true, json: async () => pmEvents, text: async () => '' }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(dsArr) } }] }), text: async () => '' }
    }))
  }

  it('押注 → 盘 id 进钉住集合', () => {
    placePmBet({ eventId: 'p1', eventTitle: '某盘', marketQuestion: 'q', outcome: 'Yes', prob: 0.25, stake: 10000 })
    expect(store.pmCache.pinnedIds).toContain('p1')
  })

  it('关注系统盘 → 钉住；取关且无押注 → 释放', () => {
    toggleWatch('pm', 'w1')
    expect(store.pmCache.pinnedIds).toContain('w1')
    toggleWatch('pm', 'w1') // 取关，无押注 → 释放
    expect(store.pmCache.pinnedIds).not.toContain('w1')
  })

  it('取关但仍有 pending 押注 → 不释放（保留到结算）', () => {
    placePmBet({ eventId: 'k1', eventTitle: '某盘', marketQuestion: 'q', outcome: 'Yes', prob: 0.25, stake: 10000 })
    toggleWatch('pm', 'k1')
    toggleWatch('pm', 'k1') // 取关，但还有押注
    expect(store.pmCache.pinnedIds).toContain('k1')
  })

  it('每日重拉清理：钉住盘永久保留，非钉住跌出 top200 被清', async () => {
    // 首拉：a(押注钉住) + b(无主)。
    stubNet({
      pmEvents: [ev({ id: 'a', title: 'Bitcoin above 100k?' }), ev({ id: 'b', title: 'Bitcoin above 300k?' })],
      dsArr: [
        { id: 'a', zhTitle: '比特币A', zhOutcomes: ['会', '不会'], category: '加密', compliant: true },
        { id: 'b', zhTitle: '比特币B', zhOutcomes: ['会', '不会'], category: '加密', compliant: true },
      ],
    })
    await pmUpdateNow({ now: 1000 })
    // 押 a → 钉住 a。
    placePmBet({ eventId: 'a', eventTitle: '比特币A', marketQuestion: 'q', outcome: 'Yes', prob: 0.25, stake: 10000 })
    expect(store.pmCache.byId.a).toBeTruthy()
    expect(store.pmCache.byId.b).toBeTruthy()

    // 24h 后重拉：新活跃池只有 c（a/b 都跌出 top200）。
    stubNet({
      pmEvents: [ev({ id: 'c', title: 'Bitcoin above 500k?' })],
      dsArr: [{ id: 'c', zhTitle: '比特币C', zhOutcomes: ['会', '不会'], category: '加密', compliant: true }],
    })
    await pmUpdateNow({ now: 1000 + 25 * 60 * 60 * 1000 })
    expect(store.pmCache.byId.a).toBeTruthy() // 钉住 → 保留
    expect(store.pmCache.byId.b).toBeUndefined() // 无主跌出 → 清
    expect(store.pmCache.byId.c).toBeTruthy() // 新盘进
  })

  it('清理超期：非钉住盘 createdAt 超 14 天即清（即便仍在活跃池外）', async () => {
    stubNet({
      pmEvents: [ev({ id: 'old', title: 'Bitcoin?', createdAt: '2026-01-01T00:00:00Z' })],
      dsArr: [{ id: 'old', zhTitle: '旧盘', zhOutcomes: ['会', '不会'], category: '加密', compliant: true }],
    })
    const t0 = new Date('2026-01-01T00:00:00Z').getTime()
    await pmUpdateNow({ now: t0 + 1000 })
    expect(store.pmCache.byId.old).toBeTruthy()
    // 重拉，活跃池换新盘 + 已过 20 天 → old 跌出且超期 → 清。
    stubNet({
      pmEvents: [ev({ id: 'new', title: 'Ethereum?' })],
      dsArr: [{ id: 'new', zhTitle: '新盘', zhOutcomes: ['会', '不会'], category: '加密', compliant: true }],
    })
    await pmUpdateNow({ now: t0 + 20 * 24 * 60 * 60 * 1000 })
    expect(store.pmCache.byId.old).toBeUndefined()
  })
})

// ---- ③ 自动真实结算 ----
describe('S16 autoSettlePendingBets：pending → 真实结果判 won/lost', () => {
  beforeEach(() => {
    resetAll()
    register({ name: '我', password: 'x', agreedTerms: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  // /pm/events?id=<id> mock：按 id 给真实结果。
  function stubResults(resultsById) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const m = String(url).match(/[?&]id=([^&]+)/)
      const id = m ? decodeURIComponent(m[1]) : ''
      const r = resultsById[id]
      if (!r) return { ok: true, json: async () => [], text: async () => '' }
      return {
        ok: true,
        json: async () => [{ id, closed: true, markets: [{ closed: true, outcomes: JSON.stringify(r.outcomes), outcomePrices: JSON.stringify(r.prices) }] }],
        text: async () => '',
      }
    }))
  }

  it('盘口结束：押中 → won 派彩；押错 → lost（用真实英文 outcome 判，守恒不变）', async () => {
    const start = store.balance
    // 押中盘 win：押 Yes，真实赢家 Yes，prob 0.25 → odds 4。
    placePmBet({ eventId: 'win', eventTitle: '押中盘', marketQuestion: 'q', outcome: 'Yes', prob: 0.25, stake: 10000 })
    // 押错盘 lose：押 Yes，真实赢家 No。
    placePmBet({ eventId: 'lose', eventTitle: '押错盘', marketQuestion: 'q', outcome: 'Yes', prob: 0.5, stake: 5000 })
    expect(store.balance).toBe(start - 15000)

    stubResults({
      win: { outcomes: ['Yes', 'No'], prices: ['1', '0'] },
      lose: { outcomes: ['Yes', 'No'], prices: ['0', '1'] },
    })
    const n = await autoSettlePendingBets()
    expect(n).toBe(2)
    const winBet = store.pmBets.find((b) => b.eventId === 'win')
    const loseBet = store.pmBets.find((b) => b.eventId === 'lose')
    expect(winBet.status).toBe('won')
    expect(winBet.payout).toBe(40000)
    expect(loseBet.status).toBe('lost')
    // 守恒：起始 -15000 押注 + win 派彩 40000 = start + 25000。
    expect(store.balance).toBe(start - 15000 + 40000)
  })

  it('盘口未结束 → 保持 pending（不模拟顶替）', async () => {
    placePmBet({ eventId: 'open', eventTitle: '进行中', marketQuestion: 'q', outcome: 'Yes', prob: 0.3, stake: 10000 })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'open', closed: false, markets: [{ closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.3","0.7"]' }] }],
      text: async () => '',
    })))
    const n = await autoSettlePendingBets()
    expect(n).toBe(0)
    expect(store.pmBets.find((b) => b.eventId === 'open').status).toBe('pending')
  })

  it('结算后从钉住集合释放（无关注、无其他 pending）', async () => {
    placePmBet({ eventId: 'rel', eventTitle: '盘', marketQuestion: 'q', outcome: 'Yes', prob: 0.5, stake: 5000 })
    expect(store.pmCache.pinnedIds).toContain('rel')
    stubResults({ rel: { outcomes: ['Yes', 'No'], prices: ['1', '0'] } })
    await autoSettlePendingBets()
    expect(store.pmCache.pinnedIds).not.toContain('rel') // 进历史 → 释放
  })

  it('同盘多笔 pending 共用一次结果；单个查不到不影响其他', async () => {
    placePmBet({ eventId: 'multi', eventTitle: '盘', marketQuestion: 'q', outcome: 'Yes', prob: 0.5, stake: 1000 })
    placePmBet({ eventId: 'multi', eventTitle: '盘', marketQuestion: 'q', outcome: 'No', prob: 0.5, stake: 1000 })
    placePmBet({ eventId: 'unknown', eventTitle: '查不到', marketQuestion: 'q', outcome: 'Yes', prob: 0.5, stake: 1000 })
    stubResults({ multi: { outcomes: ['Yes', 'No'], prices: ['1', '0'] } }) // unknown 不在结果里 → 未结束
    const n = await autoSettlePendingBets()
    expect(n).toBe(2) // multi 的两笔都结
    expect(store.pmBets.filter((b) => b.eventId === 'multi').every((b) => b.status !== 'pending')).toBe(true)
    expect(store.pmBets.find((b) => b.eventId === 'unknown').status).toBe('pending') // 查不到保持 pending
  })

  it('无 pending → 不发任何请求', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const n = await autoSettlePendingBets()
    expect(n).toBe(0)
    expect(f).not.toHaveBeenCalled()
  })
})
