import { describe, it, expect, beforeEach } from 'vitest'
import {
  store,
  register,
  resetAll,
  inviteMatch,
  npcAcceptInvite,
  settleMatchStore,
} from '../src/store.js'

// 每个用例前重置 + 注册"我"，保证隔离。
beforeEach(() => {
  resetAll()
  register({ name: '我', password: 'x', agreedTerms: true })
})

function invite(npcNames) {
  return inviteMatch({
    npcNames,
    title: '周末这局谁赢',
    optionA: '我赢',
    optionB: '我输',
    ownerSide: 'A',
    odds: 2,
    ownerStake: 10000,
  })
}

describe('inviteMatch · 发起邀约', () => {
  it('约赌模式开盘，冻结我的下注额，记被邀名单，初始 open', () => {
    const before = store.balance
    const m = invite(['老王', '阿强'])
    expect(m.mode).toBe('match')
    expect(m.status).toBe('open')
    expect(m.invited).toEqual(['老王', '阿强'])
    expect(store.balance).toBe(before - 10000)
    expect(store.frozen).toBe(10000)
  })

  it('非好友被过滤出邀约名单（私密面不变量；胖子默认非好友）', () => {
    const m = invite(['老王', '胖子'])
    expect(m.invited).toEqual(['老王'])
    expect(() => invite(['胖子'])).toThrow() // 全是非好友 → 拒绝
  })

  it('被邀名单为空（或全是非熟人）抛错', () => {
    expect(() => invite([])).toThrow()
    expect(() => invite(['查无此人'])).toThrow()
  })

  it('过滤掉不存在的名字，只留真熟人', () => {
    const m = invite(['老王', '查无此人'])
    expect(m.invited).toEqual(['老王'])
  })
})

describe('npcAcceptInvite · 模拟同意成局', () => {
  it('第一个同意者成局：设为接盘方、押对立面、status→matched', () => {
    const m = invite(['老王', '胖子'])
    npcAcceptInvite(m.id, '老王')
    const mm = store.matches.find((x) => x.id === m.id)
    expect(mm.status).toBe('matched')
    expect(mm.takerName).toBe('老王')
    expect(mm.takerSide).toBe('B') // 我押 A，接盘押 B
    expect(mm.takerStake).toBe(10000) // takerStakeFor(10000, 2) = 10000
    expect(mm.takerJoined).toBe(true)
  })

  it('第二个同意者不重复接盘，只在评论区凑热闹', () => {
    const m = invite(['老王', '阿强'])
    npcAcceptInvite(m.id, '老王')
    npcAcceptInvite(m.id, '阿强')
    const mm = store.matches.find((x) => x.id === m.id)
    expect(mm.takerName).toBe('老王') // 接盘方仍是第一个
    expect(mm.comments.some((c) => c.by === '阿强')).toBe(true)
  })

  it('非好友直接调 npcAcceptInvite 被数据层拒绝：不接盘、不留言（私密面不变量兜底）', () => {
    const m = invite(['老王', '胖子']) // 胖子默认非好友，已被过滤出 invited
    npcAcceptInvite(m.id, '胖子')
    const mm = store.matches.find((x) => x.id === m.id)
    expect(mm.status).toBe('open') // 没被接盘
    expect(mm.comments.some((c) => c.by === '胖子')).toBe(false)
  })

  it('好友但不在被邀名单内，同样进不了定向私局', () => {
    const m = invite(['老王'])
    npcAcceptInvite(m.id, '阿强') // 阿强是好友，但没被邀
    const mm = store.matches.find((x) => x.id === m.id)
    expect(mm.status).toBe('open')
    expect(mm.comments.some((c) => c.by === '阿强')).toBe(false)
  })

  it('成局后可正常结算（复用 settleMatchStore，不破坏守恒）', () => {
    const m = invite(['老王'])
    npcAcceptInvite(m.id, '老王')
    // 我押 A 且揭晓 A → 我赢，拿回奖池 = ownerStake * odds
    settleMatchStore(m.id, 'A', { ownerPayout: 20000 })
    const mm = store.matches.find((x) => x.id === m.id)
    expect(mm.status).toBe('settled')
    expect(store.frozen).toBe(0) // 冻结已解
    const me = store.players.find((p) => p.isMe)
    expect(me.wins).toBe(1)
  })
})

// P-0.5 Step7：新建浮层"邀请好友"模式的被邀 NPC 延迟响应调度（挂 friendTimers，LOOP-2 可清）。
describe('scheduleInviteResponses · 浮层内邀约调度', () => {
  it('调度后推进时钟，被邀 NPC 接受成局（第一个同意者）', async () => {
    const { scheduleInviteResponses } = await import('../src/store.js')
    const { vi } = await import('vitest')
    vi.useFakeTimers()
    try {
      const m = invite(['老王'])
      scheduleInviteResponses(m.id, ['老王'])
      vi.advanceTimersByTime(6000)
      const mm = store.matches.find((x) => x.id === m.id)
      expect(mm.status).toBe('matched')
      expect(mm.takerName).toBe('老王')
    } finally {
      vi.useRealTimers()
    }
  })

  it('撤盘后悬挂的响应定时器被清，不命中已删局（LOOP-2）', async () => {
    const { scheduleInviteResponses, cancelMatch } = await import('../src/store.js')
    const { vi } = await import('vitest')
    vi.useFakeTimers()
    try {
      const m = invite(['老王', '阿强'])
      scheduleInviteResponses(m.id, ['老王', '阿强'])
      cancelMatch(m.id) // 撤盘：退冻结 + clearFriendTimers
      const balanceAfterCancel = store.balance
      vi.advanceTimersByTime(10000)
      expect(store.matches.find((x) => x.id === m.id)).toBeUndefined() // 局已删
      expect(store.balance).toBe(balanceAfterCancel) // 无幽灵回调改账
      expect(store.frozen).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
