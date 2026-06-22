import { describe, it, expect, beforeEach } from 'vitest'
import {
  store,
  register,
  resetAll,
  createMatch,
  npcJoin,
  settleMatchStore,
  unreadCount,
  unreadFeed,
  markSeen,
} from '../src/store.js'
import { settleMatch } from '../src/core/wager.js'

// 每个用例前重置成全新状态并注册"我"，保证隔离。
beforeEach(() => {
  resetAll()
  register({ name: '我', password: 'x', agreedTerms: true })
})

// 开一盘并让一个 NPC 接盘，返回 match 对象。
function openAndJoin() {
  const m = createMatch({
    title: '梅西进球',
    optionA: '进',
    optionB: '不进',
    ownerSide: 'A',
    odds: 2,
    ownerStake: 100,
  })
  npcJoin(m.id)
  return store.matches.find((x) => x.id === m.id)
}

describe('feed · 开盘喂动态流', () => {
  it('createMatch 后 feed 里有一条 open 事件，actor 是我', () => {
    createMatch({ title: 'A 队赢', optionA: '赢', optionB: '输', ownerSide: 'A', odds: 2, ownerStake: 50 })
    const open = store.feed.find((e) => e.type === 'open')
    expect(open).toBeTruthy()
    expect(open.actorName).toBe('我')
    expect(open.ref).toBeTruthy()
  })
})

describe('feed · 接盘喂动态流', () => {
  it('npcJoin 后 feed 里有一条 join 事件，actor 是 NPC', () => {
    const m = openAndJoin()
    const join = store.feed.find((e) => e.type === 'join')
    expect(join).toBeTruthy()
    expect(join.actorName).toBe(m.takerName)
    expect(join.actorName).not.toBe('我')
  })
})

describe('feed · 结算喂动态流 + 连胜', () => {
  it('我赢时有 settle 事件；连胜≥2 时有 streak 事件', () => {
    // 连赢两盘
    for (let i = 0; i < 2; i++) {
      const m = openAndJoin()
      const r = settleMatch({ ownerStake: m.ownerStake, takerStake: m.takerStake, ownerSide: m.ownerSide, result: 'A' })
      settleMatchStore(m.id, 'A', r)
    }
    expect(store.feed.some((e) => e.type === 'settle')).toBe(true)
    const streak = store.feed.find((e) => e.type === 'streak')
    expect(streak).toBeTruthy()
    expect(streak.text).toContain('连胜')
  })
})

describe('feed · 打脸回放', () => {
  it('接盘 NPC 输了（我赢）→ feed 有 slap 事件 + 嘴炮区有 slap 评论', () => {
    const m = openAndJoin()
    const r = settleMatch({ ownerStake: m.ownerStake, takerStake: m.takerStake, ownerSide: m.ownerSide, result: 'A' })
    settleMatchStore(m.id, 'A', r)
    expect(store.feed.some((e) => e.type === 'slap')).toBe(true)
    const mm = store.matches.find((x) => x.id === m.id)
    expect(mm.comments.some((c) => c.slap)).toBe(true)
  })

  it('我输了（NPC 赢）→ 不打脸，无 slap', () => {
    const m = openAndJoin()
    const r = settleMatch({ ownerStake: m.ownerStake, takerStake: m.takerStake, ownerSide: m.ownerSide, result: 'B' })
    settleMatchStore(m.id, 'B', r)
    expect(store.feed.some((e) => e.type === 'slap')).toBe(false)
  })
})

describe('通知红点 · unreadCount / markSeen', () => {
  it('NPC 接盘产生未读；我自己的开盘不算未读', () => {
    const m = createMatch({ title: 'x', optionA: 'a', optionB: 'b', ownerSide: 'A', odds: 2, ownerStake: 10 })
    npcJoin(m.id)
    // 把 lastSeenAt 拨到所有事件之前，确保边界不受同毫秒影响。
    store.lastSeenAt = 0
    // 我自己的 open 事件不计未读；NPC 的 join 事件计未读。
    expect(unreadCount()).toBeGreaterThanOrEqual(1)
    expect(unreadFeed().every((e) => e.actorName !== '我')).toBe(true)
    expect(unreadFeed().every((e) => e.actorName !== undefined)).toBe(true)
  })

  it('markSeen 后红点清零', () => {
    const m = createMatch({ title: 'x', optionA: 'a', optionB: 'b', ownerSide: 'A', odds: 2, ownerStake: 10 })
    npcJoin(m.id)
    store.lastSeenAt = 0
    expect(unreadCount()).toBeGreaterThan(0)
    markSeen()
    expect(unreadCount()).toBe(0)
  })
})

describe('feed · 裁 100 条上限（防膨胀）', () => {
  it('连开 105 盘后 feed 恰好 100 条，最旧被裁掉', () => {
    // 每次 createMatch 同步 push 一条 'open' 事件（NPC 定时器是 setTimeout，测试里不触发）。
    // 先记下第 1 盘标题，之后它应被挤出 feed（最旧出局）。
    const firstTitle = '盘0'
    createMatch({ title: firstTitle, optionA: 'a', optionB: 'b', ownerSide: 'A', odds: 2, ownerStake: 1 })
    for (let i = 1; i < 105; i++) {
      createMatch({ title: '盘' + i, optionA: 'a', optionB: 'b', ownerSide: 'A', odds: 2, ownerStake: 1 })
    }
    expect(store.feed.length).toBe(100)
    // 最旧那条（第 1 盘的 open）已被裁，feed 里找不到它。
    expect(store.feed.some((e) => e.text.includes(`「${firstTitle}」`))).toBe(false)
    // 最新一条仍在（倒序，最新在前）。
    expect(store.feed[0].text).toContain('「盘104」')
  })
})

describe('通知红点 · 我自己的事件不计未读', () => {
  it('我开盘的 open 事件不计入 unreadCount', () => {
    createMatch({ title: '我开的盘', optionA: 'a', optionB: 'b', ownerSide: 'A', odds: 2, ownerStake: 10 })
    store.lastSeenAt = 0 // 拨到所有事件之前，确保只看 actor 过滤
    // feed 里有我的 open 事件，但 unreadCount 排除"我" → 不算未读。
    expect(store.feed.some((e) => e.type === 'open' && e.actorName === '我')).toBe(true)
    expect(unreadCount()).toBe(0)
  })
})
