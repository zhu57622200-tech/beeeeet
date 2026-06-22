import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  store,
  resetAll,
  register,
  pmCommentsFor,
  seedNpcPmComments,
  postPmComment,
  refreshPmIfStale,
} from '../src/store.js'

beforeEach(() => {
  resetAll()
  register({ name: '我', password: 'x', agreedTerms: true })
})

// ---- 留言板：本地留言 + NPC 预设氛围（替代原 DeepSeek 预测）----
describe('系统盘留言板', () => {
  it('seedNpcPmComments：进盘 seed 1-3 条 NPC 氛围评论，且幂等不重复堆', () => {
    const n = seedNpcPmComments('e1')
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(3)
    const after1 = pmCommentsFor('e1')
    expect(after1.length).toBe(n)
    expect(after1.every((c) => c.npc === true)).toBe(true)
    // 幂等：再次 seed 不新增（已有 NPC 评论则跳过）。
    const n2 = seedNpcPmComments('e1')
    expect(n2).toBe(0)
    expect(pmCommentsFor('e1').length).toBe(n)
  })

  it('seedNpcPmComments：NPC 评论来自真实 NPC 名池且内容非空', () => {
    seedNpcPmComments('e1')
    const list = pmCommentsFor('e1')
    const npcNames = store.players.filter((p) => !p.isMe).map((p) => p.name)
    list.forEach((c) => {
      expect(npcNames).toContain(c.by)
      expect(c.text.length).toBeGreaterThan(0)
      expect(c.emoji.length).toBeGreaterThan(0)
    })
  })

  it('postPmComment：我发的留言存入，by=我、npc=false', () => {
    const c = postPmComment('e1', '这盘我押 Yes')
    expect(c.by).toBe('我')
    expect(c.npc).toBe(false)
    const list = pmCommentsFor('e1')
    expect(list.some((x) => x.text === '这盘我押 Yes' && !x.npc)).toBe(true)
  })

  it('postPmComment：空白/纯空格留言拒发抛错，不入库', () => {
    expect(() => postPmComment('e1', '   ')).toThrow()
    expect(() => postPmComment('e1', '')).toThrow()
    expect(pmCommentsFor('e1').length).toBe(0)
  })

  it('pmCommentsFor：按时间升序（旧在前、新在后），空盘返回 []', () => {
    expect(pmCommentsFor('none')).toEqual([])
    postPmComment('e1', 'A')
    postPmComment('e1', 'B')
    const list = pmCommentsFor('e1')
    expect(list.map((c) => c.text)).toEqual(['A', 'B'])
    expect(list[0].at).toBeLessThanOrEqual(list[1].at)
  })

  it('不同盘口留言互相隔离（按 eventId）', () => {
    postPmComment('e1', '盘一留言')
    postPmComment('e2', '盘二留言')
    expect(pmCommentsFor('e1').map((c) => c.text)).toEqual(['盘一留言'])
    expect(pmCommentsFor('e2').map((c) => c.text)).toEqual(['盘二留言'])
  })

  it('resetAll 清空所有留言', () => {
    postPmComment('e1', 'x')
    seedNpcPmComments('e2')
    resetAll()
    expect(pmCommentsFor('e1')).toEqual([])
    expect(pmCommentsFor('e2')).toEqual([])
    expect(store.pmComments).toEqual({})
  })
})

// ---- 系统盘提速：缓存新鲜路径不被后台重翻阻塞（fire-and-forget）----
describe('refreshPmIfStale 缓存新鲜：秒返不卡重翻', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('缓存未过期时，即使重翻请求永不返回，也立刻返回缓存列表', async () => {
    // 塞一条合规缓存盘 + 一条未中文化盘（会触发后台重翻）。
    store.pmCache.fetchedAt = 5000
    store.pmCache.byId = {
      done: {
        id: 'done', enTitle: 'Done', zhTitle: '已翻盘', zhOutcomes: ['会', '不会'],
        category: '加密', prob: 0.5, volume: 1000, createdAt: 1000, compliant: true,
        description: '', icon: '',
        market: { question: 'q', zhQuestion: 'zq', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' },
      },
      raw: {
        id: 'raw', enTitle: 'Raw', zhTitle: '', zhOutcomes: [],
        category: '加密', prob: 0.5, volume: 900, createdAt: 1000, compliant: true,
        description: '', icon: '',
        market: { question: 'q2', zhQuestion: '', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' },
      },
    }
    // 重翻会打 /ds —— 让它永不 resolve。若 refreshPmIfStale 还 await 它就会挂死超时。
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const list = await refreshPmIfStale({ now: 5000 + 60_000 }) // 未到刷新点
    // 能拿到返回 = 没被永不返回的重翻卡住（fire-and-forget 生效）。
    expect(list.map((e) => e.id).sort()).toEqual(['done', 'raw'])
  })

  it('到刷新点需更新时（force），即使爬取/翻译永不返回，也立刻返回当前缓存', async () => {
    store.pmCache.fetchedAt = 5000
    store.pmCache.byId = {
      done: {
        id: 'done', enTitle: 'Done', zhTitle: '已翻盘', zhOutcomes: ['会', '不会'],
        category: '加密', prob: 0.5, volume: 1000, createdAt: 1000, compliant: true,
        description: '', icon: '',
        market: { question: 'q', zhQuestion: 'zq', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' },
      },
    }
    // 整个更新（/pm 爬取 + /ds 翻译）永不 resolve。前端入口若还 await pmUpdateNow 就会挂死。
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const list = await refreshPmIfStale({ force: true, now: 5000 + 60_000 })
    // 立刻拿到旧缓存 = 更新走了后台 fire-and-forget，用户点开不等（这才是「慢」的真正修复）。
    expect(list.map((e) => e.id)).toEqual(['done'])
  })
})
