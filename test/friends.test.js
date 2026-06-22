import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  store,
  register,
  resetAll,
  friendStatus,
  isFriend,
  removeFriend,
  respondFriendRequest,
  searchPlayers,
  sendChat,
  requestFriend,
} from '../src/store.js'

beforeEach(() => {
  resetAll()
  register({ name: '我', password: 'x', phone: '13900000001', emoji: '🫵', agreedTerms: true })
})

afterEach(() => {
  resetAll()
  vi.useRealTimers()
})

describe('friendships · 好友关系层', () => {
  it('申请后先进入 requested，4 秒内 NPC 同意并发动态通知', () => {
    vi.useFakeTimers()
    const beforeFeed = store.feed.length

    expect(requestFriend('胖子')).toBe('requested')
    expect(friendStatus('胖子')).toBe('requested')
    expect(isFriend('胖子')).toBe(false)

    vi.advanceTimersByTime(4000)

    expect(friendStatus('胖子')).toBe('friend')
    expect(isFriend('胖子')).toBe(true)
    expect(store.feed.length).toBe(beforeFeed + 1)
    expect(store.feed[0]).toMatchObject({
      type: 'friend',
      actorName: '胖子',
      text: '胖子 同意了你的好友申请',
    })
  })

  it('重复申请同一个人是幂等的，不重复排同意通知', () => {
    vi.useFakeTimers()

    expect(requestFriend('眼镜')).toBe('requested')
    expect(requestFriend('眼镜')).toBe('requested')
    vi.advanceTimersByTime(4000)

    const notices = store.feed.filter((e) => e.type === 'friend' && e.actorName === '眼镜')
    expect(notices).toHaveLength(1)
    expect(friendStatus('眼镜')).toBe('friend')
  })

  it('已是好友时再次申请不改状态，也不发新通知', () => {
    vi.useFakeTimers()
    const beforeFeed = store.feed.length

    expect(requestFriend('老王')).toBe('friend')
    vi.advanceTimersByTime(4000)

    expect(friendStatus('老王')).toBe('friend')
    expect(store.feed.length).toBe(beforeFeed)
  })

  it('不存在的人不崩，也不会写入 friendships', () => {
    expect(() => requestFriend('查无此人')).not.toThrow()
    expect(requestFriend('查无此人')).toBeNull()
    expect(friendStatus('查无此人')).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(store.friendships, '查无此人')).toBe(false)
  })

  it('resetAll 后清掉申请 timer，阻止幽灵回调写回新存档', () => {
    vi.useFakeTimers()

    requestFriend('二饼')
    expect(friendStatus('二饼')).toBe('requested')
    resetAll()
    vi.advanceTimersByTime(4000)

    expect(friendStatus('二饼')).toBeNull()
    expect(store.feed.some((e) => e.type === 'friend' && e.actorName === '二饼')).toBe(false)
  })

  it('好友申请和 NPC 同意不碰 balance / frozen / ledger', () => {
    vi.useFakeTimers()
    const before = {
      balance: store.balance,
      frozen: store.frozen,
      ledger: JSON.stringify(store.ledger),
    }

    requestFriend('胖子')
    vi.advanceTimersByTime(4000)

    expect(store.balance).toBe(before.balance)
    expect(store.frozen).toBe(before.frozen)
    expect(JSON.stringify(store.ledger)).toBe(before.ledger)
  })

  it('searchPlayers 支持昵称精确命中、手机号命中，空/无命中返回空', () => {
    expect(searchPlayers('老王').map((p) => p.name)).toEqual(['老王'])
    expect(searchPlayers('13800000002').map((p) => p.name)).toEqual(['阿强'])
    expect(searchPlayers('')).toEqual([])
    expect(searchPlayers('老')).toEqual([])
    expect(searchPlayers('19999999999')).toEqual([])
  })

  it('removeFriend 后不再是好友，私信被数据层拒绝', () => {
    expect(isFriend('老王')).toBe(true)
    removeFriend('老王')
    expect(isFriend('老王')).toBe(false)
    expect(() => sendChat('老王', '还聊吗')).toThrow('加好友后才能私信')
  })

  it('respondFriendRequest 通过后成为好友并发动态通知；拒绝后申请消失且非好友', () => {
    const beforeFeed = store.feed.length
    store.friendRequests.push({ id: 'req-1', fromName: '胖子', at: Date.now() })
    respondFriendRequest('req-1', true)
    expect(isFriend('胖子')).toBe(true)
    expect(store.friendRequests.find((r) => r.id === 'req-1')).toBeUndefined()
    expect(store.feed.length).toBe(beforeFeed + 1)
    expect(store.feed[0]).toMatchObject({
      type: 'friend',
      text: '你通过了 胖子 的好友申请',
    })

    store.friendRequests.push({ id: 'req-2', fromName: '眼镜', at: Date.now() })
    respondFriendRequest('req-2', false)
    expect(store.friendRequests.find((r) => r.id === 'req-2')).toBeUndefined()
    expect(isFriend('眼镜')).toBe(false)
  })

  it('register 带 phone/emoji 落库，坏手机号 throw', () => {
    resetAll()
    const m = register({ name: '新玩家', password: 'x', phone: '13912345678', emoji: '🦊', agreedTerms: true })
    expect(m.phone).toBe('13912345678')
    expect(m.emoji).toBe('🦊')

    resetAll()
    expect(() => register({ name: '坏号', password: 'x', phone: '12345', emoji: '😎', agreedTerms: true })).toThrow('请输入 11 位中国手机号')
  })

  it('search/remove/respond 新函数不碰 balance / frozen / ledger', () => {
    const before = {
      balance: store.balance,
      frozen: store.frozen,
      ledger: JSON.stringify(store.ledger),
    }

    searchPlayers('老王')
    removeFriend('老王')
    store.friendRequests.push({ id: 'req-3', fromName: '二饼', at: Date.now() })
    respondFriendRequest('req-3', false)
    store.friendRequests.push({ id: 'req-4', fromName: '眼镜', at: Date.now() })
    respondFriendRequest('req-4', true)

    expect(store.balance).toBe(before.balance)
    expect(store.frozen).toBe(before.frozen)
    expect(JSON.stringify(store.ledger)).toBe(before.ledger)
  })
})

// Step9 cc-check 修订补充：状态机边界 + 注册查重 + 搜索脱敏。
describe('好友体系边界（cc-check 修订轮）', () => {
  it('removeFriend 对 requested 态同样生效（撤回申请语义）', () => {
    requestFriend('胖子')
    expect(friendStatus('胖子')).toBe('requested')
    removeFriend('胖子')
    expect(friendStatus('胖子')).toBe(null)
  })

  it('respondFriendRequest 重复处理同一申请，第二次返回 null 且不重复加好友', () => {
    store.friendRequests.push({ id: 'dup-1', fromName: '眼镜', at: Date.now() })
    expect(respondFriendRequest('dup-1', true)).toBeTruthy()
    expect(respondFriendRequest('dup-1', true)).toBe(null)
    expect(isFriend('眼镜')).toBe(true)
  })

  it('searchPlayers 搜不到自己，且结果是脱敏摘要（无 phone/password/balance）', () => {
    expect(searchPlayers('我')).toEqual([])
    expect(searchPlayers('13900000001')).toEqual([]) // 我自己的手机号也搜不到自己
    const [hit] = searchPlayers('老王')
    expect(hit.name).toBe('老王')
    expect(hit.phone).toBeUndefined()
    expect(hit.password).toBeUndefined()
    expect(hit.balance).toBeUndefined()
  })

  it('resetAll 重置 reportedCheats，旧举报去重记录不残留进新存档', () => {
    store.reportedCheats.push('m1:老王')
    resetAll()
    expect(store.reportedCheats).toEqual([])
  })

  it('seedIncomingRequest 候选耗尽返回 null', async () => {
    const { seedIncomingRequest } = await import('../src/store.js')
    // 把所有 NPC 全变成好友 → 无候选
    store.players.filter((p) => !p.isMe).forEach((p) => { store.friendships[p.name] = 'friend' })
    expect(seedIncomingRequest()).toBe(null)
  })

  it('注册手机号被 NPC 占用 → 拒绝；空手机号显式传入 → 拒绝', () => {
    resetAll()
    expect(() => register({ name: '撞号', password: 'x', phone: '13800000001', emoji: '🫵', agreedTerms: true }))
      .toThrow('手机号已被熟人占用')
    expect(() => register({ name: '空号', password: 'x', phone: '', emoji: '🫵', agreedTerms: true }))
      .toThrow('11 位中国手机号')
  })
})
