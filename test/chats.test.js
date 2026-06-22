import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  store,
  register,
  resetAll,
  chatWith,
  sendChat,
} from '../src/store.js'

beforeEach(() => {
  resetAll()
  register({ name: '我', password: 'x', agreedTerms: true })
})

afterEach(() => {
  resetAll()
  vi.useRealTimers()
})

describe('chats · 朋友私信', () => {
  it('sendChat 后我的消息入列', () => {
    sendChat('老王', '  今晚开一把  ')
    const list = chatWith('老王')
    expect(list.length).toBe(1)
    expect(list[0].from).toBe('me')
    expect(list[0].text).toBe('今晚开一把')
  })

  it('空文本拒绝发送', () => {
    expect(() => sendChat('老王', '   ')).toThrow()
    expect(chatWith('老王')).toEqual([])
  })

  it('NPC 假回复会在 4 秒内到达', () => {
    vi.useFakeTimers()
    sendChat('老王', '敢不敢接')
    vi.advanceTimersByTime(4000)
    const list = chatWith('老王')
    expect(list.length).toBe(2)
    expect(list[1].from).toBe('老王')
    expect(list[1].text).toBeTruthy()
  })

  it('私信前后不改 balance / frozen / ledger', () => {
    vi.useFakeTimers()
    const before = {
      balance: store.balance,
      frozen: store.frozen,
      ledgerLen: store.ledger.length,
    }
    sendChat('老王', '开盘前先聊两句')
    vi.advanceTimersByTime(4000)
    expect(store.balance).toBe(before.balance)
    expect(store.frozen).toBe(before.frozen)
    expect(store.ledger.length).toBe(before.ledgerLen)
  })
})
