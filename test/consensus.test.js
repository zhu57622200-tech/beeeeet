import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  store,
  register,
  resetAll,
  inviteMatch,
  npcAcceptInvite,
  createMatch,
  npcBetBanker,
  revealWithDispute,
  proposeReveal,
  castConsensusVote,
  arbiterCandidates,
  inviteArbiter,
  arbiterVerdict,
  scheduleConsensusVotes,
  scheduleArbiterVerdict,
} from '../src/store.js'

beforeEach(() => {
  resetAll()
  register({ name: '我', password: 'x', agreedTerms: true })
})

// 起一个约赌局并让"老王"接盘 → matched（我押 A 10000，赔率 2）。
function matchedDuel() {
  const m = inviteMatch({
    npcNames: ['老王'], title: '谁赢', optionA: '我赢', optionB: '我输',
    ownerSide: 'A', odds: 2, ownerStake: 10000,
  })
  npcAcceptInvite(m.id, '老王')
  return store.matches.find((x) => x.id === m.id)
}

describe('§A 共识揭晓 · 约赌 1v1（unanimous）', () => {
  it('提议后只提议人同意 → 投票中、不结算（守恒）', () => {
    const m = matchedDuel()
    const balBefore = store.balance
    const frozenBefore = store.frozen
    proposeReveal(m.id, 'A')
    expect(m.consensus.status).toBe('voting')
    expect(m.consensus.rule).toBe('unanimous')
    expect(m.consensus.voters).toEqual(['我', '老王'])
    expect(m.consensus.votes).toEqual({ 我: 'agree' })
    // 中间态：积分/冻结/局状态都不动
    expect(store.balance).toBe(balBefore)
    expect(store.frozen).toBe(frozenBefore)
    expect(m.status).toBe('matched')
  })

  it('双方都同意 → 达成共识落账（我押中拿回奖池 20000）', () => {
    const m = matchedDuel()
    const balBefore = store.balance // 已冻结 10000 后的余额
    proposeReveal(m.id, 'A')
    castConsensusVote(m.id, '老王', 'agree')
    expect(m.consensus.status).toBe('passed')
    expect(m.status).toBe('settled')
    expect(m.result).toBe('A')
    expect(store.frozen).toBe(0)
    expect(store.balance).toBe(balBefore + 20000) // 解冻并入奖池
    expect(store.players.find((p) => p.isMe).wins).toBe(1)
  })

  it('对手反对 → 立即僵局，仍不结算', () => {
    const m = matchedDuel()
    const frozenBefore = store.frozen
    proposeReveal(m.id, 'A')
    castConsensusVote(m.id, '老王', 'reject')
    expect(m.consensus.status).toBe('deadlocked')
    expect(m.status).toBe('matched') // 没结算
    expect(store.frozen).toBe(frozenBefore) // 守恒
  })

  it('僵局 → 邀请局外人当评审 → 评审裁定落账（候选不含参与者、状态流转、守恒）', () => {
    const m = matchedDuel()
    proposeReveal(m.id, 'A')
    castConsensusVote(m.id, '老王', 'reject')
    expect(m.consensus.status).toBe('deadlocked')
    // 候选评审必须是没参与本局的人（不含我和老王）
    const cands = arbiterCandidates(m.id)
    expect(cands.length).toBeGreaterThan(0)
    const names = cands.map((c) => c.name)
    expect(names).not.toContain('老王')
    expect(names).not.toContain('我')
    // 邀请一个当评审 → 进 arbitration（已邀请、等裁定），还没落账
    inviteArbiter(m.id, cands[0].name)
    expect(m.consensus.status).toBe('arbitration')
    expect(m.consensus.arbiter).toBe(cands[0].name)
    expect(m.status).toBe('matched') // 还没结算
    // 评审裁定（显式传 A，确定性）→ 落账
    arbiterVerdict(m.id, 'A')
    expect(m.consensus.status).toBe('arbitrated')
    expect(m.consensus.arbitratedResult).toBe('A')
    expect(m.status).toBe('settled')
    expect(store.frozen).toBe(0)
  })

  it('非中立的人不能当评审（参与者被拒）', () => {
    const m = matchedDuel()
    proposeReveal(m.id, 'A')
    castConsensusVote(m.id, '老王', 'reject')
    inviteArbiter(m.id, '老王') // 老王是参与者，不能当评审
    expect(m.consensus.status).toBe('deadlocked') // 没变，邀请被拒
    expect(m.consensus.arbiter).toBeFalsy()
  })
})

describe('§A 共识揭晓 · 坐庄多人（twothirds）', () => {
  it('达到 ceil(N×2/3) 同意即落账', () => {
    const m = createMatch({
      title: '坐庄局', optionA: '红', optionB: '黑',
      mode: 'banker', bankerOdds: 2, bankerCap: 50000,
    })
    npcBetBanker(m.id) // 两个假人来押
    npcBetBanker(m.id)
    expect(m.status).toBe('matched')
    proposeReveal(m.id, 'A')
    expect(m.consensus.rule).toBe('twothirds')
    const voters = m.consensus.voters
    expect(voters.length).toBe(3) // 我 + 2 假人
    // 阈值 ceil(3×2/3)=2：我已同意，再来一个假人同意即过
    castConsensusVote(m.id, voters[1], 'agree')
    expect(m.consensus.status).toBe('passed')
    expect(m.status).toBe('settled')
    expect(store.frozen).toBe(0)
  })
})

describe('§A 揭晓：庄家直接裁定，有异议才投票', () => {
  it('无异议 → 庄家说了算，直接落账（不建共识）', () => {
    const m = matchedDuel()
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9) // >0.2 → 无人异议
    const balBefore = store.balance
    const r = revealWithDispute(m.id, 'A')
    expect(r.disputed).toBe(false)
    expect(m.consensus).toBeFalsy() // 没进共识流程
    expect(m.status).toBe('settled') // 直接结算
    expect(m.result).toBe('A')
    expect(store.balance).toBe(balBefore + 20000) // 我押中拿回奖池
    expect(store.frozen).toBe(0)
    spy.mockRestore()
  })

  it('有异议 → 转共识投票，不直接落账（守恒）', () => {
    const m = matchedDuel()
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.1) // <0.2 → 有异议
    const frozenBefore = store.frozen
    const r = revealWithDispute(m.id, 'A')
    expect(r.disputed).toBe(true)
    expect(m.consensus).toBeTruthy()
    expect(m.consensus.status).toBe('voting')
    expect(m.consensus.proposed).toBe('A')
    expect(m.status).toBe('matched') // 还没结算
    expect(store.frozen).toBe(frozenBefore) // 守恒
    spy.mockRestore()
  })
})

// 参考 friends.test.js「resetAll 后清掉申请 timer」：揭晓流程的假人投票/裁定 timer
// 必须挂 friendTimers，重置存档后随 clearFriendTimers 清掉，阻止幽灵回调写回新状态（LOOP-2）。
describe('§A 幽灵回调防护：重置后悬挂的投票/裁定 timer 被清', () => {
  afterEach(() => {
    resetAll()
    vi.useRealTimers()
  })

  it('resetAll 清掉 scheduleConsensusVotes 的投票 timer，幽灵投票不写回新存档', () => {
    vi.useFakeTimers()
    const m = matchedDuel()
    proposeReveal(m.id, 'A')
    scheduleConsensusVotes(m.id, [{ voter: '老王', vote: 'agree' }])
    resetAll()
    expect(vi.getTimerCount()).toBe(0) // timer 已随 clearFriendTimers 全清
    register({ name: '我', password: 'x', agreedTerms: true })
    const before = { balance: store.balance, frozen: store.frozen, feedLen: store.feed.length }
    vi.advanceTimersByTime(5000)
    expect(store.balance).toBe(before.balance)
    expect(store.frozen).toBe(before.frozen)
    expect(store.feed.length).toBe(before.feedLen)
  })

  it('resetAll 清掉 scheduleArbiterVerdict 的裁定 timer，不产生幽灵裁定', () => {
    vi.useFakeTimers()
    const m = matchedDuel()
    proposeReveal(m.id, 'A')
    castConsensusVote(m.id, '老王', 'reject') // 1v1 全票制 → 僵局
    expect(m.consensus.status).toBe('deadlocked')
    inviteArbiter(m.id, arbiterCandidates(m.id)[0].name)
    scheduleArbiterVerdict(m.id)
    resetAll()
    expect(vi.getTimerCount()).toBe(0)
    register({ name: '我', password: 'x', agreedTerms: true })
    const feedLenBefore = store.feed.length
    vi.advanceTimersByTime(3000)
    expect(store.feed.length).toBe(feedLenBefore) // 没有 reveal_arbitrate 动态
    expect(store.matches.every((x) => x.status !== 'settled')).toBe(true)
  })
})
