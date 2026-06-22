import { reactive, watch } from 'vue'
import { api, createPoller, getToken, setAuthExpiredHandler, setToken } from './api-client.js'
import { takerStakeFor, settleBanker, settlePool } from './core/wager.js'
import { isSideBetOverdue, offlineScoreDelta } from './core/offline.js'
import { isStaleOpen, validateAppeal, resolveAppeal, tallyConsensus } from './core/governance.js'
import {
  canClaimSupply,
  msUntilNextSupply,
  SUPPLY_AMOUNT,
  validateTransfer,
  applyRepPenalty,
  deadbeatBoard,
} from './core/economy.js'
import { fetchPolymarketEvents, enrichEventsWithDS, parseOutcomes, fetchPmResultById, aggregateOutright, classifySubcat, groupMatchMarkets, isMatchEvent, isSensitiveEvent } from './api.js'
import { playTypeDescZh, playTypeZh, translateEntityLocal } from './core/i18n-sports.js'

// 单机本地存储（S1 数据层地基：players[] / 账号 / ledger[]）。
//
// 设计取舍（原型阶段，外科手术、兼容优先）：
// - players[] 是统一玩家模型：1 个"我"(isMe) + 6 个熟人 NPC。NPC 的
//   balance/wins/... 仅供后续榜单展示；"我"的资产是真正参与玩法的数据。
// - 为了不动现有组件（它们大量读 store.balance / store.frozen /
//   store.matches / store.pmBets），这四个**顶层字段仍是"当前登录玩家"的
//   规范数据源**；每次变动后用 syncMe() 把余额/冻结回写进 players[] 里的
//   "我"，保持 players 与顶层一致（单一写入口，避免双源漂移）。
// - ledger[] 记录每一笔积分变动，供审计/对账（需求 §5.15 账本前置 M1）。
// - 账号(昵称+密码)仅本地原型：密码明文存 localStorage（localStorage 本就
//   不进 git）。接云后必须移到后端做 hash + 校验，前端绝不留密码。
const KEY = 'liaoshi_state_v2'
const INITIAL_BALANCE = 1_000_000
// 注册/改头像可选动物头像（爹地 2026-06-12 拍板：10 只动物，各扣预测对赌气质）。
// 夜枭/鹰隼/狐狸/孤狼/鲨鱼/猛虎/雄狮/神龙/公牛/章鱼保罗(世界杯预测之神)
export const EMOJIS = ['🦉', '🦅', '🦊', '🐺', '🦈', '🐅', '🦁', '🐉', '🐂', '🐙']
// 头像寓意（hover/选中提示，登录页与账号页共用）
export const EMOJI_LABELS = {
  '🦉': '夜枭 · 看准了才出手',
  '🦅': '鹰隼 · 鹰眼俯瞰大势',
  '🦊': '狐狸 · 精明读局识人',
  '🐺': '孤狼 · 我不跟风',
  '🦈': '鲨鱼 · 闻血而动的高手',
  '🐅': '猛虎 · 果断一击单杀',
  '🦁': '雄狮 · 赌桌之王',
  '🐉': '神龙 · 气运王炸 all in',
  '🐂': '公牛 · 稳健看多长线',
  '🐙': '章鱼保罗 · 世界杯预测之神',
}
const IS_TEST = import.meta.env?.MODE === 'test'
const API_IN_TEST = IS_TEST && fetchIsMocked()

function fetchIsMocked() {
  return Boolean(globalThis.fetch?._isMockFunction || globalThis.fetch?.mock)
}

function shouldUseApi() {
  if (IS_TEST) return API_IN_TEST
  return true
}

// 组件用：当前是否联机模式（联机下隐藏单机专属的假人交互入口）
export function isOnline() {
  return shouldUseApi()
}

function uiLocalState(s) {
  return {
    onboarded: !!s.onboarded,
    agreedTerms: !!s.agreedTerms,
    lastSeenAt: s.lastSeenAt || 0,
    syncCursor: s.syncCursor || 0,
    pmCache: s.pmCache || { byId: {}, fetchedAt: 0, pinnedIds: [] },
    watchlist: s.watchlist || { matches: [], pm: [] },
  }
}

// 熟人 NPC 池（饭桌上那帮人）。
export const NPCS = [
  { name: '老王', emoji: '🧔', title: '原油预言家' },
  { name: '阿强', emoji: '😎', title: '梭哈之王' },
  { name: '胖子', emoji: '🐷', title: '反向指标人' },
  { name: '眼镜', emoji: '🤓', title: '数据帝' },
  { name: '二饼', emoji: '🀄', title: '赌神在世' },
  { name: '老李', emoji: '👴', title: '稳健派' },
]
const INITIAL_FRIENDS = ['老王', '阿强', '老李']

function npcPhone(index) {
  return `138${String(index + 1).padStart(8, '0')}`
}

// 接盘时甩的垃圾话。
const TAKER_TALK = [
  '这把我接了，你输定了😏',
  '就这？闭着眼押对面',
  '来来来，让你见识见识什么叫眼光',
  '你这盘开得跟送钱一样',
  '接了，输了别哭',
  '我赌你这次又看走眼',
]
// 围观不下注的吐槽。
const WATCH_TALK = [
  '这题有意思，蹲个结果',
  '楼主怕不是要喜提破产',
  '我站队接盘的，稳',
  '坐等打脸现场',
  '这赔率开得有点东西啊',
]
// 私信里 NPC 假回复的嘴炮池。
const CHAT_TALK = [
  '就这水平还想赢我？',
  '明天开个盘，让你输得明白。',
  '别光嘴硬，拿积分说话。',
  '你先把上把的脸捡起来再聊。',
  '我看你这把又要当反向指标。',
  '行啊，等你开盘，我来收分。',
  '少来套情报，牌桌上见真章。',
  '你这预测我闭眼都能反着押。',
  '别怂，赔率开高点才有意思。',
  '今晚不把你打醒，算我输。',
]
// 系统盘留言板 NPC 预设氛围评论（零 API，营造「大家在聊」的赌场氛围）。
// 不针对具体盘内容（不调 AI），都是通用口水，进盘时随机抽几条 seed。
const PM_BOARD_TALK = [
  '这盘我押了，不信邪 🎲',
  '概率都摆这了还有人对着干？图一乐呗',
  '跟一手，输了当交学费',
  '庄家最爱你们这种铁头娃',
  '我蹲个结果，先不急着下手',
  '这种盘闭眼押热门不就完了',
  '上次跟你们押全错，这次我反着来',
  '赔率有点意思，值得赌一把',
  '别问，问就是梭哈 😎',
  '我数据看了三遍，这把稳',
  '热闹热闹，进来看看大伙押啥',
  '理性分析：没什么好分析的，开赌',
]

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1))
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

// 一个空的"我"占位（未登录）：登录/注册后填昵称、称号、余额。
function makeEmptyMe() {
  return {
    id: 'me',
    name: '',
    emoji: '🫵',
    phone: '',
    title: '新人玩家',
    isMe: true,
    password: '',
    balance: 0,
    frozen: 0,
    wins: 0,
    losses: 0,
    streak: 0,
    maxStreak: 0, // 历史最大连胜（S3 对战史）
    bestWinOdds: 0, // 命中过的最高赔率（"最神预测"，S3）
    reputation: 100,
    privacy: false, // P-0.5 隐私开关：true=别人在朋友页看不到我的最近赌局/动态
    createdAt: 0,
  }
}

// 预置一个熟人 NPC，给随机初始战绩让后续榜单有数据。
function makeNpc(def, index = 0) {
  const wins = randInt(3, 40)
  const losses = randInt(2, 35)
  return {
    id: uid(),
    name: def.name,
    emoji: def.emoji,
    phone: npcPhone(index),
    title: def.title,
    isMe: false,
    password: '',
    balance: randInt(200_000, 2_500_000),
    frozen: 0,
    wins,
    losses,
    streak: randInt(-4, 8),
    maxStreak: Math.max(0, randInt(2, 14)), // 历史最大连胜(连胜榜需要)
    reputation: randInt(60, 100),
    privacy: def.name === '老李', // 演示隐私开关：固定让"老李"设隐私（朋友页可见遮挡效果）
    createdAt: Date.now(),
  }
}

function freshState() {
  return {
    // —— 统一玩家模型 ——
    // 联机模式 players 全部来自服务器真值，绝不播种本地假 NPC（单机/测试保留）
    players: [makeEmptyMe(), ...(shouldUseApi() ? [] : NPCS.map(makeNpc))],
    currentId: 'me',
    // —— 账本流水 ——
    ledger: [],
    // —— 当前登录玩家的玩法数据（顶层规范源，供现有组件直接读）——
    balance: 0, // = 我的可用余额（登录后置 100 万）
    frozen: 0, // = 我未结算赌局冻结总额
    matches: [], // 我开/参与的个人对赌局（联机版被全站大厅列表覆盖，见 syncOnce）
    myMatches: [], // 联机版"我的对赌"独立源：我 owner/taker/下注的局，随 /me+/sync 下发
    inbox: [], // NPC 邀请"我"参与的约赌邀约
    pmBets: [], // 我的 Polymarket 押注记录
    // —— 系统盘缓存（S15）——
    // byId[id] = { zhTitle, zhOutcomes:[], category, prob, volume, createdAt, compliant }
    // fetchedAt：上次拉取+加工的时间戳，>24h 触发重拉（增量只 enrich 新盘，省钱）。
    // pinnedIds（S16）：用户押注/关注过的盘口 id 集合（钉住）。钉住盘永久保留在 byId、
    //   不被每日清理删除，直到结算进历史后释放。独立数组便于序列化/兼容旧档。
    pmCache: { byId: {}, fetchedAt: 0, pinnedIds: [] },
    // —— 系统盘留言板（替代原 DeepSeek 预测）——
    // pmComments[eventId] = [{ id, by, emoji, text, at, npc }]。本地单机：我发的留言 +
    // 进盘 seed 的 NPC 预设氛围评论；全局共享（系统盘数据，不随账号切换），接云后换真人。
    pmComments: {},
    // —— 朋友私信（P-0.5 单机版：NPC 假回复）——
    // chats[friendName] = [{ id, from:'me'|friendName, text, at }]，升序展示。
    chats: {},
    // —— 好友关系（P-0.5 单机版）——
    // friendships[玩家名] = 'friend' | 'requested'；键不存在就是圈子里的人（非好友）。
    friendships: Object.fromEntries(INITIAL_FRIENDS.map((name) => [name, 'friend'])),
    // —— 好友申请（别人申请加我，待我处理）——
    friendRequests: [],
    // —— 关注/收藏（S2）——
    watchlist: {
      matches: [], // 收藏的个人对赌 id 列表
      pm: [],      // 收藏的 Polymarket event id 列表
    },
    // —— 对战史（S3）：我对每个对手的战绩 ——
    // rivals[对手名] = { wins, losses, history:[{matchId,title,iWon,at}] }
    // wins = 我赢该对手的次数；history 倒序（最新在前）。
    rivals: {},
    // —— 社交动态流（S4 §5.10 粘性内核）——
    // feed[] 倒序（最新在前）。事件结构见 feedPush()。
    feed: [],
    // 上次查看动态流的时间戳，用于通知红点未读计数（§5.14）。
    lastSeenAt: Date.now(),
    // —— 打球/线下对战记录（S8 §5.5）——
    // offlineMatches[] 倒序：{ id, rivalName, rivalEmoji, sport, score, iWon,
    //   stake, settled, sideBet?, at }。同时并入 rivals.history(type:'offline')。
    offlineMatches: [],
    // —— 经济治理（S9 §5.11）——
    // 上次领周补给的时间戳（null=从未领过，可立即领）。
    lastSupplyAt: null,
    // 当前赛季开始时间戳（赛季重置时刷新）；archives[] 存历史赛季战绩快照。
    seasonStartAt: Date.now(),
    seasonArchives: [], // [{ endedAt, wins, losses, maxStreak, bestWinOdds, balance }]
    // —— 治理补全（S10 §5.15 / §5.8）——
    agreedTerms: false, // 准入声明：是否已勾选同意"仅限成年熟人/虚拟娱乐/非赌博"（注册前必须 true）
    onboarded: false,   // 新用户引导：是否已看过/跳过首登引导
    // 申诉复议记录（§5.8）。倒序：{ id, matchId, title, reason, stake, status, verdict?, newResult?, at, resolvedAt? }
    //   status: 'pending'(待终审) | 'resolved'(已裁定)；verdict: 'uphold'|'overturn'。
    appeals: [],
    reportedCheats: [],
    syncCursor: 0,
    onlineCount: 0,
    unreadChats: 0,
    friendRequestCount: 0,
    announcement: null,
  }
}

function loadLocalState() {
  try {
    if (typeof globalThis.localStorage?.getItem !== 'function') return freshState()
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const s = JSON.parse(raw)
      // 兜底：旧档缺字段时补齐，避免组件读到 undefined。
      // 先剔除 players 里的 null/损坏条目——否则下面任何 p.xxx 访问抛错会被外层
      // catch 吞掉并 freshState() 全量重置，整份存档静默丢失（数据丢失级，必须防）。
      if (Array.isArray(s.players)) s.players = s.players.filter((p) => p && typeof p === 'object')
      if (!Array.isArray(s.players) || !s.players.some((p) => p.isMe)) {
        s.players = [makeEmptyMe(), ...(shouldUseApi() ? [] : NPCS.map(makeNpc))]
      }
      if (!shouldUseApi()) {
        const existingNpcNames = new Set(s.players.filter((p) => !p.isMe).map((p) => p.name))
        NPCS.forEach((def, i) => {
          if (!existingNpcNames.has(def.name)) s.players.push(makeNpc(def, i))
        })
      } else {
        // 联机：清掉历史播种的本地假 NPC（无 id 的非我条目），防与服务器真人撞名
        s.players = s.players.filter((p) => p.isMe || p.id != null)
      }
      s.players.forEach((p) => {
        if (p.isMe) {
          if (typeof p.phone !== 'string') p.phone = ''
          if (typeof p.emoji !== 'string' || !p.emoji) p.emoji = '🫵'
        } else {
          const i = NPCS.findIndex((n) => n.name === p.name)
          if (i !== -1 && !/^1\d{10}$/.test(String(p.phone || ''))) p.phone = npcPhone(i)
        }
      })
      if (!s.currentId) s.currentId = 'me'
      if (!Array.isArray(s.ledger)) s.ledger = []
      if (!Array.isArray(s.matches)) s.matches = []
      if (!Array.isArray(s.myMatches)) s.myMatches = []
      if (!Array.isArray(s.inbox)) s.inbox = []
      if (!Array.isArray(s.pmBets)) s.pmBets = []
      // S11：旧押注(无 status)补全为 pending，否则结算被锁死
      s.pmBets.forEach((b) => {
        if (!b.status) { b.status = 'pending'; b.result = b.result ?? null; b.payout = b.payout ?? 0; b.settledAt = b.settledAt ?? null }
        if (typeof b.zhOutcome !== 'string') b.zhOutcome = b.outcome || '' // 旧押注补中文显示名（降级英文）
        if (typeof b.marketId === 'undefined') b.marketId = null // P1 旧押注无 marketId，结算仍走 eventId
      })
      if (typeof s.balance !== 'number') s.balance = 0
      if (typeof s.frozen !== 'number') s.frozen = 0
      // S15：系统盘缓存兼容旧存档
      if (!s.pmCache || typeof s.pmCache !== 'object') s.pmCache = { byId: {}, fetchedAt: 0 }
      if (!s.pmCache.byId || typeof s.pmCache.byId !== 'object') s.pmCache.byId = {}
      if (typeof s.pmCache.fetchedAt !== 'number') s.pmCache.fetchedAt = 0
      // S16：钉住集合兼容旧档（旧档缺 → 用现有押注/关注 id 重建，防老盘被清理误删）。
      if (!Array.isArray(s.pmCache.pinnedIds)) {
        const seed = new Set()
        s.pmBets.forEach((b) => { if (b.eventId != null && b.status === 'pending') seed.add(String(b.eventId)) })
        ;(s.watchlist?.pm || []).forEach((id) => seed.add(String(id)))
        s.pmCache.pinnedIds = [...seed]
      }
      // 系统盘留言板兼容旧存档
      if (!s.pmComments || typeof s.pmComments !== 'object') s.pmComments = {}
      // 朋友私信兼容旧存档
      if (!s.chats || typeof s.chats !== 'object') s.chats = {}
      // 好友关系兼容旧存档：旧档默认老王/阿强/老李是好友，其余熟人是圈子里的人。
      if (!s.friendships || typeof s.friendships !== 'object' || Array.isArray(s.friendships)) {
        s.friendships = Object.fromEntries(INITIAL_FRIENDS.map((name) => [name, 'friend']))
      } else {
        // ⚠️ 按 NPCS 名单清洗仅限单机版（players 只可能是这 6 个 NPC）；联机版 store 重构时此行必须随真人名单调整。
        // 'requested' 不保留：同意它的 timer 只活在内存里，刷新后永远无人推进 → 卡死且无法重新申请，
        // 降级删除让用户可重新发申请（Double check 总复核修订）。
        for (const [name, status] of Object.entries(s.friendships)) {
          if (!NPCS.some((n) => n.name === name) || status !== 'friend') {
            delete s.friendships[name]
          }
        }
      }
      if (!Array.isArray(s.friendRequests)) s.friendRequests = []
      s.friendRequests = s.friendRequests.filter((r) => r && typeof r.id === 'string' && typeof r.fromName === 'string')
      // S2：watchlist 兼容旧存档
      if (!s.watchlist || typeof s.watchlist !== 'object') {
        s.watchlist = { matches: [], pm: [] }
      }
      if (!Array.isArray(s.watchlist.matches)) s.watchlist.matches = []
      if (!Array.isArray(s.watchlist.pm)) s.watchlist.pm = []
      // 归一成 String：缓存盘 id 一律 String(ev.id)，旧档若存过 number 会让 isWatched 严格比较失配（关注盘静默消失）
      s.watchlist.pm = s.watchlist.pm.map(String)
      // S3：rivals 对战史 + 我的战绩字段兼容旧存档
      if (!s.rivals || typeof s.rivals !== 'object') s.rivals = {}
      // S4：动态流 + 通知红点兼容旧存档
      if (!Array.isArray(s.feed)) s.feed = []
      if (typeof s.lastSeenAt !== 'number') s.lastSeenAt = Date.now()
      // S8：打球线下对战记录兼容旧存档
      if (!Array.isArray(s.offlineMatches)) s.offlineMatches = []
      // S9：经济治理字段兼容旧存档
      if (typeof s.lastSupplyAt === 'undefined') s.lastSupplyAt = null
      if (typeof s.seasonStartAt !== 'number') s.seasonStartAt = Date.now()
      if (!Array.isArray(s.seasonArchives)) s.seasonArchives = []
      // S10：治理补全字段兼容旧存档
      if (typeof s.agreedTerms !== 'boolean') s.agreedTerms = false
      if (typeof s.onboarded !== 'boolean') s.onboarded = false
      if (!Array.isArray(s.appeals)) s.appeals = []
      if (!Array.isArray(s.reportedCheats)) s.reportedCheats = []
      // 给所有玩家补 reputation(老赖榜/信誉需要,旧档 NPC 可能缺)。
      s.players.forEach((p) => {
        if (typeof p.reputation !== 'number') p.reputation = p.isMe ? 100 : 100
      })
      // 给所有玩家补 maxStreak(连胜榜需要,旧档 NPC 可能缺)；bestWinOdds 只"我"用。
      s.players.forEach((p) => {
        if (typeof p.maxStreak !== 'number') p.maxStreak = Math.max(0, p.streak || 0)
      })
      // P-0.5：隐私开关兼容旧档（无此字段→默认公开；演示 NPC 老李补 true，效果可见）
      s.players.forEach((p) => {
        if (typeof p.privacy !== 'boolean') p.privacy = !p.isMe && p.name === '老李'
      })
      const m0 = s.players.find((p) => p.isMe)
      if (m0 && typeof m0.bestWinOdds !== 'number') m0.bestWinOdds = 0
      return s
    }
  } catch (e) {
    console.warn('读取本地存档失败，重置:', e)
  }
  return freshState()
}

export const store = reactive(loadLocalState())

watch(
  store,
  (s) => {
    try {
      if (typeof globalThis.localStorage?.setItem !== 'function') return
      localStorage.setItem(KEY, JSON.stringify(uiLocalState(s)))
    } catch (e) {
      console.warn('写入本地存档失败:', e)
    }
  },
  { deep: true }
)

function upsertById(list, item) {
  if (!item || item.id == null) return
  const idx = list.findIndex((x) => String(x.id) === String(item.id))
  if (idx === -1) list.unshift(item)
  else list[idx] = { ...list[idx], ...item }
}

// 服务器留言行 → 模板期望形状（by/slap/at）
function normalizeComment(c) {
  return {
    id: c.id,
    by: c.by ?? c.name,
    emoji: c.emoji,
    text: c.text,
    slap: c.slap ?? Boolean(c.isSlap),
    replyToCommentId: c.replyToCommentId ?? c.reply_to_comment_id ?? null,
    replyToName: c.replyToName ?? c.reply_to_name ?? '',
    replyToText: c.replyToText ?? c.reply_to_text ?? '',
    at: c.at ?? c.createdAt,
    npc: false,
  }
}

// 服务器 match → 组件期望形状：comments 永远是数组（列表响应不带留言时保留旧值）、
// sideBetText 还原成单机的 sideBet 对象、takerJoined 由 takerId 派生。
function normalizeMatch(m, prev) {
  const next = { ...prev, ...m }
  next.comments = Array.isArray(m.comments) ? m.comments.map(normalizeComment) : (prev?.comments || [])
  if (!next.sideBet && next.sideBetText) next.sideBet = { text: next.sideBetText, fulfilled: false }
  // 联机数据(有 ownerId)纯由 takerId 派生（可回退 false，撤盘/作废后不残留 true）；
  // 本地旧数据无 ownerId 才保留历史标记
  next.takerJoined = next.ownerId != null ? next.takerId != null : (Boolean(next.takerId) || Boolean(next.takerJoined))
  return next
}

export function applyServerState(data = {}) {
  if (!data || typeof data !== 'object') return data

  const serverMe = data.me || data.user
  if (serverMe && typeof serverMe === 'object') {
    const current = me() || makeEmptyMe()
    const next = { ...current, ...serverMe, isMe: true, password: '' }
    store.currentId = next.id ?? store.currentId
    const idx = store.players.findIndex((p) => p.isMe || String(p.id) === String(next.id))
    if (idx === -1) store.players.unshift(next)
    else store.players[idx] = next
    if (typeof serverMe.balance === 'number') store.balance = serverMe.balance
    if (typeof serverMe.frozen === 'number') store.frozen = serverMe.frozen
    if (typeof serverMe.unreadChats === 'number') store.unreadChats = serverMe.unreadChats
    if (typeof serverMe.friendRequests === 'number') store.friendRequestCount = serverMe.friendRequests
    if (typeof serverMe.canSupply === 'boolean') store.canSupply = serverMe.canSupply
    if (typeof serverMe.supplyCountdownMs === 'number') store.supplyCountdownMs = serverMe.supplyCountdownMs
  }

  if (Array.isArray(data.players)) store.players = data.players.map((p) => ({ ...p, password: '', isMe: String(p.id) === String(store.currentId) }))
  if (Array.isArray(data.matches)) {
    const prevById = new Map(store.matches.map((x) => [String(x.id), x]))
    store.matches = data.matches.map((m) => normalizeMatch(m, prevById.get(String(m.id))))
  }
  if (Array.isArray(data.myMatches)) {
    const prevMine = new Map(store.myMatches.map((x) => [String(x.id), x]))
    store.myMatches = data.myMatches.map((m) => normalizeMatch(m, prevMine.get(String(m.id))))
  }
  if (data.match) {
    const prev = store.matches.find((x) => String(x.id) === String(data.match.id))
    upsertById(store.matches, normalizeMatch(data.match, prev))
  }
  if (Array.isArray(data.pmBets)) store.pmBets = data.pmBets
  if (data.bet) upsertById(store.pmBets, data.bet)
  if (Array.isArray(data.feed)) {
    const seen = new Set(store.feed.map((e) => String(e.id)))
    const incoming = data.feed.filter((e) => !seen.has(String(e.id))).map((e) => ({ ...e, at: e.at ?? e.createdAt }))
    store.feed = [...incoming, ...store.feed].sort((a, b) => Number(b.id || b.at || 0) - Number(a.id || a.at || 0)).slice(0, 100)
  }
  if (typeof data.cursor === 'number') store.syncCursor = data.cursor
  if (typeof data.onlineCount === 'number') store.onlineCount = data.onlineCount
  if (data.announcement !== undefined) store.announcement = data.announcement
  if (data.banner !== undefined) store.banner = data.banner
  if (data.friends) {
    store.friends = data.friends.friends || []
    store.friendIncoming = data.friends.incoming || []
    store.friendOutgoing = data.friends.outgoing || []
    // 好友/申请人也并进 players（FriendsView 等组件读 players 渲染人）
    for (const p of [...store.friends, ...store.friendIncoming, ...store.friendOutgoing]) {
      if (p && p.id != null && String(p.id) !== String(store.currentId)) {
        const idx = store.players.findIndex((x) => String(x.id) === String(p.id))
        if (idx === -1) store.players.push({ ...p, isMe: false, password: '' })
        else store.players[idx] = { ...store.players[idx], ...p }
      }
    }
  }
  if (data.comments && data.eventId != null) store.pmComments[String(data.eventId)] = data.comments
  return data
}

// 动钱操作统一出口：响应回写后立刻追拍一次 /sync，余额/冻结即时上屏（不等 30s 轮询）。
function mutateMoney(path, body, prefix) {
  return api.mutate(path, body, prefix).then((data) => {
    applyServerState(data)
    syncOnce().catch(() => {})
    return data
  })
}

// 当前登录玩家对象（players[] 里 isMe 的那个）。
export function me() {
  return store.players.find((p) => p.id === store.currentId) || store.players.find((p) => p.isMe)
}

// 是否已登录（已设昵称+密码）。
export function isLoggedIn() {
  if (shouldUseApi()) return !!getToken()
  const m = me()
  return !!(m && m.name && m.password)
}

// 把顶层 balance/frozen 回写进"我"，保持 players[] 与顶层一致。
function syncMe() {
  const m = me()
  if (!m) return
  m.balance = store.balance
  m.frozen = store.frozen
}

let poller = null

function stopPoller() {
  poller?.stop()
  poller = null
}

function startPoller() {
  if (!shouldUseApi() || poller || typeof document === 'undefined') return
  poller = createPoller(() => syncOnce(), { intervalMs: 30_000 })
  poller.start()
}

setAuthExpiredHandler(() => {
  stopPoller()
  setToken('')
  store.authEpoch = (store.authEpoch || 0) + 1 // 让 UI 的登录态 computed 立即重算
})

export function syncOnce() {
  const since = Number(store.syncCursor || 0)
  // 大厅列表随 /sync 节奏一起刷（§7）——否则别人开的盘永远到不了本地
  const lobby = api.get('/matches?limit=50', { countLoading: false })
    .then((data) => applyServerState(data))
    .catch(() => {})
  return api.get(`/sync?since=${encodeURIComponent(since)}`, { countLoading: false })
    .then((data) => applyServerState(data))
    .then((data) => lobby.then(() => data))
}

export const syncNow = syncOnce

export function load() {
  if (!shouldUseApi() || !getToken()) return Promise.resolve(store)
  return api.get('/me', { countLoading: false })
    .then((data) => {
      applyServerState(data)
      refreshFriends().catch(() => {}) // 好友列表登录即拉（FriendsView 数据源）
      startPoller()
      return store
    })
}

// 记一笔账本流水。type: freeze | unfreeze | settle_win | settle_lose | pm_bet | grant | transfer
function ledgerPush({ type, amount, balanceAfter, ref }) {
  store.ledger.unshift({
    id: uid(),
    playerId: store.currentId,
    type,
    amount, // 正=入账，负=出账（冻结记负，解冻/赢记正）
    balanceAfter,
    ref: ref || null, // 关联对象 id（matchId / betId 等）
    at: Date.now(),
  })
}

// ---------- 社交动态流 + 通知红点（S4 §5.10 / §5.14）----------

// 往动态流 push 一条事件。倒序（最新在前），裁到最近 100 条防膨胀。
// 事件结构：{ id, type, actorName, actorEmoji, text, ref, at }
//   type: 'open'(开盘) | 'join'(接盘) | 'settle'(揭晓) | 'streak'(连胜达成)
//   ref: 关联的 matchId，点动态可跳详情。
function feedPush({ type, actorName, actorEmoji, text, ref }) {
  store.feed.unshift({
    id: uid(),
    type,
    actorName,
    actorEmoji: actorEmoji || '🙂',
    text,
    ref: ref || null,
    at: Date.now(),
  })
  if (store.feed.length > 100) store.feed.length = 100
}

// 未读通知数：feed 里 at>lastSeenAt 且 actor 非"我"的事件数（§5.14）。
export function unreadCount() {
  const myName = me()?.name
  return store.feed.filter((e) => e.at > store.lastSeenAt && e.actorName !== myName).length
}

// 未读事件列表（弹"你不在时发生了什么"摘要用），倒序。
export function unreadFeed() {
  const myName = me()?.name
  return store.feed.filter((e) => e.at > store.lastSeenAt && e.actorName !== myName)
}

// 看完通知：把 lastSeenAt 推进到最新，红点清零。
export function markSeen() {
  store.lastSeenAt = Date.now()
}

// ---------- 账号体系（昵称 + 密码，本地原型）----------

// 首次注册：设昵称+密码 → 填充"我"，送 100 万积分。
//   agreedTerms：准入声明勾选（§5.15 合规，必须同意才能注册）。
export function register({ name, password, phone, emoji, note = '', inviteCode = '', agreedTerms }) {
  if (shouldUseApi()) {
    return api.post('/auth/register', {
      name,
      password,
      phone,
      emoji,
      note,
      inviteCode,
      agreedTerms,
    }).then((data) => {
      setToken(data.token || '')
      applyServerState(data)
      refreshFriends().catch(() => {}) // 进入即拉好友（否则朋友页空白，要刷新才出现）
      startPoller()
      return me()
    })
  }
  // 防重复注册：本机已有账号(已设昵称+密码)就不允许再注册，否则会重置余额到100万。
  if (isLoggedIn()) throw new Error('本机已有账号了，换号请用「换账号/找回」')
  // 合规红线：未勾选准入声明（成年/虚拟娱乐/非赌博）不允许注册。
  if (!agreedTerms) throw new Error('请先阅读并勾选准入声明')
  name = (name || '').trim()
  if (!name) throw new Error('请输入昵称')
  if (!password) throw new Error('请输入密码')
  // 手机号必填语义：完全没传参数（旧测试/旧调用方没有 phone 概念）才兜底假号；
  // 传了（注册页永远会传，哪怕空串）就必须是合法 11 位——空着提交在这里被拒，"必填"不被静默兜底架空。
  const phoneText = phone === undefined ? '13900000000' : String(phone).trim()
  if (!/^1\d{10}$/.test(phoneText)) throw new Error('请输入 11 位中国手机号')
  // 昵称查重（熟人圈，昵称即身份）。
  if (store.players.some((p) => !p.isMe && p.name === name)) {
    throw new Error('这个昵称已被熟人占用，换一个')
  }
  // 手机号查重（与联机版 PHONE_TAKEN 同语义；防注册成 NPC 假号导致搜索串人）。
  if (store.players.some((p) => !p.isMe && p.phone === phoneText)) {
    throw new Error('这个手机号已被熟人占用')
  }
  const m = me()
  m.name = name
  m.password = password // 原型明文；接云后移后端 hash
  m.phone = phoneText
  m.emoji = emoji || '🫵'
  m.createdAt = Date.now()
  m.balance = INITIAL_BALANCE
  m.frozen = 0
  store.currentId = m.id
  store.balance = INITIAL_BALANCE
  store.frozen = 0
  store.agreedTerms = true // 记录已同意准入声明（合规留痕）
  ledgerPush({ type: 'grant', amount: INITIAL_BALANCE, balanceAfter: INITIAL_BALANCE, ref: 'signup' })
  return m
}

// 标记新用户引导已完成/跳过（§5.15）。首登展示一次，看完不再弹。
export function finishOnboarding() {
  store.onboarded = true
}

// 换账号/找回：用昵称+密码校验"我"这个账号。
// 原型只有一个本地"我"账号，校验通过即恢复登录态。
export function login({ name, password }) {
  if (shouldUseApi()) {
    return api.post('/auth/login', { name, password }).then((data) => {
      setToken(data.token || '')
      applyServerState(data)
      refreshFriends().catch(() => {}) // 进入即拉好友（否则朋友页空白，要刷新才出现）
      startPoller()
      return me()
    })
  }
  name = (name || '').trim()
  const m = me()
  if (!m || !m.name) throw new Error('本机还没有账号，请先注册')
  if (m.name !== name || m.password !== password) {
    throw new Error('昵称或密码不对')
  }
  store.currentId = m.id
  // 顶层与 me 对齐（防御性）。
  store.balance = m.balance
  store.frozen = m.frozen
  return m
}

// 自助找回：昵称+手机号验证通过 → 重设新密码并直接登录（联机）。
export function recoverAccount({ name, phone, newPassword }) {
  if (shouldUseApi()) {
    return api.mutate('/auth/recover', { name, phone, newPassword }, 'recover').then((data) => {
      setToken(data.token || '')
      applyServerState(data)
      refreshFriends().catch(() => {}) // 进入即拉好友（否则朋友页空白，要刷新才出现）
      startPoller()
      return me()
    })
  }
  // 单机版无真实账号体系，找回即校验本机账号昵称+手机号后改密。
  const m = me()
  if (!m || m.name !== (name || '').trim() || m.phone !== (phone || '').trim()) throw new Error('昵称和手机号对不上')
  m.password = newPassword
  store.currentId = m.id
  return m
}

// 修改密码：旧密码校验 → 新密码（联机后端 token_version+1，本设备换新 token）。
export function changePassword({ oldPassword, newPassword }) {
  if (shouldUseApi()) {
    return api.mutate('/auth/change-password', { oldPassword, newPassword }, 'chpwd').then((data) => {
      if (data.token) setToken(data.token)
      return true
    })
  }
  const m = me()
  if (!m || m.password !== oldPassword) throw new Error('原密码不对')
  m.password = newPassword
  return true
}

// 自助注销：密码确认 → 清空该账号全部信息、释放手机号，完成后等同退出（回登录页）。
export function deleteAccount({ password }) {
  if (shouldUseApi()) {
    return api.mutate('/account/delete', { password }, 'acctdel').then(() => {
      resetAll() // 注销成功=退出登录态（清 token + 本地态 + 停轮询）
      return true
    })
  }
  resetAll()
  return Promise.resolve(true)
}

export function resetAll() {
  stopPoller()
  setToken('')
  // 清所有悬挂的 NPC 定时器，防重置后回调命中旧局（LOOP-2）。
  store.matches.forEach((mm) => clearFriendTimers(mm.id))
  clearChatTimers()
  clearFriendRequestTimers()
  clearIncomingRequestTimers()
  const fresh = freshState()
  store.players = fresh.players
  store.currentId = fresh.currentId
  store.ledger = fresh.ledger
  store.balance = fresh.balance
  store.frozen = fresh.frozen
  store.matches = fresh.matches
  store.myMatches = fresh.myMatches
  store.inbox = fresh.inbox
  store.pmBets = fresh.pmBets
  store.pmCache = fresh.pmCache // 缓存清空即系统盘清空（含 pinnedIds 钉住集合一并清）
  store.pmComments = fresh.pmComments // 系统盘留言板一并清空
  store.chats = fresh.chats
  store.friendships = fresh.friendships
  store.friendRequests = fresh.friendRequests
  store.watchlist = fresh.watchlist
  store.rivals = fresh.rivals
  store.feed = fresh.feed
  store.lastSeenAt = fresh.lastSeenAt
  store.offlineMatches = fresh.offlineMatches
  store.lastSupplyAt = fresh.lastSupplyAt
  store.seasonStartAt = fresh.seasonStartAt
  store.seasonArchives = fresh.seasonArchives
  store.agreedTerms = fresh.agreedTerms
  store.onboarded = fresh.onboarded
  store.appeals = fresh.appeals
  store.reportedCheats = fresh.reportedCheats // 漏项补齐：旧举报去重记录不残留进新存档（Double check 总复核修订）
  store.authEpoch = (store.authEpoch || 0) + 1 // 触发 App.loggedIn 重算 → 退出登录/注销后回登录页
}

// ---------- 好友关系层（P-0.5 单机版：本地申请 + NPC 假同意）----------

const friendRequestTimers = new Map() // playerName -> Set<timeoutId>
const incomingRequestTimers = new Set()

function findNpcPlayer(name) {
  return store.players.find((p) => !p.isMe && p.name === name)
}

function personByNameOrId(value) {
  const key = String(value)
  const lists = [
    store.players || [],
    store.friends || [],
    store.friendIncoming || [],
    store.friendOutgoing || [],
  ]
  for (const list of lists) {
    const hit = list.find((p) => p && (p.name === value || String(p.id) === key))
    if (hit) return hit
  }
  return null
}

function rememberFriendRequestTimer(name, timerId) {
  const set = friendRequestTimers.get(name) || new Set()
  set.add(timerId)
  friendRequestTimers.set(name, set)
}

function forgetFriendRequestTimer(name, timerId) {
  const set = friendRequestTimers.get(name)
  if (!set) return
  set.delete(timerId)
  if (set.size === 0) friendRequestTimers.delete(name)
}

function clearFriendRequestTimers() {
  friendRequestTimers.forEach((ids) => {
    ids.forEach((id) => clearTimeout(id))
  })
  friendRequestTimers.clear()
}

function clearIncomingRequestTimers() {
  incomingRequestTimers.forEach((id) => clearTimeout(id))
  incomingRequestTimers.clear()
}

export function friendStatus(name) {
  if (shouldUseApi()) {
    if ((store.friends || []).some((p) => p.name === name || String(p.id) === String(name))) return 'friend'
    if ((store.friendOutgoing || []).some((p) => p.name === name || String(p.id) === String(name))) return 'requested'
    if ((store.friendIncoming || []).some((p) => p.name === name || String(p.id) === String(name))) return 'incoming'
  }
  const status = store.friendships?.[name]
  return status === 'friend' || status === 'requested' ? status : null
}

export function isFriend(name) {
  return friendStatus(name) === 'friend'
}

export function refreshFriends() {
  return api.get('/friends').then((data) => {
    applyServerState({ friends: data })
    return data
  })
}

export function requestFriend(name) {
  if (shouldUseApi()) {
    const id = personByNameOrId(name)?.id ?? name
    return api.post(`/friends/${encodeURIComponent(id)}/request`, {}).then((data) => {
      refreshFriends().catch(() => {})
      return data.status
    })
  }
  const npc = findNpcPlayer(name)
  if (!npc) return null
  const current = friendStatus(name)
  if (current === 'friend' || current === 'requested') return current
  if (!store.friendships || typeof store.friendships !== 'object') store.friendships = {}
  store.friendships[name] = 'requested'
  const delay = 1500 + Math.random() * 2500
  const timerId = setTimeout(() => {
    forgetFriendRequestTimer(name, timerId)
    if (store.friendships?.[name] !== 'requested') return
    store.friendships[name] = 'friend'
    feedPush({
      type: 'friend',
      actorName: npc.name,
      actorEmoji: npc.emoji,
      text: `${npc.name} 同意了你的好友申请`,
      ref: null,
    })
  }, delay)
  rememberFriendRequestTimer(name, timerId)
  return 'requested'
}

export function searchPlayers(q) {
  if (shouldUseApi()) {
    return api.get(`/users/search?q=${encodeURIComponent(String(q || '').trim())}`)
      .then((data) => data.users || [])
  }
  const key = String(q || '').trim()
  if (!key) return []
  // 只返回公开牌面摘要（DTO），不透出 phone/password/balance 等敏感字段——与联机版搜索接口同口径。
  return store.players
    .filter((p) => !p.isMe && (p.name === key || p.phone === key))
    .map((p) => ({ name: p.name, emoji: p.emoji, title: p.title, wins: p.wins, losses: p.losses }))
}

export function removeFriend(name) {
  if (shouldUseApi()) {
    const id = personByNameOrId(name)?.id ?? name
    return api.del(`/friends/${encodeURIComponent(id)}`).then((data) => {
      refreshFriends().catch(() => {})
      return data.status
    })
  }
  if (store.friendships && typeof store.friendships === 'object') {
    delete store.friendships[name]
  }
}

export function seedIncomingRequest() {
  if (!Array.isArray(store.friendRequests)) store.friendRequests = []
  const pending = new Set(store.friendRequests.map((r) => r.fromName))
  const candidates = store.players.filter((p) => (
    !p.isMe &&
    NPCS.some((n) => n.name === p.name) &&
    !isFriend(p.name) &&
    friendStatus(p.name) !== 'requested' &&
    !pending.has(p.name)
  ))
  if (!candidates.length) return null
  const from = rand(candidates)
  const req = { id: uid(), fromName: from.name, at: Date.now() }
  store.friendRequests.push(req)
  return req
}

export function respondFriendRequest(id, accept) {
  if (shouldUseApi()) {
    const otherId = store.friendIncoming?.find((p) => String(p.id) === String(id) || p.name === id)?.id ?? id
    const action = accept ? 'accept' : 'decline'
    return api.post(`/friends/${encodeURIComponent(otherId)}/${action}`, {}).then((data) => {
      refreshFriends().catch(() => {})
      return data
    })
  }
  if (!Array.isArray(store.friendRequests)) store.friendRequests = []
  const idx = store.friendRequests.findIndex((r) => r.id === id)
  if (idx === -1) return null
  const [req] = store.friendRequests.splice(idx, 1)
  if (accept) {
    if (!store.friendships || typeof store.friendships !== 'object') store.friendships = {}
    store.friendships[req.fromName] = 'friend'
    const who = me()
    feedPush({
      type: 'friend',
      actorName: who?.name || '我',
      actorEmoji: who?.emoji || '🫵',
      text: `你通过了 ${req.fromName} 的好友申请`,
      ref: null,
    })
  }
  return req
}

export function scheduleIncomingRequestDemo() {
  if (!Array.isArray(store.friendRequests)) store.friendRequests = []
  const hasCandidate = store.players.some((p) => (
    !p.isMe &&
    NPCS.some((n) => n.name === p.name) &&
    !isFriend(p.name) &&
    friendStatus(p.name) !== 'requested' &&
    !store.friendRequests.some((r) => r.fromName === p.name)
  ))
  if (store.friendRequests.length || !hasCandidate || Math.random() >= 0.3) return null
  const delay = 5000 + Math.random() * 10000
  const timerId = setTimeout(() => {
    incomingRequestTimers.delete(timerId)
    seedIncomingRequest()
  }, delay)
  incomingRequestTimers.add(timerId)
  return () => {
    clearTimeout(timerId)
    incomingRequestTimers.delete(timerId)
  }
}

// ---------- 朋友私信（P-0.5 单机版：NPC 假回复）----------

const chatTimers = new Map() // friendName -> Set<timeoutId>

function normalizeChatMessage(msg, friend) {
  const mineId = me()?.id
  const friendName = friend?.name || ''
  const fromMe = msg.from === 'me' || (msg.fromId != null && String(msg.fromId) === String(mineId))
  return {
    id: msg.id,
    from: fromMe ? 'me' : (msg.from || friendName),
    text: msg.text,
    at: msg.at ?? msg.createdAt,
    readAt: msg.readAt ?? null,
  }
}

function rememberChatTimer(friendName, timerId) {
  const set = chatTimers.get(friendName) || new Set()
  set.add(timerId)
  chatTimers.set(friendName, set)
}

function forgetChatTimer(friendName, timerId) {
  const set = chatTimers.get(friendName)
  if (!set) return
  set.delete(timerId)
  if (set.size === 0) chatTimers.delete(friendName)
}

function clearChatTimers() {
  chatTimers.forEach((ids) => {
    ids.forEach((id) => clearTimeout(id))
  })
  chatTimers.clear()
}

export function chatWith(friendName) {
  if (shouldUseApi()) {
    const friend = personByNameOrId(friendName)
    const friendId = friend?.id ?? friendName
    const key = friend?.name || String(friendName)
    api.get(`/chats/${encodeURIComponent(friendId)}`, { countLoading: false })
      .then((data) => {
        store.chats[key] = (data.messages || []).map((msg) => normalizeChatMessage(msg, friend))
      })
      .catch(() => {})
  }
  const list = store.chats?.[friendName]
  return Array.isArray(list) ? list : []
}

export function sendChat(friendName, text) {
  if (shouldUseApi()) {
    const friend = personByNameOrId(friendName)
    const friendId = friend?.id ?? friendName
    const key = friend?.name || String(friendName)
    return api.post(`/chats/${encodeURIComponent(friendId)}`, { text }).then((data) => {
      if (!store.chats || typeof store.chats !== 'object') store.chats = {}
      if (!Array.isArray(store.chats[key])) store.chats[key] = []
      if (data.message) upsertById(store.chats[key], normalizeChatMessage(data.message, friend))
      return store.chats[key]
    })
  }
  // 私密面不变量沉到数据层守住（与联机版 NOT_FRIENDS 同语义）：非好友不能私信。UI 已守，这里兜底。
  if (!isFriend(friendName)) throw new Error('加好友后才能私信')
  const body = (text || '').trim()
  if (!body) throw new Error('私信内容不能为空')
  if (!store.chats || typeof store.chats !== 'object') store.chats = {}
  if (!Array.isArray(store.chats[friendName])) store.chats[friendName] = []
  store.chats[friendName].push({ id: uid(), from: 'me', text: body, at: Date.now() })
  store.chats[friendName].sort((a, b) => a.at - b.at)

  const delay = 1000 + Math.random() * 3000
  const timerId = setTimeout(() => {
    forgetChatTimer(friendName, timerId)
    const list = store.chats?.[friendName]
    if (!Array.isArray(list)) return
    list.push({ id: uid(), from: friendName, text: rand(CHAT_TALK), at: Date.now() })
    list.sort((a, b) => a.at - b.at)
  }, delay)
  rememberChatTimer(friendName, timerId)
  return store.chats[friendName]
}

// ---------- 经济治理（S9 §5.11：周补给 / 赛季清零 / 转赠 / 信誉 / 老赖榜）----------
//
// 合规红线（死守）：积分永不可兑现；周补/转赠都是虚拟娱乐积分，不对应现实金钱；
// 转赠仅熟人人情、有单笔限额、走审计账本、平台 0 抽成（守恒）；不做积分买卖市场。

// 本周补给是否可领（距上次≥7天，或从未领过）。
export function canClaimWeeklySupply() {
  return canClaimSupply(store.lastSupplyAt)
}

// 距下次可领还剩多少毫秒（已可领=0），给 UI 提示用。
export function supplyCountdownMs() {
  return msUntilNextSupply(store.lastSupplyAt)
}

// 领取本周补给（§5.11：每周补 2 万）。可领才生效，记账本 grant。
// 返回领到的金额(0=不可领)。
export function claimWeeklySupply() {
  if (shouldUseApi()) {
    return api.mutate('/supply/claim', {}, 'supply').then((data) => {
      applyServerState(data)
      syncOnce().catch(() => {})
      return data.amount || 0
    })
  }
  if (!canClaimSupply(store.lastSupplyAt)) return 0
  store.balance = store.balance + SUPPLY_AMOUNT
  store.lastSupplyAt = Date.now()
  syncMe()
  ledgerPush({ type: 'grant', amount: SUPPLY_AMOUNT, balanceAfter: store.balance, ref: 'weekly_supply' })
  const who = me()
  feedPush({
    type: 'supply',
    actorName: who?.name || '我',
    actorEmoji: who?.emoji || '🫵',
    text: `领取了本周补给 +${SUPPLY_AMOUNT.toLocaleString('en-US')} 积分（虚拟娱乐，不可兑现）`,
    ref: null,
  })
  return SUPPLY_AMOUNT
}

export function checkin() {
  return api.post('/checkin', {}).then((data) => {
    syncOnce().catch(() => {})
    return data
  })
}

// 赛季年度重置（§5.11：一年清零一次。原型可手动触发）。
// 把当前战绩归档进 seasonArchives，积分回 100 万、战绩(wins/losses/streak/maxStreak/
// bestWinOdds)清零，保留账号(昵称/密码/头像/称号/信誉)。只重置"我"。
export function resetSeason() {
  if (shouldUseApi()) {
    return api.mutate('/admin/season/reset', {}, 'season-reset')
      .then((data) => {
        syncOnce().catch(() => {})
        return data
      })
  }
  const who = me()
  if (!who) return
  const oldBalance = store.balance
  store.seasonArchives.unshift({
    endedAt: Date.now(),
    seasonStartAt: store.seasonStartAt, // 归档赛季起止
    wins: who.wins || 0,
    losses: who.losses || 0,
    maxStreak: who.maxStreak || 0,
    bestWinOdds: who.bestWinOdds || 0,
    balance: oldBalance,
    rivals: JSON.parse(JSON.stringify(store.rivals || {})), // 归档对战恩怨快照(可回看历史赛季)
  })
  who.wins = 0
  who.losses = 0
  who.streak = 0
  who.maxStreak = 0
  who.bestWinOdds = 0
  store.balance = INITIAL_BALANCE
  store.frozen = 0
  // 赛季作废前先清所有悬挂的 NPC 定时器，防回调命中已废局（LOOP-2）。
  store.matches.forEach((mm) => clearFriendTimers(mm.id))
  store.matches = [] // 赛季作废所有对赌局,防旧未结算局结算/撤盘污染新赛季(frozen变负/凭空增分)
  store.pmBets = []
  store.pmCache.pinnedIds = [] // 赛季清零押注 → 钉住集合一并清，旧盘可正常被清理（防永久膨胀）
  store.appeals = [] // 清未决申诉(防赛季重置后复议金悬挂/找不到原局)
  store.rivals = {} // 对战恩怨随赛季清零(已归档进 seasonArchives)
  store.seasonStartAt = Date.now()
  syncMe()
  // ledger 记实际变化量(新-旧)，而非恒定 +100万(原bug:旧余额120万时实际-20万却记+100万)
  ledgerPush({ type: 'grant', amount: INITIAL_BALANCE - oldBalance, balanceAfter: store.balance, ref: 'season_reset' })
  feedPush({
    type: 'season',
    actorName: who.name || '我',
    actorEmoji: who.emoji || '🫵',
    text: `开启新赛季，积分重置为 ${INITIAL_BALANCE.toLocaleString('en-US')}（上赛季战绩已归档）`,
    ref: null,
  })
}

// 积分转赠给某熟人（§5.11，合规敏感）。
//   toName: 收款熟人(NPC)名；amount: 转出额。
// 守恒：扣我余额 amount，对手 NPC 余额 +amount（原型也回写让身家榜可见），平台 0 抽水。
// 单笔限额 TRANSFER_LIMIT；走 ledger(type:'transfer') 做审计记录。
// 原型简化为"直接生效 + 审计记录"（真实需管理员审核）。
// 返回 { ok, error?, amount? }。
export function transferPoints({ toName, amount }) {
  if (shouldUseApi()) {
    const toUserId = store.players.find((p) => p.name === toName || String(p.id) === String(toName))?.id ?? toName
    return api.mutate('/transfers', { toUserId, amount }, 'transfer')
      .then((data) => {
        syncOnce().catch(() => {})
        return { ok: true, ...data }
      })
      .catch((e) => ({ ok: false, error: e.message }))
  }
  const v = validateTransfer({ amount, balance: store.balance, toName })
  if (!v.ok) return v
  const npc = store.players.find((p) => !p.isMe && p.name === toName)
  if (!npc) return { ok: false, error: '找不到这个熟人' }
  const a = v.amount
  store.balance = store.balance - a
  npc.balance = (npc.balance || 0) + a // 对手收到(原型也回写,守恒+身家榜可见)
  syncMe()
  ledgerPush({ type: 'transfer', amount: -a, balanceAfter: store.balance, ref: 'to:' + toName })
  const who = me()
  feedPush({
    type: 'transfer',
    actorName: who?.name || '我',
    actorEmoji: who?.emoji || '🫵',
    text: `转赠了 ${a.toLocaleString('en-US')} 积分给 ${toName}（熟人人情·虚拟娱乐，不可兑现/不对应现实金钱）`,
    ref: null,
  })
  return { ok: true, amount: a, toName }
}

// 举报某人耍赖 → 降其信誉（§5.9）。原型简化：直接生效（真实需审核背书）。
//   targetName: 被举报方名；kind: 'delay'|'misjudge'|'litigation'|'deadbeat'。
// 返回被举报方的新信誉（找不到人返回 null）。
const CHEAT_LABEL = {
  delay: '裁判拖延',
  misjudge: '乱判',
  litigation: '无理缠讼',
  deadbeat: '线下彩头赖账',
}
export function reportCheat(targetName, kind, matchId = null) {
  if (shouldUseApi()) {
    const targetUserId = store.players.find((p) => p.name === targetName || String(p.id) === String(targetName))?.id ?? targetName
    return api.post('/reports', { targetUserId, kind, matchId })
      .then((data) => data.reputation ?? null)
  }
  const p = store.players.find((x) => x.name === targetName)
  if (!p) return null
  // 一局一举报：同一局对同一人只降一次信誉，防关闭详情再进重复施压把信誉压到 0（同 S10 一局一申诉）
  if (matchId) {
    const key = matchId + '|' + targetName
    if (store.reportedCheats.includes(key)) return p.reputation
    store.reportedCheats.push(key)
  }
  p.reputation = applyRepPenalty(p.reputation, kind)
  const who = me()
  feedPush({
    type: 'cheat',
    actorName: who?.name || '我',
    actorEmoji: who?.emoji || '🫵',
    text: `举报 ${targetName} ${CHEAT_LABEL[kind] || '耍赖'}，信誉降至 ${p.reputation}（不影响积分，只影响信誉）`,
    ref: null,
  })
  return p.reputation
}

// 老赖榜数据（§5.12）：逾期欠条 + 低信誉玩家，公开处刑。
export function getDeadbeatBoard() {
  if (shouldUseApi()) {
    return api.get('/leaderboards/deadbeat').catch(() => ({ debts: [], lowRep: [] }))
  }
  return deadbeatBoard({
    players: store.players,
    matches: store.matches,
    offlineMatches: store.offlineMatches,
    overdueFn: isSideBetOverdue,
    meName: me()?.name || '我',
  })
}

export function getMainLeaderboard() {
  return api.get('/leaderboards/main').then((data) => data.users || [])
}

// ---------- 个人对赌 ----------

// 盘内详情整页拉取（§7：详情页 10s 一拍，含留言/接盘态/结算态）
export function refreshMatchDetail(matchId) {
  return api.get(`/matches/${encodeURIComponent(matchId)}`, { countLoading: false })
    .then((data) => applyServerState(data))
    .catch(() => {})
}

export function refreshMatches(params = {}) {
  const search = new URLSearchParams()
  if (params.status) search.set('status', params.status)
  if (params.limit) search.set('limit', String(params.limit))
  const qs = search.toString()
  return api.get(`/matches${qs ? `?${qs}` : ''}`)
    .then((data) => {
      applyServerState(data)
      return store.matches
    })
}

// 三种玩法统一开盘入口（S7 §5.3）。
//   mode='match'（默认）：约赌撮合，1v1 固定赔率（原逻辑，完全照旧）。
//   mode='banker'：我坐庄，自设 bankerOdds + bankerCap 保证金封顶；冻结 = bankerCap。
//   mode='pool' ：彩池，我先押一边 ownerSide/ownerStake，赔率随两边动态变。
// 为兼容现有列表卡片（HomeFeed/MyAssets 直接读 ownerSide/ownerStake/odds），
// 三种 mode 都保证这三个字段有意义的值（坐庄：ownerStake=封顶额、odds=庄家赔率）。
export function createMatch({
  title,
  optionA,
  optionB,
  ownerSide,
  odds,
  ownerStake,
  mode = 'match',
  bankerOdds,
  bankerCap,
  sideBet, // 可选文字彩头文案（如"输的请吃饭"）。只记录不结算（§5.3）。
  deadline, // 可选截止时间戳（§5.13）。到截止仍 open 自动作废退回。
}) {
  if (shouldUseApi()) {
    return mutateMoney('/matches', {
      title,
      optionA,
      optionB,
      ownerSide,
      odds,
      ownerStake,
      mode,
      bankerOdds,
      bankerCap,
      sideBetText: sideBet,
      deadline,
    }, 'match').then((data) => {
      applyServerState(data)
      return data.match
    })
  }
  const who = me()
  const m = {
    id: uid(),
    mode,
    title,
    optionA,
    optionB,
    status: 'open', // open | matched | settled
    result: null, // 'A' | 'B'
    comments: [],
    createdAt: Date.now(),
    deadline: Number.isFinite(Number(deadline)) && Number(deadline) > 0 ? Number(deadline) : null, // S10 截止时间（null=无截止）
  }
  // 线下文字彩头（可选）：平台只记录履约状态，不参与积分结算（§5.3 合规红线）。
  const sbText = (sideBet || '').trim()
  if (sbText) m.sideBet = { text: sbText, fulfilled: false, fulfilledAt: null }

  if (mode === 'banker') {
    // 坐庄：冻结保证金封顶额（庄家最大亏损）。
    if (!(bankerOdds > 1)) throw new Error('庄家赔率必须大于 1')
    if (!(bankerCap > 0)) throw new Error('保证金封顶必须大于 0')
    if (bankerCap > store.balance) throw new Error('积分不足以垫保证金')
    store.balance = store.balance - bankerCap
    store.frozen = store.frozen + bankerCap
    syncMe()
    m.bankerOdds = bankerOdds
    m.bankerCap = bankerCap
    m.bets = [] // [{ id, by, emoji, side, stake, npc, payout? }]
    // 兼容字段：列表卡片用。庄家没有"押的边"，借 ownerSide 占位。
    m.ownerSide = 'A'
    m.odds = bankerOdds
    m.ownerStake = bankerCap
    store.matches.unshift(m)
    ledgerPush({ type: 'freeze', amount: -bankerCap, balanceAfter: store.balance, ref: m.id })
    feedPush({
      type: 'open',
      actorName: who?.name || '我',
      actorEmoji: who?.emoji || '🫵',
      text: `坐庄开盘「${title}」，赔率 ${bankerOdds}，保证金 ${bankerCap.toLocaleString()}，谁来押？`,
      ref: m.id,
    })
    scheduleFriends(m.id)
    return m
  }

  if (mode === 'pool') {
    // 彩池：我先押一边。
    if (!(ownerStake > 0)) throw new Error('下注额必须大于 0')
    if (ownerStake > store.balance) throw new Error('积分不足')
    store.balance = store.balance - ownerStake
    store.frozen = store.frozen + ownerStake
    syncMe()
    m.pool = { A: [], B: [] } // 每注 { id, by, emoji, stake, npc, payout? }
    m.pool[ownerSide].push({
      id: uid(),
      by: who?.name || '我',
      emoji: who?.emoji || '🫵',
      stake: ownerStake,
      npc: false,
    })
    // 兼容字段：我的这一注。
    m.ownerSide = ownerSide
    m.ownerStake = ownerStake
    m.odds = 0 // 彩池赔率动态，详情页实时算
    store.matches.unshift(m)
    ledgerPush({ type: 'freeze', amount: -ownerStake, balanceAfter: store.balance, ref: m.id })
    feedPush({
      type: 'open',
      actorName: who?.name || '我',
      actorEmoji: who?.emoji || '🫵',
      text: `开了个彩池「${title}」，押 ${ownerSide === 'A' ? optionA : optionB}，大家来站队瓜分`,
      ref: m.id,
    })
    scheduleFriends(m.id)
    return m
  }

  // —— mode === 'match'：约赌撮合（原逻辑照旧）——
  if (!(ownerStake > 0)) throw new Error('下注额必须大于 0')
  if (ownerStake > store.balance) throw new Error('积分不足')
  store.balance = store.balance - ownerStake
  store.frozen = store.frozen + ownerStake
  syncMe()
  m.ownerSide = ownerSide // 'A' | 'B'，"我"押的边
  m.odds = odds
  m.ownerStake = ownerStake
  m.takerStake = 0
  m.takerSide = null // 'A' | 'B'
  m.takerName = null // 接盘的朋友名
  m.takerEmoji = null
  m.takerJoined = false
  store.matches.unshift(m)
  ledgerPush({ type: 'freeze', amount: -ownerStake, balanceAfter: store.balance, ref: m.id })
  // 动态流：谁开了什么盘。
  feedPush({
    type: 'open',
    actorName: who?.name || '我',
    actorEmoji: who?.emoji || '🫵',
    text: `开了一盘「${title}」，押 ${ownerSide === 'A' ? optionA : optionB}（赔率 ${odds}）`,
    ref: m.id,
  })
  scheduleFriends(m.id) // 安排朋友围观+接盘
  return m
}

// 开盘后给每局安排的 NPC 围观/接盘定时器 id（按 matchId 存）。撤盘/赛季重置/
// 到期作废时 clearTimeout，防止对已删除的局回调（悬挂定时器误触发，LOOP-2）。
const friendTimers = new Map() // matchId -> number[]

// 清掉某局所有悬挂的 NPC 定时器（幂等：没有也安全）。
function clearFriendTimers(matchId) {
  const ids = friendTimers.get(matchId)
  if (ids) {
    ids.forEach((id) => clearTimeout(id))
    friendTimers.delete(matchId)
  }
}

// 开盘后，朋友们陆续上线：先 2-3 个围观吐槽，再按 mode 自动参与（S4/S7）。
//   match → 一个 NPC 接盘；banker → 几个 NPC 押注；pool → 几个 NPC 往两边站队下注。
function scheduleFriends(matchId) {
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  const mode = m?.mode || 'match'
  const ids = []
  const watchers = randInt(2, 3) // 2~3 个围观者，更热闹
  for (let i = 0; i < watchers; i++) {
    ids.push(setTimeout(() => npcComment(matchId), 1000 + i * 1400 + Math.random() * 1200))
  }
  const base = 1000 + watchers * 1400 + 800
  if (mode === 'banker') {
    const n = randInt(2, 4) // 几个 NPC 来押庄
    for (let i = 0; i < n; i++) {
      ids.push(setTimeout(() => npcBetBanker(matchId), base + i * 1300 + Math.random() * 1200))
    }
  } else if (mode === 'pool') {
    const n = randInt(2, 4) // 几个 NPC 往两边站队
    for (let i = 0; i < n; i++) {
      ids.push(setTimeout(() => npcBetPool(matchId), base + i * 1300 + Math.random() * 1200))
    }
  } else {
    ids.push(setTimeout(() => npcJoin(matchId), base + Math.random() * 1500))
  }
  friendTimers.set(matchId, ids)
}

// 坐庄局：一个 NPC 随机押一边、随机金额。手动"喊人押注"也可调。
export function npcBetBanker(matchId, npcName) {
  if (shouldUseApi()) {
    const body = typeof npcName === 'object' ? npcName : {}
    return mutateMoney(`/matches/${encodeURIComponent(matchId)}/banker-bets`, body, 'banker-bet')
      .then((data) => {
        applyServerState(data)
        return data.match
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || m.mode !== 'banker' || m.status === 'settled') return // 允许open/matched都收注(修:原只第1个NPC能押)
  const used = new Set((m.bets || []).map((b) => b.by))
  const pool = NPCS.filter((n) => !used.has(n.name))
  // 指定被邀好友下注（邀约定向局）；不传 npcName 则随机挑没押过的。
  const npc = (npcName && NPCS.find((n) => n.name === npcName)) || rand(pool.length ? pool : NPCS)
  const side = Math.random() < 0.5 ? 'A' : 'B'
  const stake = randInt(2, 12) * 1000
  m.bets.push({ id: uid(), by: npc.name, emoji: npc.emoji, side, stake, npc: true })
  if (m.status === 'open') m.status = 'matched' // 有人押了就算成局，可揭晓
  const trash = rand(TAKER_TALK)
  m.comments.push({ id: uid(), by: npc.name, emoji: npc.emoji, text: trash, at: Date.now(), npc: true })
  feedPush({
    type: 'join',
    actorName: npc.name,
    actorEmoji: npc.emoji,
    text: `押了 ${me()?.name || '我'} 的庄「${m.title}」${stake.toLocaleString()} 在 ${side === 'A' ? m.optionA : m.optionB}：${trash}`,
    ref: m.id,
  })
}

// 我往彩池某边追加站队下注（详情页"站队"按钮）。冻结我的注。
export function myJoinPool(matchId, side, stake) {
  if (shouldUseApi()) {
    return mutateMoney(`/matches/${encodeURIComponent(matchId)}/pool-bets`, { side, stake }, 'pool-bet')
      .then((data) => {
        applyServerState(data)
        return data.match
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || m.mode !== 'pool' || m.status === 'settled') return
  if (!(stake > 0)) throw new Error('下注额必须大于 0')
  if (stake > store.balance) throw new Error('积分不足')
  store.balance = store.balance - stake
  store.frozen = store.frozen + stake
  const who = me()
  m.pool[side].push({ id: uid(), by: who?.name || '我', emoji: who?.emoji || '🫵', stake, npc: false })
  if (m.status === 'open') m.status = 'matched'
  syncMe()
  ledgerPush({ type: 'freeze', amount: -stake, balanceAfter: store.balance, ref: m.id })
  return m
}

// 彩池局：一个 NPC 往某一边下注（两边都可能，制造对池）。
export function npcBetPool(matchId, npcName) {
  if (shouldUseApi()) {
    const body = typeof npcName === 'object' ? npcName : {}
    return mutateMoney(`/matches/${encodeURIComponent(matchId)}/pool-bets`, body, 'pool-bet')
      .then((data) => {
        applyServerState(data)
        return data.match
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || m.mode !== 'pool' || m.status === 'settled') return // 允许open/matched都站队(修:原只第1个NPC能押)
  const all = [...(m.pool.A || []), ...(m.pool.B || [])]
  const used = new Set(all.filter((b) => b.npc).map((b) => b.by))
  const pool = NPCS.filter((n) => !used.has(n.name))
  // 指定被邀好友站队（邀约定向局）；不传 npcName 则随机挑没押过的。
  const npc = (npcName && NPCS.find((n) => n.name === npcName)) || rand(pool.length ? pool : NPCS)
  const side = Math.random() < 0.5 ? 'A' : 'B'
  const stake = randInt(2, 12) * 1000
  m.pool[side].push({ id: uid(), by: npc.name, emoji: npc.emoji, stake, npc: true })
  if (m.status === 'open') m.status = 'matched'
  const trash = rand(TAKER_TALK)
  m.comments.push({ id: uid(), by: npc.name, emoji: npc.emoji, text: trash, at: Date.now(), npc: true })
  feedPush({
    type: 'join',
    actorName: npc.name,
    actorEmoji: npc.emoji,
    text: `往彩池「${m.title}」的 ${side === 'A' ? m.optionA : m.optionB} 押了 ${stake.toLocaleString()}：${trash}`,
    ref: m.id,
  })
}

// 已在某盘开过口的 NPC 名字集合（同一盘不重复围观/接盘）。
function npcsUsedIn(m) {
  return new Set((m.comments || []).filter((c) => c.npc).map((c) => c.by))
}

// 一个还没在本盘说过话的 NPC 在评论区围观吐槽（不下注）。去重：同一 NPC 不重复。
function npcComment(matchId) {
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m) return
  const used = npcsUsedIn(m)
  const pool = NPCS.filter((n) => !used.has(n.name))
  if (pool.length === 0) return // 都来过了，不硬塞
  const npc = rand(pool)
  const talk = rand(WATCH_TALK)
  m.comments.push({
    id: uid(),
    by: npc.name,
    emoji: npc.emoji,
    text: talk,
    at: Date.now(),
    npc: true,
  })
  // 围观也喂动态流，单机也热闹。
  feedPush({
    type: 'watch',
    actorName: npc.name,
    actorEmoji: npc.emoji,
    text: `围观「${m.title}」：${talk}`,
    ref: m.id,
  })
}

// 一个 NPC 接盘（押对立面），并甩一句垃圾话。可由定时触发或手动"喊人接盘"。
export function npcJoin(matchId) {
  if (shouldUseApi()) {
    return mutateMoney(`/matches/${encodeURIComponent(matchId)}/take`, {}, 'take-match')
      .then((data) => {
        applyServerState(data)
        return data.match
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || m.status !== 'open') return
  // 去重：优先挑没在本盘围观过的 NPC 来接盘；都来过了才允许复用。
  const used = npcsUsedIn(m)
  const pool = NPCS.filter((n) => !used.has(n.name))
  const npc = rand(pool.length ? pool : NPCS)
  const trash = rand(TAKER_TALK)
  m.takerName = npc.name
  m.takerEmoji = npc.emoji
  m.takerStake = takerStakeFor(m.ownerStake, m.odds)
  m.takerSide = m.ownerSide === 'A' ? 'B' : 'A'
  m.takerJoined = true
  m.status = 'matched'
  m.takerTrash = trash // 记下接盘时甩的狠话，结算时做"打脸回放"
  m.comments.push({
    id: uid(),
    by: npc.name,
    emoji: npc.emoji,
    text: trash,
    at: Date.now(),
    npc: true,
  })
  // 动态流：谁接了谁的盘。
  const ownerName = me()?.name || '我'
  feedPush({
    type: 'join',
    actorName: npc.name,
    actorEmoji: npc.emoji,
    text: `接了 ${ownerName} 的「${m.title}」，押 ${m.takerSide === 'A' ? m.optionA : m.optionB}：${trash}`,
    ref: m.id,
  })
}

// ---------- 邀请好友约赌（S15.2 本地 demo）----------
//
// 闭环：选中熟人 NPC → 设赌局规则(约赌玩法) → 发起邀约（开盘冻结我的注，
// 不自动撒随机围观，只等被邀的人响应）→ 被邀 NPC 模拟同意 → 第一个同意者成局
// (npcAcceptInvite 把它设为接盘方，status→matched)，进对赌中。
// 复用现有 createMatch(match 模式) 的冻结/账本/动态流；不重写结算（仍走 settleMatchStore）。
// 真扫码/真好友清单接云后做，本地用 NPC 清单跑通体验。

// 发起邀约：用约赌(match)模式开盘，但不调 scheduleFriends（不撒随机围观/接盘），
// 只把被邀名单记在 m.invited 上，等 npcAcceptInvite 推进。返回 match。
export function inviteMatch({ npcNames, title, optionA, optionB, ownerSide, odds, ownerStake, mode = 'match', bankerOdds, bankerCap, sideBet, deadline }) {
  if (shouldUseApi()) {
    const invitedIds = (npcNames || [])
      .map((nameOrId) => store.players.find((p) => p.name === nameOrId || String(p.id) === String(nameOrId))?.id ?? nameOrId)
      .filter((id) => id != null && id !== '')
    return mutateMoney('/matches', {
      invitedIds,
      title,
      optionA,
      optionB,
      ownerSide,
      odds,
      ownerStake,
      mode,
      bankerOdds,
      bankerCap,
      sideBetText: sideBet,
      deadline,
    }, 'match').then((data) => {
      applyServerState(data)
      return data.match
    })
  }
  // 私密面不变量沉到数据层（与联机版 NOT_FRIENDS 同语义）：定向邀约只能邀好友。UI 已过滤，这里兜底。
  const names = (npcNames || []).filter((n) => store.players.some((p) => !p.isMe && p.name === n) && isFriend(n))
  if (!names.length) throw new Error('请至少选一个好友邀请')
  // 复用 createMatch 的开盘/冻结/账本/动态流逻辑（玩法由 mode 决定），它内部会 scheduleFriends。
  const m = createMatch({ title, optionA, optionB, ownerSide, odds, ownerStake, mode, bankerOdds, bankerCap, sideBet, deadline })
  // 邀约是定向私局：撤掉刚排上的随机围观/接盘/下注定时器，只等被邀的人响应。
  clearFriendTimers(m.id)
  m.invited = names.slice() // 被邀好友名单（demo 标记，便于详情/动态展示）
  return m
}

// 某个被邀 NPC 模拟同意接盘。第一个同意者成局（设为接盘方，status→matched）；
// 之后再同意的只在评论区凑热闹（已成局，不重复接盘，守恒）。组件按随机延时逐个调本函数。
export function npcAcceptInvite(matchId, npcName) {
  if (shouldUseApi()) return npcJoin(matchId)
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m) return
  const npc = store.players.find((p) => !p.isMe && p.name === npcName)
  if (!npc) return
  // 私密面不变量兜底（与 inviteMatch/NOT_FRIENDS 同语义）：非好友不能进定向私局；
  // 有被邀名单的局，名单外的人也不能进（UI 已过滤，这里是数据层最后一道锁）。
  if (!isFriend(npcName)) return
  if (Array.isArray(m.invited) && m.invited.length && !m.invited.includes(npcName)) return
  const ownerName = me()?.name || '我'
  // 还没人接 → 这个被邀好友接盘成局（与 npcJoin 同口径）。
  if (m.status === 'open' && !m.takerJoined) {
    const trash = rand(TAKER_TALK)
    m.takerName = npc.name
    m.takerEmoji = npc.emoji
    m.takerStake = takerStakeFor(m.ownerStake, m.odds)
    m.takerSide = m.ownerSide === 'A' ? 'B' : 'A'
    m.takerJoined = true
    m.status = 'matched'
    m.takerTrash = trash
    m.comments.push({ id: uid(), by: npc.name, emoji: npc.emoji, text: trash, at: Date.now(), npc: true })
    feedPush({
      type: 'join',
      actorName: npc.name,
      actorEmoji: npc.emoji,
      text: `应 ${ownerName} 的邀约，接了「${m.title}」，押 ${m.takerSide === 'A' ? m.optionA : m.optionB}：${trash}`,
      ref: m.id,
    })
    return
  }
  // 已成局 → 慢来的好友只在评论区凑热闹（不重复接盘）。
  const late = rand(WATCH_TALK)
  m.comments.push({ id: uid(), by: npc.name, emoji: npc.emoji, text: `也想接，慢了一步：${late}`, at: Date.now(), npc: true })
}

// 发出邀约后安排被邀 NPC 延迟响应（新建浮层"邀请好友"模式用；InviteFriends 页有自己的组件内模拟，不走这里）。
// timer 挂 friendTimers（matchId 键）→ 撤盘/到期作废/赛季重置时随 clearFriendTimers 一并清，不悬挂（LOOP-2）。
export function scheduleInviteResponses(matchId, npcNames) {
  const ids = friendTimers.get(matchId) || []
  ;(npcNames || []).forEach((name, i) => {
    ids.push(setTimeout(() => npcAcceptInvite(matchId, name), 1500 + i * 1200 + Math.random() * 2000))
  })
  friendTimers.set(matchId, ids)
}

// ---------- 收件箱：NPC 邀请"我"约赌（#3 MVP）----------

const INBOX_PRESETS = [
  { title: '今晚谁会先在群里破防？', optionA: '我先破防', optionB: '对方先破防' },
  { title: '明天咖啡谁买单？', optionA: '我买', optionB: '对方买' },
  { title: '这周谁能坚持早起三天？', optionA: '我能', optionB: '对方能' },
  { title: '下次聚餐谁会迟到？', optionA: '我迟到', optionB: '对方迟到' },
  { title: '今晚游戏第一把谁赢？', optionA: '我赢', optionB: '对方赢' },
  { title: '明天谁先发工作消息？', optionA: '我先发', optionB: '对方先发' },
  { title: '这把谁的预测更离谱？', optionA: '我更离谱', optionB: '对方更离谱' },
  { title: '周末谁先喊累？', optionA: '我先喊', optionB: '对方先喊' },
]
const INBOX_STAKES = [5000, 8000, 10000, 15000, 20000]

export function seedInboxInvites(n = 3) {
  if (shouldUseApi()) return store.inbox
  const target = Math.max(0, Number(n) || 0)
  const missing = target - inboxPendingCount()
  // 折中模型：定向邀约是私密面，收件箱氛围邀约也只来自好友（非好友冒出来邀约会破坏模型自洽）。
  const friendNpcs = NPCS.filter((x) => isFriend(x.name))
  for (let i = 0; i < missing; i++) {
    if (!friendNpcs.length) break
    const npc = rand(friendNpcs)
    const preset = rand(INBOX_PRESETS)
    store.inbox.unshift({
      id: uid(),
      fromName: npc.name,
      fromEmoji: npc.emoji,
      title: preset.title,
      optionA: preset.optionA,
      optionB: preset.optionB,
      mySide: Math.random() < 0.5 ? 'A' : 'B',
      odds: Number((randInt(15, 30) / 10).toFixed(1)),
      stake: rand(INBOX_STAKES),
      at: Date.now(),
      status: 'pending',
    })
  }
  return store.inbox
}

export function inboxPendingCount() {
  return store.inbox.filter((x) => x.status === 'pending').length
}

export function acceptInboxInvite(id) {
  if (shouldUseApi()) {
    return mutateMoney(`/matches/${encodeURIComponent(id)}/take`, {}, 'take-match')
      .then((data) => {
        applyServerState(data)
        return data.match
      })
  }
  const inv = store.inbox.find((x) => x.id === id)
  if (!inv || inv.status !== 'pending') return null
  const m = createMatch({
    title: inv.title,
    optionA: inv.optionA,
    optionB: inv.optionB,
    ownerSide: inv.mySide,
    odds: inv.odds,
    ownerStake: inv.stake,
    mode: 'match',
  })
  clearFriendTimers(m.id)
  const npc = NPCS.find((n) => n.name === inv.fromName)
  m.takerName = inv.fromName
  m.takerEmoji = npc?.emoji || inv.fromEmoji || '🙂'
  m.takerSide = inv.mySide === 'A' ? 'B' : 'A'
  m.takerStake = takerStakeFor(m.ownerStake, m.odds)
  m.takerJoined = true
  m.status = 'matched'
  inv.status = 'accepted'
  feedPush({
    type: 'join',
    actorName: me()?.name || '我',
    actorEmoji: me()?.emoji || '🫵',
    text: `我接受了 ${inv.fromName} 的邀约，开赌「${inv.title}」`,
    ref: m.id,
  })
  return m
}

export function declineInboxInvite(id) {
  if (shouldUseApi()) {
    // TODO: 后端尚未提供邀约通知标记已读接口；这里只移除本地镜像，等待 /sync 口径补齐。
    store.inbox = store.inbox.filter((x) => String(x.id) !== String(id))
    return Promise.resolve(null)
  }
  const inv = store.inbox.find((x) => x.id === id)
  if (!inv || inv.status !== 'pending') return null
  inv.status = 'declined'
  feedPush({
    type: 'decline',
    actorName: me()?.name || '我',
    actorEmoji: me()?.emoji || '🫵',
    text: `婉拒了 ${inv.fromName} 的邀约「${inv.title}」`,
    ref: null,
  })
  return inv
}

export function addComment(matchId, text, replyToCommentId = null) {
  if (shouldUseApi()) {
    const payload = replyToCommentId ? { text, replyToCommentId } : { text }
    return api.post(`/matches/${encodeURIComponent(matchId)}/comments`, payload)
      .then((data) => {
        const m = store.matches.find((x) => String(x.id) === String(matchId))
        if (m && data.comment) {
          if (!Array.isArray(m.comments)) m.comments = []
          m.comments.push(normalizeComment(data.comment))
        }
        return data.comment
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m) return
  const who = me()
  const reply = replyToCommentId ? m.comments.find((c) => String(c.id) === String(replyToCommentId)) : null
  m.comments.push({
    id: uid(),
    text,
    by: who?.name || '我',
    emoji: who?.emoji || '🫵',
    at: Date.now(),
    replyToCommentId: reply?.id || null,
    replyToName: reply?.by || '',
    replyToText: reply?.text || '',
  })
}

// ================= §A 共识揭晓（提议→投票→达阈值落账；僵局→第三方仲裁）=================
// 揭晓不再开盘人一人说了算：先提议结果 → 参与者投票 → 够票才真正结算（守恒：
// 投票/僵局/仲裁中间态绝不碰积分，只有达成共识/裁定那一刻才调原结算函数）。
// 假人版：除"我"外的参与者由组件延时调 npcAutoVote 自动投票。

// 本局共识参与者名单（我 + 假人对手）。
function consensusVoters(m) {
  const meName = me()?.name || '我'
  if (m.mode === 'banker') {
    const npcs = [...new Set((m.bets || []).filter((b) => b.npc).map((b) => b.by))]
    return [meName, ...npcs]
  }
  if (m.mode === 'pool') {
    const all = [...(m.pool?.A || []), ...(m.pool?.B || [])]
    const npcs = [...new Set(all.filter((b) => b.npc).map((b) => b.by))]
    return [meName, ...npcs]
  }
  // 约赌：我 + 接盘那个朋友
  return m.takerName ? [meName, m.takerName] : [meName]
}

// 达成共识/裁定后真正落账：复用现有结算（match 需算 ownerPayout；banker/pool 自带）。
function settleViaConsensus(m, side) {
  const settled = m.mode === 'match'
    ? { ownerPayout: side === m.ownerSide ? Math.round(m.ownerStake * m.odds) : 0 }
    : {}
  settleMatchStore(m.id, side, settled)
}

// 庄家/开盘人揭晓：默认「庄家说了算」直接裁定落账（走原结算，不投票）。
// 仅当有参与者异议时，才转入共识投票（§A）+ 僵局评审。守恒：有异议不直接落账。
export function revealWithDispute(matchId, side) {
  if (shouldUseApi()) {
    return mutateMoney(`/matches/${encodeURIComponent(matchId)}/reveal`, { result: side }, 'reveal')
      .then((data) => {
        applyServerState(data)
        return data.match
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || m.status !== 'matched') return
  if (m.consensus) return { disputed: true, disputers: [] } // 已在异议/投票流程，幂等
  const meName = me()?.name || '我'
  const npcVoters = consensusVoters(m).filter((v) => v !== meName)
  // 假人参与者各自小概率提异议（真人版换成真人点「我有异议」）。
  const disputers = npcVoters.filter(() => Math.random() < 0.2)
  if (disputers.length === 0) {
    settleViaConsensus(m, side) // 无异议：庄家说了算，直接落账（原结算逻辑，不建共识）
    return { disputed: false }
  }
  // 有异议：转入共识投票（§A）。提议=庄家裁定 side，提议人=我（默认同意自己的裁定）。
  proposeReveal(matchId, side)
  const d0 = NPCS.find((n) => n.name === disputers[0])
  feedPush({
    type: 'reveal_dispute',
    actorName: disputers[0],
    actorEmoji: (d0 && d0.emoji) || '🙋',
    text: `对「${m.title}」庄家裁定 ${side === 'A' ? m.optionA : m.optionB} 有异议，进入全员投票`,
    ref: m.id,
  })
  return { disputed: true, disputers }
}

export function disputeMatch(matchId, proposed = 'A') {
  return api.mutate(`/matches/${encodeURIComponent(matchId)}/dispute`, { proposed }, 'dispute')
    .then((data) => {
      applyServerState(data)
      return data.match
    })
}

// 发起揭晓提议：建共识态、提议人自动算同意一票，进入投票。不结算。
export function proposeReveal(matchId, side) {
  if (shouldUseApi()) {
    return mutateMoney(`/matches/${encodeURIComponent(matchId)}/reveal`, { result: side }, 'reveal')
      .then((data) => {
        applyServerState(data)
        return data.match?.consensus
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || m.status !== 'matched') return
  if (m.consensus && m.consensus.status === 'voting') return m.consensus // 已在投票，幂等
  const meName = me()?.name || '我'
  const rule = m.mode === 'match' ? 'unanimous' : 'twothirds'
  m.consensus = {
    proposed: side,
    proposer: meName,
    rule,
    voters: consensusVoters(m),
    votes: { [meName]: 'agree' }, // 提议人算同意一票
    status: 'voting', // voting | passed | deadlocked | arbitrated
    arbiter: null,
    arbitratedResult: null,
  }
  feedPush({
    type: 'reveal_propose',
    actorName: meName,
    actorEmoji: me()?.emoji || '🫵',
    text: `提议「${m.title}」揭晓为 ${side === 'A' ? m.optionA : m.optionB}，等大家投票`,
    ref: m.id,
  })
  return m.consensus
}

// 记一票 → 重新计票 → 够票则落账，僵局则标记 deadlocked。核心同步逻辑（可单测）。
export function castConsensusVote(matchId, voterName, vote) {
  if (shouldUseApi()) {
    const chosen = vote === undefined ? voterName : vote
    return mutateMoney(`/matches/${encodeURIComponent(matchId)}/vote`, { vote: chosen }, 'vote')
      .then((data) => {
        applyServerState(data)
        return data.tally
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || !m.consensus || m.consensus.status !== 'voting') return
  if (!m.consensus.voters.includes(voterName)) return
  m.consensus.votes[voterName] = vote === 'reject' ? 'reject' : 'agree'
  const t = tallyConsensus({ votes: m.consensus.votes, voters: m.consensus.voters, rule: m.consensus.rule })
  if (t.passed) {
    m.consensus.status = 'passed'
    settleViaConsensus(m, m.consensus.proposed) // 达成共识 → 落账
  } else if (t.deadlocked) {
    m.consensus.status = 'deadlocked'
    feedPush({
      type: 'reveal_deadlock',
      actorName: me()?.name || '我',
      actorEmoji: me()?.emoji || '🫵',
      text: `「${m.title}」揭晓僵持不下，该叫第三方裁判了`,
      ref: m.id,
    })
  }
  return t
}

// 一个假人自动投票：大概率同意、小概率反对（小概率制造僵局，方便测仲裁）。
export function npcAutoVote(matchId, voterName) {
  if (shouldUseApi()) return null
  const vote = Math.random() < 0.8 ? 'agree' : 'reject'
  return castConsensusVote(matchId, voterName, vote)
}

// 僵局 → 评审由"我"主动邀请一个没参与本局的人来当（中立第三方）。
// 候选名单：没参与本局投票的人。假人版=局外 NPC；真人版=局外真玩家（同一套，换数据源即可）。
export function arbiterCandidates(matchId) {
  if (shouldUseApi()) {
    return api.get(`/matches/${encodeURIComponent(matchId)}/arbiter-candidates`)
      .then((data) => data.candidates || [])
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || !m.consensus) return []
  const involved = new Set(m.consensus.voters)
  return NPCS.filter((n) => !involved.has(n.name)).map((n) => ({ name: n.name, emoji: n.emoji }))
}

// 邀请某个局外人当评审：状态 deadlocked → arbitration（已邀请、等 TA 裁定）。不落账。
export function inviteArbiter(matchId, arbiterName) {
  if (shouldUseApi()) {
    const arbiterId = store.players.find((p) => p.name === arbiterName || String(p.id) === String(arbiterName))?.id ?? arbiterName
    return api.mutate(`/matches/${encodeURIComponent(matchId)}/arbiter`, { arbiterId }, 'arbiter')
      .then((data) => {
        applyServerState(data)
        return data.match?.consensus
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || !m.consensus || m.consensus.status !== 'deadlocked') return
  const involved = new Set(m.consensus.voters)
  const cand = NPCS.find((n) => n.name === arbiterName && !involved.has(n.name)) // 评审必须中立（没参与本局）
  if (!cand) return
  m.consensus.arbiter = cand.name
  m.consensus.arbiterEmoji = cand.emoji
  m.consensus.status = 'arbitration'
  feedPush({
    type: 'reveal_arbiter_invite',
    actorName: me()?.name || '我',
    actorEmoji: me()?.emoji || '🫵',
    text: `「${m.title}」僵持不下，邀请 ${cand.name} 来当评审`,
    ref: m.id,
  })
  return m.consensus
}

// 评审裁定并落账。result 传 'A'/'B' = 评审的真实裁决（真人版）；
// 不传 = 假人版被邀 NPC 自动裁：大概率维持提议、小概率改判。
export function arbiterVerdict(matchId, result) {
  if (shouldUseApi()) {
    return mutateMoney(`/matches/${encodeURIComponent(matchId)}/verdict`, { result }, 'verdict')
      .then((data) => {
        applyServerState(data)
        return data.match?.consensus
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || !m.consensus || m.consensus.status !== 'arbitration') return
  const verdict = (result === 'A' || result === 'B')
    ? result
    : (Math.random() < 0.7 ? m.consensus.proposed : (m.consensus.proposed === 'A' ? 'B' : 'A'))
  m.consensus.status = 'arbitrated'
  m.consensus.arbitratedResult = verdict
  feedPush({
    type: 'reveal_arbitrate',
    actorName: m.consensus.arbiter,
    actorEmoji: m.consensus.arbiterEmoji,
    text: `作为评审，裁定「${m.title}」结果为 ${verdict === 'A' ? m.optionA : m.optionB}`,
    ref: m.id,
  })
  settleViaConsensus(m, verdict) // 裁定 → 落账
  return m.consensus
}

// 揭晓并结算。对手是朋友(NPC)，所以"我"只结算自己这边：
// 我押中 → 拿走奖池(=赢了对手的注)；我押错 → 下注额归对手(真实亏损)。
export function settleMatchStore(matchId, resultSide, settled = {}) {
  if (shouldUseApi()) {
    // 联机版结算只由后端 reveal/vote/verdict/cron 触发；前端不直接改余额。
    return null
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || m.status !== 'matched') return // 只允许已匹配的局结算(防open/已结算局污染战绩与积分)
  if (m.mode === 'banker') return settleBankerStore(m, resultSide)
  if (m.mode === 'pool') return settlePoolStore(m, resultSide)
  const { ownerPayout } = settled
  m.result = resultSide
  m.status = 'settled'
  m.settledAt = Date.now() // S8 还愿逾期判断基准
  const iWon = resultSide === m.ownerSide
  store.frozen = store.frozen - m.ownerStake // 解冻我的下注
  store.balance = store.balance + ownerPayout // 押中=奖池，押错=0
  // 更新"我"的战绩/连胜。
  const who = me()
  if (who) {
    if (iWon) {
      who.wins += 1
      who.streak = who.streak >= 0 ? who.streak + 1 : 1
      // 最大连胜：当前正连胜刷新历史峰值
      if (who.streak > (who.maxStreak || 0)) who.maxStreak = who.streak
      // 最神预测：押中过的最高赔率
      if (m.odds > (who.bestWinOdds || 0)) who.bestWinOdds = m.odds
    } else {
      who.losses += 1
      who.streak = who.streak <= 0 ? who.streak - 1 : -1
    }
  }
  // 对战史：按对手累计（对手是接盘的朋友 takerName，没人接盘则跳过）。
  if (m.takerName) {
    const r = store.rivals[m.takerName] || { wins: 0, losses: 0, history: [] }
    if (iWon) r.wins += 1
    else r.losses += 1
    r.history.unshift({ type: 'predict', matchId: m.id, title: m.title, iWon, at: Date.now() })
    store.rivals[m.takerName] = r
  }
  syncMe()
  ledgerPush({
    type: iWon ? 'settle_win' : 'settle_lose',
    amount: ownerPayout, // 押中=拿回奖池(含本金)，押错=0
    balanceAfter: store.balance,
    ref: m.id,
  })
  // —— 动态流：揭晓 + 连胜达成 + 打脸回放（S4）——
  const myName = who?.name || '我'
  const resultLabel = resultSide === 'A' ? m.optionA : m.optionB
  feedPush({
    type: 'settle',
    actorName: myName,
    actorEmoji: who?.emoji || '🫵',
    text: m.takerName
      ? `「${m.title}」揭晓 ${resultLabel}：${iWon ? `赢了 ${m.takerName} 💰` : `输给 ${m.takerName} 💀`}`
      : `「${m.title}」揭晓 ${resultLabel}：${iWon ? '我赢了 🎉' : '我输了 💀'}`,
    ref: m.id,
  })
  // 连胜达成："X 达成 N 连胜"（N≥2 才算连胜里程碑）。
  if (iWon && who && who.streak >= 2) {
    feedPush({
      type: 'streak',
      actorName: myName,
      actorEmoji: who.emoji || '🫵',
      text: `${myName} 达成 ${who.streak} 连胜！🔥`,
      ref: m.id,
    })
  }
  // 打脸回放：接盘 NPC 输了（=我赢）且开局甩过狠话 → 高亮到嘴炮区 + 动态流。
  if (iWon && m.takerName && m.takerTrash) {
    m.comments.push({
      id: uid(),
      by: m.takerName,
      emoji: m.takerEmoji,
      text: `当初放话「${m.takerTrash}」，结果被打脸 😂`,
      at: Date.now(),
      npc: true,
      slap: true, // 打脸高亮标记
    })
    feedPush({
      type: 'slap',
      actorName: m.takerName,
      actorEmoji: m.takerEmoji,
      text: `${m.takerName} 当初狂言「${m.takerTrash}」，「${m.title}」被 ${myName} 打脸 😂`,
      ref: m.id,
    })
  }
}

// 更新"我"的战绩/连胜/最神预测（坐庄、彩池复用）。
// iWon：我这局净盈亏是否为正；odds：本局相关赔率(刷新最神预测，可不传)；
// rivalName：记入对战史的对手名(可空)。
function recordMyResult({ iWon, odds, rivalName, matchId, title }) {
  const who = me()
  if (who) {
    if (iWon) {
      who.wins += 1
      who.streak = who.streak >= 0 ? who.streak + 1 : 1
      if (who.streak > (who.maxStreak || 0)) who.maxStreak = who.streak
      if (odds && odds > (who.bestWinOdds || 0)) who.bestWinOdds = odds
    } else {
      who.losses += 1
      who.streak = who.streak <= 0 ? who.streak - 1 : -1
    }
  }
  if (rivalName) {
    const r = store.rivals[rivalName] || { wins: 0, losses: 0, history: [] }
    if (iWon) r.wins += 1
    else r.losses += 1
    r.history.unshift({ type: 'predict', matchId, title, iWon, at: Date.now() })
    store.rivals[rivalName] = r
  }
}

// 坐庄结算：我是庄家。封顶内零和，逐笔结算押注者 + 我的 bankerPnl。
function settleBankerStore(m, resultSide) {
  m.result = resultSide
  m.status = 'settled'
  m.settledAt = Date.now() // S8 还愿逾期判断基准
  const { bankerPnl, payouts } = settleBanker({
    bankerOdds: m.bankerOdds,
    bets: m.bets,
    result: resultSide,
    bankerCap: m.bankerCap,
  })
  // 回写每笔押注的结果(给详情页展示押中/赔付)。
  payouts.forEach((p) => {
    if (m.bets[p.betIndex]) m.bets[p.betIndex].payout = p.payout
  })
  m.bankerPnl = bankerPnl
  // 我的资金：解冻保证金 bankerCap，按净盈亏入账。
  //   实际可用回收 = bankerCap + bankerPnl（盈则多于本金，亏则少；封顶保证 ≥0）。
  store.frozen = store.frozen - m.bankerCap
  store.balance = store.balance + m.bankerCap + bankerPnl
  const iWon = bankerPnl >= 0
  recordMyResult({ iWon, odds: m.bankerOdds, rivalName: null, matchId: m.id, title: m.title })
  syncMe()
  ledgerPush({
    type: iWon ? 'settle_win' : 'settle_lose',
    amount: m.bankerCap + bankerPnl,
    balanceAfter: store.balance,
    ref: m.id,
  })
  const who = me()
  const myName = who?.name || '我'
  const resultLabel = resultSide === 'A' ? m.optionA : m.optionB
  feedPush({
    type: 'settle',
    actorName: myName,
    actorEmoji: who?.emoji || '🫵',
    text: `坐庄「${m.title}」揭晓 ${resultLabel}：${iWon ? `庄家净赚 ${bankerPnl.toLocaleString()} 💰` : `庄家倒贴 ${(-bankerPnl).toLocaleString()} 💀`}`,
    ref: m.id,
  })
  if (iWon && who && who.streak >= 2) {
    feedPush({ type: 'streak', actorName: myName, actorEmoji: who.emoji || '🫵', text: `${myName} 达成 ${who.streak} 连胜！🔥`, ref: m.id })
  }
}

// 彩池结算：我是参与者，押了 ownerSide/ownerStake。赢方瓜分输方池。
function settlePoolStore(m, resultSide) {
  m.result = resultSide
  m.status = 'settled'
  m.settledAt = Date.now() // S8 还愿逾期判断基准
  const sideA = m.pool.A.map((b) => b.stake)
  const sideB = m.pool.B.map((b) => b.stake)
  const myBets = [...m.pool.A, ...m.pool.B].filter((b) => !b.npc)
  const myStake = myBets.reduce((s, b) => s + b.stake, 0)
  // 赢方无人押 → 无人瓜分，盘作废，全额退回我的注（修:避免押输方积分 silent burn）。
  const winPoolSum = (resultSide === 'A' ? sideA : sideB).reduce((s, x) => s + x, 0)
  if (winPoolSum === 0) {
    store.frozen = store.frozen - myStake
    store.balance = store.balance + myStake
    syncMe()
    ledgerPush({ type: 'unfreeze', amount: myStake, balanceAfter: store.balance, ref: m.id })
    feedPush({ type: 'settle', actorName: me()?.name || '我', actorEmoji: me()?.emoji || '🫵', text: `彩池「${m.title}」揭晓边无人押中，作废退回`, ref: m.id })
    return
  }
  const { payouts } = settlePool({ sideA, sideB, result: resultSide })
  // 回写每笔 payout 并取整（修:浮点小数进余额导致 toLocaleString 显示小数+长期漂移）。
  payouts.forEach((p) => {
    const arr = m.pool[p.side]
    if (arr && arr[p.index]) arr[p.index].payout = Math.round(p.payout)
  })
  const myPayout = myBets.reduce((s, b) => s + (b.payout || 0), 0)
  const iWon = myPayout > myStake // 净盈利才算赢（押中边有得分）
  store.frozen = store.frozen - myStake // 解冻我所有的注
  store.balance = store.balance + myPayout // 押中边=本金+瓜分，押错边=0
  // 彩池赔率（=总池/赢方池）作为"最神预测"参考赔率（赢时才记）。
  const winPool = (resultSide === 'A' ? sideA : sideB).reduce((s, x) => s + x, 0)
  const totalPool = sideA.concat(sideB).reduce((s, x) => s + x, 0)
  const effOdds = winPool > 0 ? totalPool / winPool : 0
  recordMyResult({ iWon, odds: iWon ? effOdds : 0, rivalName: null, matchId: m.id, title: m.title })
  syncMe()
  ledgerPush({
    type: iWon ? 'settle_win' : 'settle_lose',
    amount: myPayout,
    balanceAfter: store.balance,
    ref: m.id,
  })
  const who = me()
  const myName = who?.name || '我'
  const resultLabel = resultSide === 'A' ? m.optionA : m.optionB
  const net = myPayout - myStake
  feedPush({
    type: 'settle',
    actorName: myName,
    actorEmoji: who?.emoji || '🫵',
    text: `彩池「${m.title}」揭晓 ${resultLabel}：${net >= 0 ? `瓜分到手净赚 ${net.toLocaleString()} 💰` : `押错了，亏 ${(-net).toLocaleString()} 💀`}`,
    ref: m.id,
  })
  if (iWon && who && who.streak >= 2) {
    feedPush({ type: 'streak', actorName: myName, actorEmoji: who.emoji || '🫵', text: `${myName} 达成 ${who.streak} 连胜！🔥`, ref: m.id })
  }
}

// 我在某个 open 局里冻结的积分总额（退款守恒口径）。
//   约赌/坐庄 = ownerStake(坐庄即保证金封顶)；彩池 = 我所有的注(开盘+追加,防追加注锁死)。
function myFrozenIn(m) {
  if (m.mode === 'pool') {
    return [...(m.pool?.A || []), ...(m.pool?.B || [])]
      .filter((b) => !b.npc)
      .reduce((s, b) => s + b.stake, 0)
  }
  return m.ownerStake
}

// 无人接盘时撤盘：退回冻结的下注额，并移除该局（需求 5.13：冻结原路退回）。
export function cancelMatch(matchId) {
  if (shouldUseApi()) {
    return mutateMoney(`/matches/${encodeURIComponent(matchId)}/cancel`, {}, 'cancel')
      .then((data) => {
        applyServerState(data)
        return data.match
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || m.status !== 'open') return
  const refund = myFrozenIn(m)
  store.frozen = store.frozen - refund
  store.balance = store.balance + refund
  syncMe()
  ledgerPush({ type: 'unfreeze', amount: refund, balanceAfter: store.balance, ref: m.id })
  clearFriendTimers(m.id) // 撤盘后清悬挂定时器，防 NPC 回调命中已删局
  store.matches.splice(store.matches.indexOf(m), 1)
}

// ---------- 赌约异常状态机（S10 §5.13）----------
//
// 进 App / 定时调用：扫所有局，对"到截止仍无人接(open)"的盘自动作废，
// 冻结积分**原路全额退回**（退款守恒，绝不锁死）。matched 超宽限期不在此处理
// （那是裁判该揭晓的事，UI 上提示叫裁判即可，详见 governance.isSettleOverdue）。
// 返回作废的局数（给 UI 提示"X 个盘到期已自动退回"）。
export function expireStaleMatches(now = Date.now()) {
  if (shouldUseApi()) return 0
  const stale = store.matches.filter((m) => isStaleOpen(m, now))
  if (!stale.length) return 0
  stale.forEach((m) => {
    const refund = myFrozenIn(m)
    store.frozen = store.frozen - refund
    store.balance = store.balance + refund
    ledgerPush({ type: 'unfreeze', amount: refund, balanceAfter: store.balance, ref: m.id })
    const who = me()
    feedPush({
      type: 'expire',
      actorName: who?.name || '我',
      actorEmoji: who?.emoji || '🫵',
      text: `「${m.title}」到截止无人接盘，自动作废，冻结 ${refund.toLocaleString()} 已原路退回`,
      ref: null,
    })
  })
  // 清掉作废局的悬挂定时器（防 NPC 回调命中已废局，LOOP-2）。
  stale.forEach((m) => clearFriendTimers(m.id))
  syncMe()
  // 移除作废的局（与 cancelMatch 口径一致：作废即出列）。
  store.matches = store.matches.filter((m) => !stale.includes(m))
  return stale.length
}

// ---------- 申诉复议（S10 §5.8，简化原型）----------
//
// settled 后觉得揭晓不公 → 押少量复议金发起申诉（pending）。原型简化：
// 我同时也是管理员，可在申诉上"维持(uphold)/改判(overturn)"：
//   - uphold：原判维持，没收复议金（合规：押金作为乱告的成本，对应 §5.9 无理缠讼）。
//   - overturn：结果反转，反向结算（守恒），复议金原路退回。
// 只支持约赌(match)局申诉（坐庄/彩池多方结算，原型不做反向改判，避免过度设计）。

// 发起申诉：押复议金（冻结进 appeal，不进 frozen，独立记录）。
//   返回 { ok, error?, appeal? }。
export function fileAppeal({ matchId, reason, stake }) {
  if (shouldUseApi()) {
    return mutateMoney('/appeals', { matchId, reason, stake }, 'appeal')
      .then((data) => {
        applyServerState(data)
        if (data.appeal) upsertById(store.appeals, data.appeal)
        return { ok: true, appeal: data.appeal }
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m) return { ok: false, error: '赌局不存在' }
  if (m.status !== 'settled') return { ok: false, error: '只有已揭晓的局能申诉' }
  if (m.mode !== 'match') return { ok: false, error: '原型仅支持约赌局申诉' }
  if (store.appeals.some((a) => a.matchId === matchId)) {
    return { ok: false, error: '这局已申诉过，每局只能申诉一次（防重复改判）' }
  }
  const v = validateAppeal({ stake, balance: store.balance })
  if (!v.ok) return v
  const s = v.stake
  // 扣押复议金（从可用余额扣，记账本；待终审时按裁定退回或没收）。
  store.balance = store.balance - s
  syncMe()
  ledgerPush({ type: 'appeal_stake', amount: -s, balanceAfter: store.balance, ref: matchId })
  const appeal = {
    id: uid(),
    matchId,
    title: m.title,
    reason: (reason || '').trim(),
    stake: s,
    status: 'pending',
    verdict: null,
    newResult: null,
    at: Date.now(),
    resolvedAt: null,
  }
  store.appeals.unshift(appeal)
  const who = me()
  feedPush({
    type: 'appeal',
    actorName: who?.name || '我',
    actorEmoji: who?.emoji || '🫵',
    text: `对「${m.title}」的揭晓结果发起申诉复议（押 ${s.toLocaleString()} 复议金）`,
    ref: matchId,
  })
  return { ok: true, appeal }
}

// 终审裁定（我作为管理员）。verdict: 'uphold' | 'overturn'。
//   uphold：维持原判 → 没收复议金；overturn：改判反转 → 反向结算 + 退复议金。
// 返回 { ok, error? }。
export function resolveAppealStore(appealId, verdict) {
  if (shouldUseApi()) {
    return api.mutate(`/admin/appeals/${encodeURIComponent(appealId)}/resolve`, { verdict }, 'appeal-resolve')
      .then((data) => {
        applyServerState(data)
        if (data.appeal) upsertById(store.appeals, data.appeal)
        return { ok: true }
      })
  }
  if (verdict !== 'uphold' && verdict !== 'overturn') return { ok: false, error: '非法裁定' }
  const a = store.appeals.find((x) => x.id === appealId)
  if (!a || a.status !== 'pending') return { ok: false, error: '申诉不存在或已裁定' }
  const m = store.matches.find((x) => x.id === a.matchId)
  if (!m || m.status !== 'settled') return { ok: false, error: '原局状态异常' }
  const { settleDelta, appealRefund, newResult, iWonNow } = resolveAppeal({
    verdict,
    ownerStake: m.ownerStake,
    odds: m.odds,
    ownerSide: m.ownerSide,
    origResult: m.result,
    appealStake: a.stake,
  })
  const who = me()
  if (verdict === 'overturn') {
    // 反向结算：修正余额（输光归零不出局,差额由虚拟对手吸收;ledger 记实际变化）。
    if (settleDelta !== 0) {
      const before = store.balance
      store.balance = Math.max(0, before + settleDelta)
      const actualDelta = store.balance - before
      ledgerPush({
        type: actualDelta >= 0 ? 'settle_win' : 'settle_lose',
        amount: actualDelta,
        balanceAfter: store.balance,
        ref: m.id,
      })
    }
    // 复议金原路退回。
    if (appealRefund > 0) {
      store.balance = store.balance + appealRefund
      ledgerPush({ type: 'appeal_refund', amount: appealRefund, balanceAfter: store.balance, ref: m.id })
    }
    // 改写原局结果（详情页据此显示改判后结果）。
    m.result = newResult
    syncMe()
    feedPush({
      type: 'appeal',
      actorName: who?.name || '我',
      actorEmoji: who?.emoji || '🫵',
      text: `「${m.title}」复议改判：结果改为 ${newResult === 'A' ? m.optionA : m.optionB}，已反向结算（我${iWonNow ? '转赢 💰' : '转输 💀'}）`,
      ref: m.id,
    })
  } else {
    // 维持原判：复议金没收（不退，已在发起时扣除，这里不再动余额）。
    feedPush({
      type: 'appeal',
      actorName: who?.name || '我',
      actorEmoji: who?.emoji || '🫵',
      text: `「${m.title}」复议维持原判，押的 ${a.stake.toLocaleString()} 复议金没收（无理缠讼成本）`,
      ref: m.id,
    })
  }
  a.status = 'resolved'
  a.verdict = verdict
  a.newResult = verdict === 'overturn' ? newResult : m.result
  a.resolvedAt = Date.now()
  return { ok: true }
}

// ---------- 关注/收藏（S2）----------

// kind: 'matches' | 'pm'
export function toggleWatch(kind, id) {
  if (shouldUseApi()) {
    if (kind !== 'pm') return Promise.resolve()
    const watched = isWatched(kind, id)
    const op = watched
      ? api.del(`/me/watchlist/${encodeURIComponent(id)}`)
      : api.put('/me/watchlist', { eventId: id })
    return op.then(() => {
      const list = store.watchlist[kind]
      const idx = list.indexOf(id)
      if (idx === -1 && !watched) list.push(id)
      if (idx !== -1 && watched) list.splice(idx, 1)
    })
  }
  const list = store.watchlist[kind]
  if (!Array.isArray(list)) return
  const idx = list.indexOf(id)
  if (idx === -1) {
    list.push(id)
    // S16：关注系统盘 → 钉住该盘口，刷新清理时永久保留（直到取关且无押注才释放）。
    if (kind === 'pm') pinPmId(id)
  } else {
    list.splice(idx, 1)
    // 取关：若该盘已无 pending 押注则从钉住集合释放（有押注仍钉住，等结算）。
    if (kind === 'pm') releasePmIdIfIdle(id)
  }
}

export function isWatched(kind, id) {
  const list = store.watchlist[kind]
  return Array.isArray(list) && list.includes(id)
}

// ---------- 对战史与总战绩（S3）----------

// 我和每个对手的战绩，按交手次数降序。
// 返回：[{ name, emoji, wins, losses, total, lead, history }]
// lead: 我领先(+)/落后(-)/平(0)，= wins - losses。
export function getRivals() {
  if (shouldUseApi()) {
    return api.get('/me/rivals').then((data) => data.rivals || [])
  }
  return Object.entries(store.rivals)
    .map(([name, r]) => {
      const npc = store.players.find((p) => p.name === name)
      return {
        name,
        emoji: npc?.emoji || '🙂',
        wins: r.wins,
        losses: r.losses,
        total: r.wins + r.losses,
        lead: r.wins - r.losses,
        history: r.history || [],
      }
    })
    .sort((a, b) => b.total - a.total)
}

// 我的总战绩汇总（个人对赌口径）。
// 当前连胜 curStreak：me().streak 为正时的值（负数=连败，取 0）。
export function myStats() {
  const m = me() || {}
  const wins = m.wins || 0
  const losses = m.losses || 0
  const total = wins + losses
  const winRate = total > 0 ? wins / total : 0
  const curStreak = (m.streak || 0) > 0 ? m.streak : 0
  return {
    wins,
    losses,
    total,
    winRate,
    curStreak,
    maxStreak: m.maxStreak || 0,
    bestWinOdds: m.bestWinOdds || 0, // 最神预测：命中过的最高赔率
  }
}

// 改头像 emoji（S3 账号页头像选择器）。
export function setMyEmoji(emoji) {
  if (shouldUseApi()) {
    return api.patch('/me', { emoji }).then((data) => {
      applyServerState(data)
      return me()
    })
  }
  const m = me()
  if (m && emoji) m.emoji = emoji
}

// P-0.5 隐私开关：true=别人在朋友页看不到我的最近赌局/动态（单机存档先行，联机后上后端生效于真人）。
export function setMyPrivacy(v) {
  if (shouldUseApi()) {
    return api.patch('/me', { privacy: !!v }).then((data) => {
      applyServerState(data)
      return me()
    })
  }
  const m = me()
  if (m) m.privacy = !!v
}

// ---------- 线下文字彩头履约（S8 §5.3，平台只记录不结算）----------

// 这局的文字彩头是否逾期未还愿（结算后超 OVERDUE_DAYS 天）。给详情页/老赖榜用。
export function sideBetOverdue(m) {
  if (!m || !m.sideBet) return false
  return isSideBetOverdue(m.sideBet, m.settledAt)
}

// 标记"已还愿"：线下履约后，输家/开盘人在线上打勾（只改文字状态，不动积分）。
export function markSideBetFulfilled(matchId) {
  if (shouldUseApi()) {
    return api.post(`/matches/${encodeURIComponent(matchId)}/sidebet/fulfill`, {})
      .then((data) => {
        syncOnce().catch(() => {})
        return data
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || !m.sideBet || m.sideBet.fulfilled) return
  m.sideBet.fulfilled = true
  m.sideBet.fulfilledAt = Date.now()
  const who = me()
  feedPush({
    type: 'sidebet',
    actorName: who?.name || '我',
    actorEmoji: who?.emoji || '🫵',
    text: `「${m.title}」的彩头「${m.sideBet.text}」已还愿 📿`,
    ref: m.id,
  })
}

// 催债：赢家在线上发条动态催对方还愿（纯社交施压，不涉及任何结算）。
export function nagSideBet(matchId) {
  if (shouldUseApi()) {
    return api.post(`/matches/${encodeURIComponent(matchId)}/sidebet/nag`, {})
      .then((data) => {
        syncOnce().catch(() => {})
        return data
      })
  }
  const m = store.matches.find((x) => String(x.id) === String(matchId))
  if (!m || !m.sideBet || m.sideBet.fulfilled) return
  const who = me()
  feedPush({
    type: 'sidebet',
    actorName: who?.name || '我',
    actorEmoji: who?.emoji || '🫵',
    text: `📢 催债：「${m.title}」说好的「${m.sideBet.text}」该还愿了！`,
    ref: m.id,
  })
}

// ---------- 打球 / 线下对战记录（S8 §5.5/§5.6）----------
//
// 保留说明（S15 线下精简）：独立「线下打球记录」UI 已摘除（OfflineMatch.vue 未挂载），
// 故 recordOfflineMatch / offlineSideBetOverdue / nagOfflineSideBet / markOfflineFulfilled
// 这几个函数当前在组件层无调用方。**刻意保留**（爹地要求：core/offline.js 纯函数与本节
// 自建数据机制以后可复活/复用），勿删。getDeadbeatBoard 仍读 offlineMatches（老赖榜）。

// 记录一盘线下打球对战，沉淀进 offlineMatches + rivals 对战史。
//   rivalName: 对手(NPC 名)；sport: 项目('网球'…)；score: 最终比分文字；
//   iWon: 我是否赢；stake: 可选挂积分(>0 才真结算我的积分)；sideBet: 可选文字彩头文案。
// 积分赌注方案：挂积分 → 按胜负真结算我的积分(赢 +stake、输 -stake，对手 NPC，走 ledger)；
//   纯记录(stake 空/0) → 不动余额。文字彩头同对赌，只记录履约状态、不结算。
export function recordOfflineMatch({ rivalName, sport, score, iWon, stake, sideBet }) {
  if (shouldUseApi()) return null
  const npc = store.players.find((p) => !p.isMe && p.name === rivalName)
  const rEmoji = npc?.emoji || '🙂'
  const { delta, settled } = offlineScoreDelta(iWon, stake)
  if (settled) {
    if (delta < 0 && -delta > store.balance) throw new Error('积分不足以挂这笔赌注')
    store.balance = store.balance + delta
    syncMe()
    ledgerPush({
      type: delta >= 0 ? 'settle_win' : 'settle_lose',
      amount: delta,
      balanceAfter: store.balance,
      ref: 'offline',
    })
  }
  const sbText = (sideBet || '').trim()
  const rec = {
    id: uid(),
    rivalName,
    rivalEmoji: rEmoji,
    sport,
    score: (score || '').trim(),
    iWon: !!iWon,
    stake: settled ? Number(stake) : 0,
    settled,
    at: Date.now(),
  }
  if (sbText) rec.sideBet = { text: sbText, fulfilled: false, fulfilledAt: null }
  store.offlineMatches.unshift(rec)
  // 更新我的总战绩（打球计入胜负/连胜，但不刷"最神预测"赔率——线下无赔率）。
  recordMyResultRivalless(iWon)
  // 沉淀进对战史：标记 type:'offline'，与预测对赌同列。
  const r = store.rivals[rivalName] || { wins: 0, losses: 0, history: [] }
  if (iWon) r.wins += 1
  else r.losses += 1
  r.history.unshift({
    type: 'offline',
    matchId: rec.id,
    title: `${sport} ${rec.score}`.trim(),
    iWon: !!iWon,
    at: Date.now(),
  })
  store.rivals[rivalName] = r
  // 动态流：谁线下赢/输了谁。
  const who = me()
  const myName = who?.name || '我'
  feedPush({
    type: 'offline',
    actorName: myName,
    actorEmoji: who?.emoji || '🫵',
    text: `线下${sport}${rec.score ? ` ${rec.score}` : ''}：${iWon ? `赢了 ${rivalName} 🏓` : `输给 ${rivalName} 😮‍💨`}${settled ? `（挂 ${Number(stake).toLocaleString()} 积分）` : ''}`,
    ref: rec.id,
  })
  return rec
}

// 只更新"我"的胜负/连胜（不记对战史、不碰最神预测），供打球记录复用。
function recordMyResultRivalless(iWon) {
  const who = me()
  if (!who) return
  if (iWon) {
    who.wins += 1
    who.streak = who.streak >= 0 ? who.streak + 1 : 1
    if (who.streak > (who.maxStreak || 0)) who.maxStreak = who.streak
  } else {
    who.losses += 1
    who.streak = who.streak <= 0 ? who.streak - 1 : -1
  }
}

// 线下打球彩头是否逾期未还愿（基准用记录的 at 字段；与老赖榜口径一致，S8 LOOP-2）。
export function offlineSideBetOverdue(rec) {
  if (shouldUseApi()) return false
  if (!rec || !rec.sideBet) return false
  return isSideBetOverdue(rec.sideBet, rec.at)
}

// 催债：线下彩头赢家在线上发条动态催对方还愿（纯社交施压，不涉及任何结算，S8 LOOP-2）。
export function nagOfflineSideBet(recId) {
  if (shouldUseApi()) return null
  const rec = store.offlineMatches.find((x) => x.id === recId)
  if (!rec || !rec.sideBet || rec.sideBet.fulfilled) return
  const who = me()
  feedPush({
    type: 'sidebet',
    actorName: who?.name || '我',
    actorEmoji: who?.emoji || '🫵',
    text: `📢 催债：线下和 ${rec.rivalName} 说好的「${rec.sideBet.text}」该还愿了！`,
    ref: null,
  })
}

// 标记线下打球的文字彩头已还愿。
export function markOfflineFulfilled(recId) {
  if (shouldUseApi()) return null
  const rec = store.offlineMatches.find((x) => x.id === recId)
  if (!rec || !rec.sideBet || rec.sideBet.fulfilled) return
  rec.sideBet.fulfilled = true
  rec.sideBet.fulfilledAt = Date.now()
  const who = me()
  feedPush({
    type: 'sidebet',
    actorName: who?.name || '我',
    actorEmoji: who?.emoji || '🫵',
    text: `线下和 ${rec.rivalName} 的彩头「${rec.sideBet.text}」已还愿 📿`,
    ref: null,
  })
}

// ---------- 系统盘数据机制（S15：漏斗 + DeepSeek 加工 + 24h 懒更新缓存）----------
//
// 数据流：fetchPolymarketEvents（API 拉 + 6 层漏斗 → top200）→ 对"缓存里没有的新盘"
// 先英文降级写入 pmCache.byId，再由 retranslateAllUntranslated 渐进翻译。
// 增量：老盘读 cache 不重翻，省 DeepSeek 钱。只把 compliant:true 的盘给前端。

// 每日刷新点：凌晨 3 点。接云后由后端 cron 在该点真爬+翻译写云端缓存；当前纯本地
// 原型无后台进程，近似为「跨过该点后第一个打开 app 的用户，后台静默触发一次更新」。
const PM_REFRESH_HOUR = 3
// S16：byId 清理防膨胀——非钉住盘超过此时长（自 createdAt）且跌出本次 top200 即清。
const PM_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 天
// S16：自动结算单次最多并发查多少个 pending 盘口（限并发防刷/限流）。
const PM_AUTOSETTLE_BATCH = 10
// 世界杯单场开赛后一段时间不再出现在大厅可下注区；下注结果仍在「我的」历史里看。
const WC_GAME_HIDE_AFTER_MS = 3 * 60 * 60 * 1000

// ---------- S16 钉住保护：押注/关注的盘永久保留，刷新清理时跳过 ----------

// 把盘口 id 加入钉住集合（幂等）。押注/关注时调用。
function pinPmId(id) {
  if (id == null || id === '') return
  const ids = store.pmCache.pinnedIds
  const key = String(id)
  if (!ids.includes(key)) ids.push(key)
}

// 该盘是否钉住（清理时跳过）。
function isPmPinned(id) {
  return store.pmCache.pinnedIds.includes(String(id))
}

// 释放钉住：仅当该盘既无 pending 押注、又未被关注时才从钉住集合移除（进历史后调用，防误删活押注盘）。
function releasePmIdIfIdle(id) {
  const key = String(id)
  const hasPending = store.pmBets.some((b) => b.status === 'pending' && String(b.eventId) === key)
  const watched = (store.watchlist.pm || []).map(String).includes(key)
  if (hasPending || watched) return
  const ids = store.pmCache.pinnedIds
  const idx = ids.indexOf(key)
  if (idx !== -1) ids.splice(idx, 1)
}

// S16 清理防膨胀：每日重拉后调用，清掉 byId 里「非钉住 且 (跌出本次 top200 或 createdAt 超期)」
// 的老盘。钉住盘（押注/关注过）永不清。activeIds 是本次重拉 funnel 后的 id 集合（视为活跃池）。
// 返回清掉的盘数（给日志/UI）。
function cleanupPmCache(activeIds, now = Date.now()) {
  const active = new Set(activeIds.map(String))
  const byId = store.pmCache.byId
  let removed = 0
  for (const id of Object.keys(byId)) {
    if (isPmPinned(id)) continue // 钉住盘永不清
    if (active.has(id)) continue // 仍在本次活跃池 top200 → 保留（热度/概率会被更新）
    // 到这里 = 非钉住 且 跌出 top200 → 清（钉住盘前面已 continue 豁免，押注/关注盘安全）。
    delete byId[id]
    removed += 1
  }
  return removed
}

// 渐进重翻每次最多补翻多少条未中文化的盘（防 DeepSeek 限流，一次翻太多又触发限流）。
// 一次翻不完的剩下的，下次进系统盘再补一批，多次进系统盘渐进翻完。
const PM_RETRANSLATE_N = 30

// 含中文字符判定：CJK 统一表意区有字符即视为已中文化。
const HAS_CJK = /[一-龥]/

// 某缓存渲染包是否"未中文化"：zhTitle 空 / 等于英文 enTitle / 不含中文字符（三者任一即未翻）。
// 这是 DeepSeek 一次翻 200 条限流后留下的英文盘（compliant 已 true 被缓存、known 跳过不重翻 → 永久英文），
// 渐进重试就靠这个判定把它们挑出来重翻。
export function pmCardNeedsZh(c) {
  if (!c) return false
  if (c.subcat === '世界杯' && c.kind === 'outright') return false // P1 世界杯榜单盘本地翻译，不进重翻队列。
  if (c.kind === 'match' && matchHasLocalZh(c.match)) return false // P3 NBA 单场队名本地翻译，不进重翻队列。
  const zh = (c.zhTitle || '').trim()
  const en = (c.enTitle || '').trim()
  if (!zh) return true // 没中文标题
  if (en && zh === en) return true // 中文标题等于英文（= 没真翻，降级回英文）
  return !HAS_CJK.test(zh) // 不含任何中文字符
}

// 从缓存渲染包重建一个「伪 event」喂给 enrichEventsWithDS（渐进重翻用）。
// 缓存包只留了主盘（market.question/outcomes/outcomePrices）和英文 description/enTitle，
// 与 enrichEventsWithDS 期望的 event 形状对齐（pmEnrichInput 读 id/title/description/markets/outcomes）。
// 注意：渲染包只存主盘，多盘的其他 question 已丢，渐进重翻只补主盘 zhQuestion（与缓存透出口径一致）。
function pseudoEventFromCard(c) {
  const m = c.market || {}
  return {
    id: c.id,
    title: c.enTitle || '',
    description: c.description || '', // 缓存里 description 存的是英文原文
    tags: [],
    markets: [{ question: m.question || '', outcomes: m.outcomes || '[]', outcomePrices: m.outcomePrices || '[]' }],
  }
}

// 渐进重翻：在 byId 里挑出"未中文化"的盘，取前 N 个重新调 DeepSeek 翻译，
// 把 zhTitle/zhDescription/zhOutcomes/zhQuestions[0] 更新回对应缓存包（已中文化的跳过不重翻）。
// 限量 N（PM_RETRANSLATE_N）防再次触发限流；多次进系统盘渐进翻完。返回实际重翻成功的条数。
export async function retranslateUntranslated(limit = PM_RETRANSLATE_N) {
  const byId = store.pmCache.byId || {}
  const pending = Object.values(byId).filter(pmCardNeedsZh).slice(0, limit)
  if (!pending.length) return 0
  const enriched = await enrichEventsWithDS(pending.map(pseudoEventFromCard))
  const byEnrichId = new Map(enriched.map((e) => [String(e.id), e]))
  let done = 0
  pending.forEach((c) => {
    const e = byEnrichId.get(String(c.id))
    if (!e) return
    // 只在确实翻出中文时才回写（DeepSeek 仍限流/降级会回英文，保持原样等下次再补，不空写覆盖）。
    const zhTitle = String(e.zhTitle || '').trim()
    if (!zhTitle || !HAS_CJK.test(zhTitle)) return
    const card = byId[String(c.id)]
    if (!card) return
    card.zhTitle = zhTitle
    if (e.zhDescription) card.zhDescription = e.zhDescription
    if (Array.isArray(e.zhOutcomes)) card.zhOutcomes = e.zhOutcomes
    if (card.market && e.zhQuestions && e.zhQuestions[0]) card.market.zhQuestion = e.zhQuestions[0]
    if (Array.isArray(card.markets) && Array.isArray(e.zhQuestions)) {
      card.markets = card.markets.map((m, i) => ({
        ...m,
        zhQuestion: e.zhQuestions[i] || m.zhQuestion || '',
      }))
    }
    done += 1
  })
  return done
}

// 循环重翻轮次间的停顿（给 DeepSeek 限流恢复时间）。测试可设 0 加速。
let _retranslatePauseMs = 600
export function _setRetranslatePauseForTest(ms) {
  _retranslatePauseMs = ms
}

// 把缓存里所有未中文化的盘尽量「一次翻完」（重拉后 / 进系统盘时后台调用，实现「爬完即全中文」）。
// 循环补翻：每轮翻一批(PM_RETRANSLATE_N)，直到 ①没有未翻盘 ②连续两轮翻不出新中文(多半限流→退避，
// 留给下次再补，不死循环) ③达轮次上限。轮间停顿给限流恢复时间。
// 修掉「限流降级成英文、compliant:true 的盘下次重拉不在 fresh 里 → 永不重翻」的洞：
//   retranslateUntranslated 按 pmCardNeedsZh(空/英文/无中文) 筛，不看 compliant，能抓到这些降级盘。
// 全已中文化时 pending=0 立刻返回，零开销（适合每次进系统盘都调）。
export async function retranslateAllUntranslated(maxRounds = 20) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let stale = 0
  for (let r = 0; r < maxRounds; r++) {
    if (r > 0 && _retranslatePauseMs > 0) await sleep(_retranslatePauseMs)
    const pending = Object.values(store.pmCache.byId || {}).filter(pmCardNeedsZh).length
    if (pending === 0) break
    const done = await retranslateUntranslated()
    if (done === 0) {
      stale += 1
      if (stale >= 2) break // 连续两轮没翻出新中文 → 退避放弃，留给下次进系统盘再补
    } else {
      stale = 0
    }
  }
}

// 取某 event 主盘第一个结果的概率（缓存里存一份，前端排序/展示用）。
function pmTopProb(ev) {
  const match = groupMatchMarkets(ev)
  if (match.moneyline?.options?.length) return match.moneyline.options[0].prob
  const rows = aggregateOutright(ev)
  if (rows.length >= 3) return rows[0].prob
  const opts = parseOutcomes(ev.markets?.[0] || {})
  return opts.length ? opts[0].prob : 0
}

// P1 计算榜单候选：真实英文 name/outcomes 原样保留，zhName 只做展示。
function pmOutrightRows(ev) {
  return aggregateOutright(ev).map((r) => ({
    ...r,
    zhName: translateEntityLocal(r.name),
  }))
}

function addZhToMatchPart(part) {
  if (!part) return null
  return {
    ...part,
    options: (part.options || []).map((o) => ({
      ...o,
      zhName: translateEntityLocal(o.name),
    })),
  }
}

function pmMatchGroup(ev) {
  const grouped = groupMatchMarkets(ev)
  return {
    teams: grouped.teams,
    moneyline: addZhToMatchPart(grouped.moneyline),
    spread: addZhToMatchPart(grouped.spread),
    total: addZhToMatchPart(grouped.total),
  }
}

function matchHasLocalZh(match) {
  const teams = Array.isArray(match?.teams) ? match.teams : []
  if (!teams.length) return false
  return teams.every((name) => HAS_CJK.test(translateEntityLocal(name)))
}

function matchTitleZh(match, fallback = '') {
  const teams = Array.isArray(match?.teams) ? match.teams : []
  if (teams.length === 2 && teams.every((name) => HAS_CJK.test(translateEntityLocal(name)))) {
    return `${translateEntityLocal(teams[0])} vs ${translateEntityLocal(teams[1])}`
  }
  return fallback
}

export function pmKindForEvent(ev) {
  if (ev?.subcat === '世界杯' && aggregateOutright(ev).length >= 3) return 'outright'
  if (isMatchEvent(ev)) return 'match'
  return 'simple'
}

function isWorldCupOutright(ev) {
  if (pmKindForEvent(ev) !== 'outright') return false
  const text = `${ev.subcat || ''} ${ev.slug || ''} ${ev.title || ''}`.toLowerCase()
  return text.includes('世界杯') || text.includes('world-cup') || text.includes('world cup')
}

// 把一条漏斗后的原始 event + DeepSeek enrich 结果压成「缓存渲染包」：存全前端卡片/详情
// 所需的最小字段，不依赖任何内存变量。刷新页面后即便内存归零，也能纯从缓存重建卡片。
//   - market：只留主盘的 question + zhQuestion(中文盘口问题) + outcomes + outcomePrices
//     （JSON 字符串与真实 API 一致，downstream parseOutcomes 不用改）。
//   - description/zhDescription：英文/中文事件描述（详情页优先显示中文）。
//   - icon/description/volume24hr：前端卡片与详情页直接读的字段。
//   enrich：{ zhDescription, zhQuestions[] }，与 markets 按序对齐（markets[0] 用 zhQuestions[0]）。
function pmCacheCard(ev, enrich = {}) {
  // 世界杯单场聚合卡（kind='wcgame'）已是终态结构（groups/gameDate/本地词典中文），
  // 直通入缓存——绝不过 pmKindForEvent 重判（会误判成 simple 丢掉三组玩法）
  if (ev.kind === 'wcgame') return { ...ev, compliant: true }
  const m0 = ev.markets?.[0] || {}
  const kind = pmKindForEvent(ev)
  const outright = kind === 'outright' ? pmOutrightRows(ev) : []
  const match = kind === 'match' ? pmMatchGroup(ev) : null
  const zhDescription = ev.subcat === '世界杯' ? playTypeDescZh(ev) : (enrich.zhDescription || '')
  // P2 非专题盘在缓存层补二级分类；专题 tag 盘已有 subcat，绝不覆盖。
  const subcatEvent = enrich.category ? { ...ev, category: enrich.category } : ev
  const subcat = ['世界杯', 'NBA', '特朗普'].includes(ev.subcat) ? ev.subcat : (classifySubcat(subcatEvent) || ev.subcat || '')
  const markets = Array.isArray(ev.markets)
    ? ev.markets.map((m, i) => ({
      ...m,
      zhQuestion: (enrich.zhQuestions && enrich.zhQuestions[i]) || '',
    }))
    : []
  const card = {
    id: String(ev.id),
    enTitle: ev.title || '',
    icon: ev.icon || '',
    description: ev.description || '',
    zhDescription, // 中文事件描述（详情页优先用）
    volume24hr: Math.round(ev.volume24hr || 0),
    kind,
    markets,
    market: {
      question: m0.question || ev.title || '',
      zhQuestion: (enrich.zhQuestions && enrich.zhQuestions[0]) || '', // 主盘中文问题
      outcomes: m0.outcomes || '[]',
      outcomePrices: m0.outcomePrices || '[]',
    },
  }
  if (subcat) card.subcat = subcat
  if (ev.wcSubcat) card.wcSubcat = ev.wcSubcat // 世界杯玩法 tab 侧拉分类（奖项/球员对决/…）
  if (outright.length) card.outright = outright
  if (match) card.match = match
  return card
}

// 最近一个已过去的「凌晨 3 点」时间戳（本地时区）。
function lastRefreshPoint(now) {
  const d = new Date(now)
  d.setHours(PM_REFRESH_HOUR, 0, 0, 0) // 当天 03:00:00.000（本地）
  if (d.getTime() > now) d.setDate(d.getDate() - 1) // 还没到今天 3 点 → 取昨天 3 点
  return d.getTime()
}

// 是否到了「该更新」的时机：缓存为空，或上次更新发生在最近一个凌晨 3 点之前
// （即跨过了一个 3 点刷新点）。一天最多触发一次后台更新。
function pmRefreshDue(now = Date.now()) {
  const c = store.pmCache
  if (!c || !c.fetchedAt) return true
  if (!c.byId || Object.keys(c.byId).length === 0) return true
  return c.fetchedAt < lastRefreshPoint(now)
}

// 【真正干活的更新入口 / 接云后凌晨 3 点 cron 直接调它】
// 重拉 Polymarket → 6 层漏斗 → top200 → 新增盘先英文降级写入 byId → 清理 →
// 同步「把翻译工作做完」（循环补翻直到全中文/限流退避）。完成后缓存即全中文。
// 可 await，跑完返回当前合规盘列表。前端不直接调它（会阻塞），由 refreshPmIfStale 后台触发。
export async function pmUpdateNow({ now = Date.now() } = {}) {
  const funneled = await fetchPolymarketEvents() // 已过 6 层漏斗 + top200，挂了 category
  const activeIds = funneled.map((ev) => String(ev.id)) // 本次活跃池（top200），清理基准
  // 增量：只对缓存里没有的 id 调 DeepSeek。
  const known = store.pmCache.byId || {}
  // 新盘 + 之前被判 compliant:false 的(给二次 enrich 机会,防 DeepSeek 偶发故障把盘永久埋没)；compliant:true 读 cache
  const fresh = funneled.filter((ev) => {
    const k = known[String(ev.id)]
    return !k || k.compliant === false
  })
  if (fresh.length) {
    // 世界杯单场聚合卡：终态结构直通（本地词典已中文化），绝不进 DeepSeek 降级路径（会清空 zhTitle 待翻）
    fresh.filter((ev) => ev.kind === 'wcgame').forEach((ev) => {
      store.pmCache.byId[String(ev.id)] = pmCacheCard(ev, {})
    })
    const wcgameIds = new Set(fresh.filter((ev) => ev.kind === 'wcgame').map((ev) => String(ev.id)))
    const nonGame = fresh.filter((ev) => !wcgameIds.has(String(ev.id)))
    const localOutrights = nonGame.filter(isWorldCupOutright)
    localOutrights.forEach((ev) => {
      store.pmCache.byId[String(ev.id)] = {
        ...pmCacheCard(ev, {}),
        zhTitle: playTypeZh(ev) || ev.title || '',
        zhOutcomes: ['是', '否'],
        category: ev.category,
        prob: pmTopProb(ev),
        volume: Math.round(ev.volume24hr || 0),
        createdAt: ev.createdAt ? new Date(ev.createdAt).getTime() : Date.now(),
        compliant: true,
      }
    })
    const localMatches = nonGame.filter((ev) => !isWorldCupOutright(ev) && pmKindForEvent(ev) === 'match' && matchHasLocalZh(groupMatchMarkets(ev)))
    localMatches.forEach((ev) => {
      const match = groupMatchMarkets(ev)
      store.pmCache.byId[String(ev.id)] = {
        ...pmCacheCard(ev, {}),
        zhTitle: matchTitleZh(match, ev.title || ''),
        zhOutcomes: [],
        category: ev.category,
        prob: pmTopProb(ev),
        volume: Math.round(ev.volume24hr || 0),
        createdAt: ev.createdAt ? new Date(ev.createdAt).getTime() : Date.now(),
        compliant: true,
      }
    })
    const localMatchIds = new Set(localMatches.map((m) => String(m.id)))
    const dsFresh = nonGame.filter((ev) => !isWorldCupOutright(ev) && !localMatchIds.has(String(ev.id)))
    dsFresh.forEach((ev) => {
      // 先英文降级写入，避免几百个新盘整批等 DeepSeek 限流后才可见。
      // 后续 retranslateAllUntranslated 会按 pmCardNeedsZh 渐进翻成中文。
      store.pmCache.byId[String(ev.id)] = {
        ...pmCacheCard(ev, {}),
        zhTitle: '',
        zhOutcomes: parseOutcomes(ev.markets?.[0] || {}).map((o) => o.name),
        category: ev.category,
        prob: pmTopProb(ev),
        volume: Math.round(ev.volume24hr || 0),
        createdAt: ev.createdAt ? new Date(ev.createdAt).getTime() : Date.now(),
        compliant: !isSensitiveEvent(ev),
      }
    })
  }
  store.pmCache.fetchedAt = now
  // S16 清理防膨胀：重拉后清掉非钉住的跌出 top200/超期老盘（钉住盘永不清）。
  cleanupPmCache(activeIds, now)
  // 更新的「同一次」就把翻译做完（爹地要求）——循环补翻直到全中文/限流退避，
  // 确保更新完成时缓存就是全中文，用户之后进来读缓存永远不撞英文。
  await retranslateAllUntranslated()
  return compliantCachedList()
}

// 【上线版：读服务端 cron 预生成的系统盘缓存】 /pm-cache.json
// 服务器每天凌晨 3 点跑 deploy/build-pm-cache.mjs（复用本文件 pmUpdateNow 真实管线：拉+漏斗+
// 合规+DeepSeek 翻译），产出全中文小 JSON。前端读它 → 30 人不各自实时拉 4MB、不各自烧 DeepSeek。
// 合并进 byId：服务端盘覆盖/新增；用户钉住(押注/关注)的本地盘保留；跌出活跃集的非钉住盘清掉。
// 文件不存在(dev / 服务端没跑)或解析失败 → 返回 false，调用方回退本地 live 路径。
async function loadServerPmCache(now = Date.now()) {
  try {
    const res = await fetch('/pm-cache.json', { cache: 'no-cache' })
    if (!res.ok) return false
    const data = await res.json()
    const byId = data && data.byId
    if (!byId || typeof byId !== 'object' || !Object.keys(byId).length) return false
    Object.assign(store.pmCache.byId, byId) // 服务端盘覆盖/新增，用户钉住盘原样保留
    cleanupPmCache(Object.keys(byId), now) // 非钉住且跌出服务端活跃集 → 清（钉住盘永不清）
    store.pmCache.fetchedAt = now
    return true
  } catch {
    return false // 网络错/非 JSON → 回退 live
  }
}

// 【前端进系统盘的入口 —— 永不阻塞，永远秒返当前缓存】
// 上线版优先读服务端预生成缓存（loadServerPmCache）；当日已读过则零网络直接返缓存。
// dev / 服务端缓存缺失时回退原本地 live 路径（pmUpdateNow / retranslate），逻辑不变。
//   - force=true（调试用）：强制重读服务端缓存，失败再回退 live。
export async function refreshPmIfStale({ force = false, now = Date.now() } = {}) {
  const haveCache = store.pmCache.byId && Object.keys(store.pmCache.byId).length > 0
  if (!force && haveCache && !pmRefreshDue(now)) {
    return compliantCachedList() // 已有当日缓存，零网络
  }
  if (haveCache) {
    // 已有可展示缓存：服务端缓存合并走后台（不 await，慢网/挂死都卡不住用户），
    // pmEvents 是 computed(reactive)，合并落地自动上屏——「永不阻塞，永远秒返当前缓存」。
    loadServerPmCache(now)
      .then((ok) => {
        if (ok) return
        if (force || pmRefreshDue(now)) pmUpdateNow({ now }).catch(() => {})
        else retranslateAllUntranslated().catch(() => {})
      })
      .catch(() => {})
    return compliantCachedList()
  }
  // 无缓存（首次进入，反正没东西可显示）：await 服务端缓存（静态小文件，快）。
  if (await loadServerPmCache(now)) {
    return compliantCachedList() // 上线版：读到服务端缓存即可，不实时拉、不烧 DeepSeek
  }
  // 回退 dev / 无服务端缓存：原本地 live 路径（后台 fire-and-forget，不卡用户）。
  if (force || pmRefreshDue(now)) {
    pmUpdateNow({ now }).catch(() => {}) // 后台静默更新+翻译
  } else {
    retranslateAllUntranslated().catch(() => {}) // 后台补翻英文残留
  }
  return compliantCachedList()
}

// 纯从 pmCache.byId 重建前端卡片列表，只返回 compliant:true 的盘。
// 不依赖任何内存变量 → 页面刷新（内存归零、localStorage 仍在）后系统盘照常自给自足。
// 输出形状与原 event 兼容：合成 markets[0]（question/outcomes/outcomePrices）供
// parseOutcomes / 详情页直接用；icon/description/volume24hr 给卡片与详情读。
function compliantCachedList() {
  const byId = store.pmCache.byId || {}
  const now = Date.now()
  return Object.values(byId)
    .filter((c) => c && c.compliant) // 只放合规盘
    .filter((c) => c.kind !== 'wcgame' || !c.gameStart || Number(c.gameStart) + WC_GAME_HIDE_AFTER_MS > now)
    .map((c) => {
      const item = {
        id: c.id,
        title: c.zhTitle || c.enTitle || '', // 中文标题（降级英文）
        zhOutcomes: c.zhOutcomes || [],
        category: c.category,
        kind: c.kind || 'simple',
        prob: c.prob,
        volume: c.volume,
        volume24hr: c.volume24hr ?? c.volume ?? 0, // 卡片热度显示统一字段
        createdAt: c.createdAt,
        icon: c.icon || '',
        description: c.zhDescription || c.description || '', // 中文事件描述（降级英文）
        markets: Array.isArray(c.markets) && c.markets.length ? c.markets : (c.market ? [c.market] : []), // P1 outright 保留完整 markets
        compliant: true,
      }
      if (c.subcat) item.subcat = c.subcat
      if (c.wcSubcat) item.wcSubcat = c.wcSubcat // 世界杯玩法 tab 侧拉分类
      if (Array.isArray(c.outright) && c.outright.length) item.outright = c.outright
      if (c.kind === 'match' && c.match) item.match = c.match
      if (c.kind === 'wcgame') { // 世界杯单场专题字段透传（比赛 tab + 详情三组玩法）
        item.zhTitle = c.zhTitle
        item.groups = c.groups
        item.gameDate = c.gameDate
        item.gameStart = c.gameStart
      }
      return item
    })
}

// 给前端取当前合规缓存列表（不触发网络，刷新由 refreshPmIfStale 负责）。
export function pmCachedList() {
  return compliantCachedList()
}

// ---------- 系统盘留言板（替代原 DeepSeek 预测；本地单机 + NPC 预设氛围）----------

// 取某盘口的留言列表（按时间升序：旧在上、新在下，像聊天）。无则空数组。
export function pmCommentsFor(eventId) {
  if (shouldUseApi()) {
    const key = String(eventId)
    api.get(`/pm/${encodeURIComponent(key)}/comments`, { countLoading: false })
      .then((data) => {
        store.pmComments[key] = (data.comments || []).map(normalizeComment)
      })
      .catch(() => {})
  }
  const key = String(eventId)
  const list = store.pmComments[key]
  return Array.isArray(list) ? list.slice().sort((a, b) => a.at - b.at) : []
}

// 进盘时 seed 一批 NPC 预设氛围评论（零 API）。幂等：该盘已有 NPC 评论则跳过，
// 不重复 seed（刷新/再进不会越堆越多）。随机抽 1-3 个不同 NPC，各甩一句通用口水。
export function seedNpcPmComments(eventId, now = Date.now()) {
  if (shouldUseApi()) return 0
  const key = String(eventId)
  if (!Array.isArray(store.pmComments[key])) store.pmComments[key] = []
  const list = store.pmComments[key]
  if (list.some((c) => c.npc)) return 0 // 已 seed 过，不重复
  const n = randInt(1, 3)
  const pickedNpcs = NPCS.slice().sort(() => Math.random() - 0.5).slice(0, n)
  const pickedTalks = PM_BOARD_TALK.slice().sort(() => Math.random() - 0.5)
  pickedNpcs.forEach((npc, i) => {
    list.push({
      id: uid(),
      by: npc.name,
      emoji: npc.emoji,
      text: pickedTalks[i % pickedTalks.length],
      // 让 seed 的几条时间略微错开（早于「现在」），排序自然、不挤在同一刻。
      at: now - (n - i) * 1000,
      npc: true,
    })
  })
  return pickedNpcs.length
}

// 我发一条留言。空白拒发。存入对应盘口的 pmComments。
export function postPmComment(eventId, text, replyToCommentId = null) {
  if (shouldUseApi()) {
    const key = String(eventId)
    const payload = replyToCommentId ? { text, replyToCommentId } : { text }
    return api.post(`/pm/${encodeURIComponent(key)}/comments`, payload)
      .then((data) => {
        if (!Array.isArray(store.pmComments[key])) store.pmComments[key] = []
        if (data.comment) upsertById(store.pmComments[key], normalizeComment(data.comment))
        return data.comment
      })
  }
  const t = String(text || '').trim()
  if (!t) throw new Error('留言不能为空')
  const key = String(eventId)
  if (!Array.isArray(store.pmComments[key])) store.pmComments[key] = []
  const who = me()
  const reply = replyToCommentId ? store.pmComments[key].find((c) => String(c.id) === String(replyToCommentId)) : null
  const c = {
    id: uid(),
    by: who?.name || '我',
    emoji: who?.emoji || '🫵',
    text: t,
    at: Date.now(),
    npc: false,
    replyToCommentId: reply?.id || null,
    replyToName: reply?.by || '',
    replyToText: reply?.text || '',
  }
  store.pmComments[key].push(c)
  return c
}

// ---------- Polymarket 押注 ----------

// outcome：真实英文 outcome 名（守恒命脉：下注/结算比较都用它，绝不改）。
// zhOutcome：中文展示名（查 cache 得来），只供 UI/动态流显示，不参与任何结算逻辑。
export function placePmBet({ eventId, marketId = null, eventTitle, marketQuestion, outcome, prob, stake, zhOutcome }) {
  if (shouldUseApi()) {
    return mutateMoney('/pm-bets', { eventId, marketId, outcome, stake }, 'pm-bet')
      .then((data) => {
        applyServerState(data)
        return data.bet
      })
  }
  if (!(stake > 0)) throw new Error('下注额必须大于 0')
  if (!(prob > 0)) throw new Error('该盘口概率异常，暂不可下注') // 防 prob=0 致 odds=0 派彩退化为仅返本
  if (stake > store.balance) throw new Error('积分不足')
  store.balance = store.balance - stake
  syncMe()
  const odds = prob > 0 ? 1 / prob : 0
  const bet = {
    id: uid(),
    eventId: eventId ?? null, // 绑盘口 id 防同名盘(zhTitle碰撞)押注串台
    marketId: marketId ?? null, // P1 多候选榜单绑定真实 marketId；旧押注为 null 时仍走 eventId
    eventTitle,
    marketQuestion,
    outcome, // 真实英文 outcome（守恒命脉）
    zhOutcome: (zhOutcome || outcome), // 中文显示名（降级回英文）
    prob,
    odds,
    stake,
    at: Date.now(),
    // 结算字段（S11）：status pending|won|lost；result 真实/模拟揭晓的胜负边；payout 赢得的派彩(含本金)
    status: 'pending',
    result: null,
    payout: 0,
    settledAt: null,
  }
  store.pmBets.unshift(bet)
  // S16：押注即钉住该盘口，刷新清理时永久保留，直到自动结算进历史后释放。
  if (eventId != null) pinPmId(eventId)
  ledgerPush({ type: 'pm_bet', amount: -stake, balanceAfter: store.balance, ref: bet.id })
  return bet
}

// ---- S11 押注结算派彩 ----
// 守恒模型：系统是「虚拟庄」（无独立账户）。下注时本金已从我余额扣走(pm_bet)。
//   我赢 → 系统赔付 payout = round(stake * odds)（含本金，按市场赔率 1/prob），走 ledger(pm_win)；
//   我输 → 本金已扣、无返还，走 ledger(pm_lose, amount:0) 仅留审计痕迹。
// 系统作为虚拟对手吸收差额，全局守恒以「我余额变化 = -stake(下注) + payout(赢) 」记账。
function applyPmSettle(bet, iWon) {
  if (bet.status !== 'pending') return bet // 幂等：已结算不重复派彩
  bet.settledAt = Date.now()
  if (iWon) {
    const payout = Math.round(bet.stake * (bet.odds > 0 ? bet.odds : 1))
    bet.status = 'won'
    bet.result = bet.outcome
    bet.payout = payout
    store.balance = store.balance + payout
    syncMe()
    ledgerPush({ type: 'pm_win', amount: payout, balanceAfter: store.balance, ref: bet.id })
  } else {
    bet.status = 'lost'
    bet.payout = 0
    // result 在两条调用路径里分别赋值（真实结果 / 模拟揭晓边）
    ledgerPush({ type: 'pm_lose', amount: 0, balanceAfter: store.balance, ref: bet.id })
  }
  feedPush({
    type: 'settle',
    actorName: me()?.name || '我',
    actorEmoji: me()?.emoji || '🫵',
    text: iWon
      ? `跟系统盘对赌「${bet.eventTitle}」押中「${bet.zhOutcome || bet.outcome}」，派彩 ${bet.payout.toLocaleString()} 积分 🎯`
      : `跟系统盘对赌「${bet.eventTitle}」押「${bet.zhOutcome || bet.outcome}」落空，交了学费 📉`,
    ref: bet.id,
  })
  // S16：押注结算进历史 → 该盘口若无其他 pending 押注且未被关注，从钉住集合释放（不再占缓存）。
  if (bet.eventId != null) releasePmIdIfIdle(bet.eventId)
  return bet
}

// 路径①：真实揭晓。盘口已 resolved 时，传入真实获胜结果名 winningOutcome，按真实结果派彩。
// winningOutcome 取自 Polymarket 已结算盘口（见 pmResolvedOutcome）。
export function settlePmBetReal(betId, winningOutcome) {
  if (shouldUseApi()) return null
  const bet = store.pmBets.find((b) => b.id === betId)
  if (!bet) throw new Error('找不到该押注')
  if (bet.status !== 'pending') throw new Error('该押注已结算')
  const iWon = String(winningOutcome) === String(bet.outcome)
  bet.result = winningOutcome
  return applyPmSettle(bet, iWon)
}

// S16 自动真实结算：遍历所有 pending 押注，按盘口 id 单独查 Polymarket 真实结果，
// 已结束(closed)且有获胜结果 → 自动 settlePmBetReal(真实英文 outcome，守恒不变)。
// 未结束 → 保持 pending（继续等，不模拟顶替）。限并发(PM_AUTOSETTLE_BATCH)、单个失败跳过不影响其他。
// 返回实际自动结算的押注数（给 UI 红点/提示）。同一盘多笔 pending 共用一次查询（省请求）。
export async function autoSettlePendingBets() {
  if (shouldUseApi()) return 0
  const pending = store.pmBets.filter((b) => b.status === 'pending' && (b.marketId != null || b.eventId != null))
  if (!pending.length) return 0
  // P1 同盘去重：有 marketId 查 marketId；旧押注无 marketId 时沿用 eventId。
  const settleIdOf = (b) => String(b.marketId != null ? b.marketId : b.eventId)
  const ids = [...new Set(pending.map(settleIdOf))]
  const preferMarketById = new Map(pending.map((b) => [settleIdOf(b), b.marketId != null]))
  const resultById = new Map()
  // 限并发分批查，单个失败按未结束容错（fetchPmResultById 内部已不抛）。
  for (let i = 0; i < ids.length; i += PM_AUTOSETTLE_BATCH) {
    const batch = ids.slice(i, i + PM_AUTOSETTLE_BATCH)
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          return [id, await fetchPmResultById(id, { preferMarket: preferMarketById.get(id) === true })]
        } catch {
          return [id, { closed: false, winningOutcome: null }]
        }
      }),
    )
    results.forEach(([id, r]) => resultById.set(id, r))
  }
  let settled = 0
  // 重新读 pending（结算会改 status；用 id 命中真实结果逐笔判）。
  store.pmBets
    .filter((b) => b.status === 'pending' && (b.marketId != null || b.eventId != null))
    .forEach((b) => {
      const r = resultById.get(settleIdOf(b))
      if (r && r.closed && r.winningOutcome) {
        try {
          settlePmBetReal(b.id, r.winningOutcome) // 真实结果判，守恒不变；内部已 feed 通知 + 释放钉住
          settled += 1
        } catch {
          // 竞态容错：用户在 fetch 等待期手动揭晓了该笔(status已变)→settlePmBetReal throw，
          // 跳过这笔继续结算其余(applyPmSettle 幂等已防重复派彩)。
        }
      }
    })
  return settled
}

// 路径②：模拟揭晓（原型闭环）。按我押中那个结果的市场概率 prob 抛骰子：
//   随机数 < prob → 判我押中；否则判我押错。让押注可立即闭环、可玩。
// ⚠️ 2026-06-11 爹地拍板：「提前揭晓」UI 入口已移除（系统盘只按真实结果揭晓）。
//   本函数现仅守恒单测在用，UI 不可达；二期联机版不实现此路径。
export function settlePmBetSimulated(betId, rnd = Math.random) {
  if (shouldUseApi()) return null
  const bet = store.pmBets.find((b) => b.id === betId)
  if (!bet) throw new Error('找不到该押注')
  if (bet.status !== 'pending') throw new Error('该押注已结算')
  const iWon = rnd() < (bet.prob > 0 ? bet.prob : 0)
  if (!iWon) bet.result = '__other__' // 模拟揭晓为「非我押的边」
  else bet.result = bet.outcome
  return applyPmSettle(bet, iWon)
}
