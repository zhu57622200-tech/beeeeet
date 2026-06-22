// P-0.5 隐私开关：setMyPrivacy 写入"我"的 privacy 字段，且不碰积分。
import { describe, expect, it } from 'vitest'
import { store, me, setMyPrivacy } from '../src/store.js'

describe('P-0.5 隐私开关', () => {
  it('setMyPrivacy 切换并持久化到 players[me].privacy', () => {
    setMyPrivacy(true)
    expect(me().privacy).toBe(true)
    setMyPrivacy(false)
    expect(me().privacy).toBe(false)
  })

  it('truthy/falsy 入参归一为布尔', () => {
    setMyPrivacy(1)
    expect(me().privacy).toBe(true)
    setMyPrivacy(0)
    expect(me().privacy).toBe(false)
  })

  it('切换隐私不碰积分（守恒红线）', () => {
    const before = { balance: store.balance, frozen: store.frozen, ledger: store.ledger.length }
    setMyPrivacy(true)
    setMyPrivacy(false)
    expect({ balance: store.balance, frozen: store.frozen, ledger: store.ledger.length }).toEqual(before)
  })
})
