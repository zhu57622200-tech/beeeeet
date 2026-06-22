// S3 旧档升级回归：v0.23.6 结构的 localStorage 存档（无 chats/privacy 等 v0.24 新字段）
// 加载新版 store 必须不炸、新字段自动补齐、老数据一项不丢。
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/v0236-save.json'

afterAll(() => vi.unstubAllGlobals()) // 防 localStorage stub 泄漏到其他测试文件的 watcher 输出噪音

async function loadStoreWithFixture(override = {}) {
  vi.resetModules()
  const saved = { liaoshi_state_v2: JSON.stringify({ ...fixture, ...override }) }
  vi.stubGlobal('localStorage', {
    getItem: (k) => saved[k] ?? null,
    setItem: (k, v) => { saved[k] = v },
    removeItem: (k) => { delete saved[k] },
  })
  return import('../src/store.js')
}

describe('v0.23.6 旧档升级到 v0.24', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('加载不炸，且老数据一项不丢', async () => {
    const { store } = await loadStoreWithFixture()
    expect(store.balance).toBe(880000)
    expect(store.frozen).toBe(120000)
    expect(store.matches).toHaveLength(1)
    expect(store.pmBets).toHaveLength(1)
    expect(store.rivals['老王'].wins).toBe(2)
    expect(store.feed).toHaveLength(1)
    expect(store.watchlist.matches).toEqual(['m1'])
    expect(store.players.find((p) => p.isMe).name).toBe('老档玩家')
  })

  it('v0.24 新字段自动补齐：chats 空对象、privacy 缺省、演示 NPC 老李隐私=开', async () => {
    const { store } = await loadStoreWithFixture()
    expect(store.chats).toEqual({})
    // 好友关系：旧档无 friendships → 补预置 3 好友
    expect(store.friendships).toEqual({ 老王: 'friend', 阿强: 'friend', 老李: 'friend' })
    expect(store.friendRequests).toEqual([])
    const me0 = store.players.find((p) => p.isMe)
    expect(me0.phone).toBe('')
    expect(me0.privacy).toBe(false)
    expect(store.players.find((p) => p.name === '老王').privacy).toBe(false)
    expect(store.players.find((p) => p.name === '老李').privacy).toBe(true)
  })

  it('旧档 NPC 手机号自动补齐为固定假号', async () => {
    const { store } = await loadStoreWithFixture()
    expect(store.players.find((p) => p.name === '老王').phone).toBe('13800000001')
    expect(store.players.find((p) => p.name === '阿强').phone).toBe('13800000002')
    expect(store.players.find((p) => p.name === '老李').phone).toBe('13800000006')
    expect(store.players.filter((p) => !p.isMe)).toHaveLength(6)
    expect(store.players.filter((p) => !p.isMe).every((p) => /^1\d{10}$/.test(p.phone))).toBe(true)
  })

  it('watchlist.pm 的 number id 归一成 String（防严格比较失配静默丢关注）', async () => {
    const { store, isLoggedIn } = await loadStoreWithFixture()
    expect(store.watchlist.pm).toEqual(['10001'])
    expect(isLoggedIn()).toBe(true) // 旧档登录态保留
  })

  it('残留 requested 态在加载时降级删除（同意 timer 只活在内存，刷新后会永久卡死）', async () => {
    const { store } = await loadStoreWithFixture({ friendships: { 老王: 'friend', 胖子: 'requested' } })
    expect(store.friendships).toEqual({ 老王: 'friend' }) // requested 被删，可重新申请
  })
})
