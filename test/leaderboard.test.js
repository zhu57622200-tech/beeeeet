import { describe, it, expect } from 'vitest'
import {
  wealthBoard,
  predictBoard,
  streakBoard,
  PREDICT_MIN_SETTLED,
} from '../src/core/leaderboard.js'

// 测试夹具：固定一组玩家（含"我"），覆盖排序/门槛/高亮。
function players() {
  return [
    { id: 'me', name: '我', emoji: '🫵', title: '新人', isMe: true, balance: 500_000, wins: 6, losses: 4, maxStreak: 3 },
    { id: 'a', name: '老王', emoji: '🧔', balance: 2_000_000, wins: 20, losses: 5, maxStreak: 8 },
    { id: 'b', name: '阿强', emoji: '😎', balance: 100_000, wins: 1, losses: 0, maxStreak: 1 }, // 1单100% → 神预测榜要被门槛挡掉
    { id: 'c', name: '胖子', emoji: '🐷', balance: 800_000, wins: 3, losses: 7, maxStreak: 5 },
  ]
}

describe('wealthBoard · 身家榜', () => {
  it('按 balance 降序', () => {
    const b = wealthBoard(players())
    expect(b.map((x) => x.name)).toEqual(['老王', '胖子', '我', '阿强'])
    expect(b[0].rank).toBe(1)
    expect(b[3].rank).toBe(4)
  })
  it('value 含格式化积分，sub 是段位名', () => {
    const b = wealthBoard(players())
    expect(b[0].value).toContain('2,000,000')
    expect(typeof b[0].sub).toBe('string')
  })
  it('高亮"我"：isMe 透传', () => {
    const me = wealthBoard(players()).find((x) => x.isMe)
    expect(me.name).toBe('我')
  })
})

describe('predictBoard · 神预测榜（胜率 + 防刷门槛）', () => {
  it('门槛默认 5，阿强 1 单 100% 不进榜（防屠榜）', () => {
    const b = predictBoard(players())
    expect(b.some((x) => x.name === '阿强')).toBe(false)
  })
  it('达门槛者按胜率降序', () => {
    // 老王 80%、我 60%、胖子 30%
    const b = predictBoard(players())
    expect(b.map((x) => x.name)).toEqual(['老王', '我', '胖子'])
  })
  it('胜率相同则结算单数多者在前', () => {
    const ps = [
      { id: 'x', name: 'X', balance: 0, wins: 6, losses: 6, maxStreak: 0 }, // 50% / 12单
      { id: 'y', name: 'Y', balance: 0, wins: 3, losses: 3, maxStreak: 0 }, // 50% / 6单
    ]
    expect(predictBoard(ps).map((x) => x.name)).toEqual(['X', 'Y'])
  })
  it('可调门槛：minSettled=11 时只剩老王（我/胖子各 10 单被挡）', () => {
    const b = predictBoard(players(), 11)
    expect(b.map((x) => x.name)).toEqual(['老王'])
  })
  it('恰好达门槛（5 单）就进榜', () => {
    const ps = [{ id: 'z', name: 'Z', balance: 0, wins: 2, losses: 3, maxStreak: 0 }]
    expect(predictBoard(ps).length).toBe(1)
  })
  it('PREDICT_MIN_SETTLED 导出为 5', () => {
    expect(PREDICT_MIN_SETTLED).toBe(5)
  })
  it('value 是胜率百分比，sub 是胜负战绩', () => {
    const me = predictBoard(players()).find((x) => x.isMe)
    expect(me.value).toBe('60%')
    expect(me.sub).toBe('6 胜 4 负')
  })
})

describe('streakBoard · 连胜榜', () => {
  it('按 maxStreak 降序', () => {
    const b = streakBoard(players())
    expect(b.map((x) => x.name)).toEqual(['老王', '胖子', '我', '阿强'])
  })
  it('value 含连胜数，高亮"我"', () => {
    const me = streakBoard(players()).find((x) => x.isMe)
    expect(me.value).toContain('3')
    expect(me.isMe).toBe(true)
  })
})

describe('排行榜 · 边界', () => {
  it('空 players 不报错，返回空数组', () => {
    expect(wealthBoard([])).toEqual([])
    expect(predictBoard([])).toEqual([])
    expect(streakBoard([])).toEqual([])
  })
  it('缺省参数不报错', () => {
    expect(wealthBoard()).toEqual([])
    expect(predictBoard()).toEqual([])
    expect(streakBoard()).toEqual([])
  })
  it('streakBoard：缺 maxStreak 的玩家按 0 计、排在有连胜者之后（防 NPC 字段缺失回归）', () => {
    const ps = [
      { id: 'no', name: '无字段', balance: 0, wins: 5, losses: 5 }, // 无 maxStreak
      { id: 'has', name: '有连胜', balance: 0, wins: 5, losses: 5, maxStreak: 7 },
    ]
    const b = streakBoard(ps)
    expect(b[0].name).toBe('有连胜')
    expect(b[1].value).toContain('0')
  })
  it('predictBoard：minSettled=0 不产生 NaN%（0胜0负被 safe 门槛挡掉）', () => {
    const ps = [{ id: 'zero', name: '零战绩', balance: 0, wins: 0, losses: 0 }]
    const b = predictBoard(ps, 0)
    expect(b.every((x) => !x.value.includes('NaN'))).toBe(true)
  })
})
