import { describe, it, expect, beforeEach } from 'vitest'
import {
  store,
  register,
  resetAll,
  seedInboxInvites,
  inboxPendingCount,
  acceptInboxInvite,
  declineInboxInvite,
  settleMatchStore,
} from '../src/store.js'

beforeEach(() => {
  resetAll()
  register({ name: '我', password: 'x', agreedTerms: true })
})

describe('inbox invites · 收件箱邀约', () => {
  it('seedInboxInvites 补足 pending 到 n，且状态都是 pending', () => {
    seedInboxInvites(3)
    expect(inboxPendingCount()).toBe(3)
    expect(store.inbox.filter((x) => x.status === 'pending')).toHaveLength(3)

    seedInboxInvites(2)
    expect(inboxPendingCount()).toBe(3)

    seedInboxInvites(5)
    expect(inboxPendingCount()).toBe(5)
    expect(store.inbox.filter((x) => x.status === 'pending').every((x) => x.status === 'pending')).toBe(true)
  })

  it('acceptInboxInvite 创建 matched 对赌局，邀请方成为接盘方，并冻结我的下注', () => {
    seedInboxInvites(1)
    const inv = store.inbox.find((x) => x.status === 'pending')
    const beforeBalance = store.balance
    const beforeFrozen = store.frozen
    const beforeMatches = store.matches.length

    const m = acceptInboxInvite(inv.id)

    expect(store.matches.length).toBe(beforeMatches + 1)
    expect(m.status).toBe('matched')
    expect(m.takerName).toBe(inv.fromName)
    expect(m.takerSide).toBe(inv.mySide === 'A' ? 'B' : 'A')
    expect(m.takerStake).toBeGreaterThan(0)
    expect(m.takerJoined).toBe(true)
    expect(store.balance).toBe(beforeBalance - inv.stake)
    expect(store.frozen).toBe(beforeFrozen + inv.stake)
    expect(inv.status).toBe('accepted')
  })

  it('接受成局后可复用 settleMatchStore 正常结算', () => {
    seedInboxInvites(1)
    const inv = store.inbox.find((x) => x.status === 'pending')
    const m = acceptInboxInvite(inv.id)

    settleMatchStore(m.id, inv.mySide, { ownerPayout: Math.round(inv.stake * inv.odds) })

    const mm = store.matches.find((x) => x.id === m.id)
    const me = store.players.find((p) => p.isMe)
    expect(mm.status).toBe('settled')
    expect(store.frozen).toBe(0)
    expect(me.wins).toBe(1)
  })

  it('declineInboxInvite 只标记 declined，不建局不动钱', () => {
    seedInboxInvites(1)
    const inv = store.inbox.find((x) => x.status === 'pending')
    const beforeBalance = store.balance
    const beforeFrozen = store.frozen
    const beforeMatches = store.matches.length

    declineInboxInvite(inv.id)

    expect(inv.status).toBe('declined')
    expect(store.matches.length).toBe(beforeMatches)
    expect(store.balance).toBe(beforeBalance)
    expect(store.frozen).toBe(beforeFrozen)
  })
})
