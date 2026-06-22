<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { store, toggleWatch, isWatched, refreshPmIfStale, pmCachedList, autoSettlePendingBets } from '../store.js'
import { dailyTopics, isChinaRelated, SUBCAT_MAP } from '../api.js'
import { formatCountdown } from '../core/governance.js'
import { randomSlogan } from '../core/slogans.js'
import CreateMatch from './CreateMatch.vue'
import PmCard from './PmCard.vue'

// 具名以便 App 的 keep-alive include 缓存本组件（返回详情后保留 tab/分类筛选/滚动）。
defineOptions({ name: 'HomeFeed' })

// 空状态轮换 slogan（每次挂载随机抽一句，keep-alive 期间稳定不闪）
const emptySlogan = randomSlogan()

const props = defineProps({
  initTab: {
    type: String,
    default: 'polymarket', // 'polymarket' | 'personal' | 'watchlist'
  },
})
const emit = defineEmits(['open'])

// tab: 'polymarket' | 'personal' | 'watchlist'
const tab = ref(props.initTab)
const showCreate = ref(false)
const createPrefill = ref('') // 从"AI 出题"选中的话题，预填到开盘表单

// —— S6 AI 每日出题 ——
const topics = ref([])
const topicsLoading = ref(false)
const showTopics = ref(false)

async function openTopics() {
  showTopics.value = true
  if (topics.value.length) return // 已有就复用
  topicsLoading.value = true
  try {
    topics.value = await dailyTopics()
  } finally {
    topicsLoading.value = false
  }
}

async function refreshTopics() {
  topicsLoading.value = true
  topics.value = []
  try {
    topics.value = await dailyTopics()
  } finally {
    topicsLoading.value = false
  }
}

// 选一个话题 → 关闭话题层 → 用该题目秒开盘表单。
function pickTopic(t) {
  showTopics.value = false
  createPrefill.value = t
  showCreate.value = true
}

function openCreate() {
  createPrefill.value = ''
  showCreate.value = true
}

// —— S10 个人对赌搜索 / 筛选（§5.15）——
const q = ref('') // 搜索词：按标题 / 对手名
const filterStatus = ref('all') // all | open | matched | settled
const filterMode = ref('all')   // all | match | banker | pool

// 截止倒计时文案（卡片显示）。无截止返回空串。
function countdownText(m) {
  return formatCountdown(m.deadline)
}
function isExpiredOpen(m) {
  return m.status === 'open' && m.deadline && m.deadline <= Date.now()
}

// 过滤后的个人对赌列表：搜索词 + 状态 + 玩法。
const filteredMatches = computed(() => {
  const kw = q.value.trim().toLowerCase()
  return store.matches.filter((m) => {
    if (filterStatus.value === 'all' && (m.status === 'settled' || m.status === 'voided')) return false
    if (filterStatus.value !== 'all' && m.status !== filterStatus.value) return false
    if (filterMode.value !== 'all' && (m.mode || 'match') !== filterMode.value) return false
    if (kw) {
      const hay = `${m.title} ${m.takerName || ''}`.toLowerCase()
      if (!hay.includes(kw)) return false
    }
    return true
  })
})

const STATUS_FILTERS = [
  { k: 'all', label: '全部' },
  { k: 'open', label: '待接盘' },
  { k: 'matched', label: '对赌中' },
  { k: 'settled', label: '已揭晓' },
]
const MODE_FILTERS = [
  { k: 'all', label: '全部玩法' },
  { k: 'match', label: '约赌' },
  { k: 'banker', label: '坐庄' },
  { k: 'pool', label: '彩池' },
]

// 系统盘数据：响应式读缓存。后台 pmUpdateNow 写入新盘 / retranslate 翻译会自动刷新列表，
// 用户无需手动刷新页面（修「首次进数据后台拉、列表不更新」副作用）。
const pmEvents = computed(() => pmCachedList())
const pmLoading = ref(false)
const pmError = ref('')
let pmLoaded = false

// 分类标签栏：全部 + ⚽世界杯专项（世界杯期间突出，按 subcat 筛）+ 六类。
const CATEGORIES = ['全部', '⚽世界杯', '🇺🇸特朗普', '体育', '加密', '国际', '财经', '科技', '文化', '其他']
const activeCat = ref('全部')

// —— ⚽世界杯专题（模拟 Polymarket 世界杯专区）——
// 比赛 tab：kind='wcgame' 聚合卡按日期分组；玩法 tab：远期/玩法盘按 wcSubcat 侧拉筛。
const wcTab = ref('games')
const wcPlaySubcat = ref('全部')
// 与 api.js WC_SUBCATS 对齐（数据层产出 wcSubcat 字段）
const WC_SUBCAT_LIST = ['全部', '奖项', '球员对决', '小组远期', '淘汰阶段', '球队玩法', '球员远期', '洲际远期', '赛事远期', '文化', '其他玩法']
const wcGames = computed(() =>
  pmEvents.value
    .filter((ev) => ev.kind === 'wcgame')
    .sort((a, b) => (a.gameStart || 0) - (b.gameStart || 0))
)
const wcGameDays = computed(() => {
  const byDay = new Map()
  for (const g of wcGames.value) {
    const d = g.gameDate || '待定'
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push(g)
  }
  return [...byDay.entries()].map(([date, games]) => ({
    date,
    label: wcDayLabel(date),
    games,
  }))
})
function wcDayLabel(date) {
  if (date === '待定') return '日期待定'
  const [, m, d] = date.split('-')
  return `${Number(m)}月${Number(d)}日`
}
const wcPlayEvents = computed(() => {
  let list = pmEvents.value.filter((ev) => ev.subcat === '世界杯' && ev.kind !== 'wcgame')
  if (wcPlaySubcat.value !== '全部') {
    list = list.filter((ev) => (ev.wcSubcat || '其他玩法') === wcPlaySubcat.value)
  }
  return list.sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0))
})
const PM_PAGE_SIZE = 24
const pmVisibleCount = ref(PM_PAGE_SIZE)
const wcPlayVisibleCount = ref(PM_PAGE_SIZE)
const activeSubcat = ref('') // P2 当前二级分类（''=该一级全部）
const drawerCat = ref(null) // P2 侧拉抽屉当前展开的一级（null=关闭）
// 'cat' 排序按真实 category 分组（不含「全部」「⚽世界杯」专项）。
const SORT_CAT_ORDER = ['体育', '加密', '国际', '财经', '科技', '文化', '其他']

// P2 某一级有哪些二级（无则点它直接筛一级）。
function subsOf(cat) {
  return SUBCAT_MAP[cat] || []
}
// 点一级 chip：「全部」「⚽世界杯」直接筛；有二级的弹侧拉抽屉；无二级的直接筛一级。
function pickCat(c) {
  if (c === '全部' || c === '⚽世界杯' || c === '🇺🇸特朗普') {
    activeCat.value = c
    activeSubcat.value = ''
    drawerCat.value = null
    return
  }
  if (subsOf(c).length) {
    drawerCat.value = c // 弹抽屉选二级，不立即切
  } else {
    activeCat.value = c
    activeSubcat.value = ''
  }
}
// 抽屉里选二级（'全部'=该一级不细分）。
function pickSubcat(s) {
  activeCat.value = drawerCat.value
  activeSubcat.value = s === '全部' ? '' : s
  drawerCat.value = null
}
// 清除二级，回到该一级全部。
function clearSubcat() {
  activeSubcat.value = ''
}

// 排序（S15）：突发热点(volume高) / 最新(createdAt新) / 分类(按 category 分组)。
const SORTS = [
  { k: 'hot', label: '突发热点' },
  { k: 'new', label: '最新' },
  { k: 'cat', label: '分类' },
]
const activeSort = ref('hot')

async function loadPm() {
  // B1 修复：每次进系统盘都尝试结算 pending 押注——盘后来才判定、或切走再回来，都能结算，
  //   不再被下面列表懒加载的 early-return 一起跳过。无 pending 时内部即时返回、近零开销；
  //   查询走 /pm（nginx 10min 缓存兜底），不会狂打 Polymarket；守恒不变，applyPmSettle 幂等防重复派彩。
  autoSettlePendingBets().catch(() => {})
  if (pmLoaded && pmEvents.value.length) return
  pmLoading.value = true
  pmError.value = ''
  try {
    // 触发拉取（后台 fire-and-forget）；pmEvents 是响应式 computed，缓存写入/翻译会自动刷新列表。
    await refreshPmIfStale()
    pmLoaded = true
  } catch (e) {
    // 拉取失败且缓存为空才报错（有缓存则 computed 已显示）。
    if (!pmEvents.value.length) pmError.value = e.message || '加载失败'
  } finally {
    pmLoading.value = false
  }
}

// 当前分类 + 排序后的系统盘列表。
// 中国题材排序加权（爹地2026-06-08：中国相关信息增加比重、多露出）。热度×CHINA_BOOST 排靠前。
const CHINA_BOOST = 2.5
const effVol = (ev) => (ev.volume24hr || 0) * (isChinaRelated(ev) ? CHINA_BOOST : 1)
const shownPmEvents = computed(() => {
  // wcgame 单场卡只在世界杯专题「比赛」tab 展示，不混进常规平铺列表（72+ 场会淹没其他盘）
  let list = pmEvents.value.filter((ev) => ev.kind !== 'wcgame')
  if (activeCat.value === '⚽世界杯') {
    list = list.filter((ev) => ev.subcat === '世界杯') // 世界杯专项：按二级分类筛
  } else if (activeCat.value === '🇺🇸特朗普') {
    list = list.filter((ev) => ev.subcat === '特朗普') // 特朗普专项：按二级分类筛
  } else if (activeCat.value !== '全部') {
    list = list.filter((ev) => ev.category === activeCat.value)
    if (activeSubcat.value) list = list.filter((ev) => ev.subcat === activeSubcat.value) // P2 二级筛
  }
  if (activeSort.value === 'hot') {
    list.sort((a, b) => effVol(b) - effVol(a)) // 中国题材加权靠前
  } else if (activeSort.value === 'new') {
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  } else if (activeSort.value === 'cat') {
    // 按分类分组（同组内热度降序，中国题材组内加权靠前）。
    const order = SORT_CAT_ORDER
    list.sort((a, b) => {
      const ca = order.indexOf(a.category)
      const cb = order.indexOf(b.category)
      if (ca !== cb) return ca - cb
      return effVol(b) - effVol(a)
    })
  }
  return list
})
const visiblePmEvents = computed(() => shownPmEvents.value.slice(0, pmVisibleCount.value))
const visibleWcPlayEvents = computed(() => wcPlayEvents.value.slice(0, wcPlayVisibleCount.value))

watch([activeCat, activeSubcat, activeSort], () => {
  pmVisibleCount.value = PM_PAGE_SIZE
})
watch([wcPlaySubcat, wcTab], () => {
  wcPlayVisibleCount.value = PM_PAGE_SIZE
})

function showMorePm() {
  pmVisibleCount.value += PM_PAGE_SIZE
}

function showMoreWcPlays() {
  wcPlayVisibleCount.value += PM_PAGE_SIZE
}

function switchTab(t) {
  tab.value = t
  if (t === 'polymarket' || t === 'watchlist') loadPm()
}

// 关注盘列表（我的关注 tab 用）
const watchedMatches = computed(() =>
  store.matches.filter((m) => isWatched('matches', m.id))
)
const watchedPm = computed(() =>
  pmEvents.value.filter((ev) => isWatched('pm', ev.id))
)

function sideLabel(m) {
  return m.ownerSide === 'A' ? m.optionA : m.optionB
}
function oppSideLabel(m) {
  return m.ownerSide === 'A' ? m.optionB : m.optionA
}

function statusText(m) {
  const banker = m.mode === 'banker'
  const pool = m.mode === 'pool'
  if (m.status === 'open') return banker ? '坐庄收注' : pool ? '彩池开放' : '待接盘'
  if (m.status === 'matched') return banker ? '坐庄中' : pool ? '彩池中' : '对赌中'
  return '已揭晓'
}

// 列表卡片副标题（三玩法各异）。
function metaText(m) {
  if (m.mode === 'banker') {
    return `我坐庄 · 赔率 ${m.bankerOdds} · 保证金 ${(m.bankerCap || 0).toLocaleString()}`
  }
  if (m.mode === 'pool') {
    const a = (m.pool?.A || []).reduce((s, b) => s + b.stake, 0)
    const b = (m.pool?.B || []).reduce((s, x) => s + x.stake, 0)
    return `彩池 · 我押 ${sideLabel(m)} · 总池 ${(a + b).toLocaleString()}`
  }
  return `我押 ${sideLabel(m)} · 赔率 ${m.odds} · 下注 ${(m.ownerStake || 0).toLocaleString()}`
}

// 已结算卡片：我这局是否赢（三玩法统一）。
function cardWon(m) {
  if (m.mode === 'banker') return (m.bankerPnl || 0) >= 0
  if (m.mode === 'pool') {
    const myBets = [...(m.pool?.A || []), ...(m.pool?.B || [])].filter((b) => !b.npc)
    const stake = myBets.reduce((s, b) => s + b.stake, 0)
    const payout = myBets.reduce((s, b) => s + (b.payout || 0), 0)
    return payout >= stake
  }
  return m.result === m.ownerSide
}

// 收藏按钮点击：阻止冒泡（不触发进详情）
function handleWatchMatch(e, id) {
  e.stopPropagation()
  toggleWatch('matches', id)
}

onMounted(() => {
  // polymarket 或 watchlist 都需要 PM 数据
  if (tab.value === 'polymarket' || tab.value === 'watchlist') {
    loadPm()
  }
})
</script>

<template>
  <div>
    <!-- 顶部三类切换 -->
    <div class="seg">
      <button :class="{ on: tab === 'polymarket' }" @click="switchTab('polymarket')">系统盘</button>
      <button :class="{ on: tab === 'personal' }" @click="switchTab('personal')">个人对赌</button>
      <button :class="{ on: tab === 'watchlist' }" @click="switchTab('watchlist')">我的关注</button>
    </div>

    <!-- 系统盘 -->
    <div v-if="tab === 'polymarket'">
      <div v-if="pmLoading" class="empty"><span class="spinner"></span> 正在加载系统盘…</div>
      <div v-else-if="pmError" class="empty err">
        加载失败：{{ pmError }}<br />
        <button class="btn ghost" style="margin-top:10px" @click="loadPm">重试</button>
      </div>
      <template v-else>
        <!-- 分类标签栏（一级，自动换行；有二级的点开侧拉抽屉） -->
        <div class="cat-bar">
          <button
            v-for="c in CATEGORIES"
            :key="c"
            class="cat-chip"
            :class="{ on: activeCat === c, wc: c === '⚽世界杯', trump: c === '🇺🇸特朗普' }"
            @click="pickCat(c)"
          >{{ c }}<span v-if="subsOf(c).length" class="chip-caret">▾</span></button>
        </div>
        <!-- 当前二级分类标签（可清除回该一级全部） -->
        <div v-if="activeSubcat" class="subcat-tag">
          <span class="subcat-cur">{{ activeCat }} › {{ activeSubcat }}</span>
          <button class="subcat-x" @click="clearSubcat">✕</button>
        </div>
        <!-- ⚽世界杯专题模式：比赛/玩法 双 tab（模拟 Polymarket 世界杯专区）-->
        <template v-if="activeCat === '⚽世界杯'">
          <div class="sort-bar wc-tabs">
            <button class="sort-chip" :class="{ on: wcTab === 'games' }" @click="wcTab = 'games'">比赛</button>
            <button class="sort-chip" :class="{ on: wcTab === 'plays' }" @click="wcTab = 'plays'">玩法</button>
          </div>

          <!-- 比赛 tab：按日期分组的单场赛程 -->
          <template v-if="wcTab === 'games'">
            <div v-if="wcGameDays.length === 0" class="empty">
              赛程盘还没就位 🍃<br />
              <span class="faint" style="font-size:12px">世界杯单场盘随 Polymarket 挂盘自动上架</span>
            </div>
            <template v-for="day in wcGameDays" :key="day.date">
              <div class="wc-day">{{ day.label }}</div>
              <div
                v-for="g in day.games"
                :key="g.id"
                class="card wc-game-card"
                @click="emit('open', 'pm', { event: g })"
              >
                <div class="wc-teams">
                  <span class="wc-team">{{ g.zhTitle || g.enTitle }}</span>
                </div>
                <div class="wc-ml-row">
                  <span v-for="o in (g.groups?.moneyline || [])" :key="o.marketId" class="wc-ml">
                    <i class="wc-ml-name">{{ o.zhName }}</i>
                    <b class="wc-ml-price">{{ Math.round((o.prob || 0) * 100) }}¢</b>
                  </span>
                </div>
              </div>
            </template>
          </template>

          <!-- 玩法 tab：侧拉分类（奖项/球员对决/小组远期/淘汰阶段/…）-->
          <template v-else>
            <div class="cat-bar wc-sub-bar">
              <button
                v-for="s in WC_SUBCAT_LIST"
                :key="s"
                class="cat-chip"
                :class="{ on: wcPlaySubcat === s }"
                @click="wcPlaySubcat = s"
              >{{ s }}</button>
            </div>
            <div v-if="wcPlayEvents.length === 0" class="empty">
              这个分类暂时没有盘 🍃
            </div>
            <PmCard
              v-for="ev in visibleWcPlayEvents"
              :key="ev.id"
              :ev="ev"
              @open="(t, p) => emit('open', t, p)"
            />
            <button
              v-if="visibleWcPlayEvents.length < wcPlayEvents.length"
              class="btn ghost block load-more"
              @click="showMoreWcPlays"
            >
              加载更多（{{ visibleWcPlayEvents.length }}/{{ wcPlayEvents.length }}）
            </button>
          </template>
        </template>

        <!-- 常规模式：排序 + 平铺列表 -->
        <template v-else>
        <!-- 排序切换 -->
        <div class="sort-bar">
          <button
            v-for="s in SORTS"
            :key="s.k"
            class="sort-chip"
            :class="{ on: activeSort === s.k }"
            @click="activeSort = s.k"
          >{{ s.label }}</button>
        </div>

        <div v-if="shownPmEvents.length === 0" class="empty">
          暂无可玩盘口 🍃<br />
          <span class="faint" style="font-size:12px">敏感题材与已结束的死盘已自动过滤</span><br />
          <span class="empty-slogan">{{ emptySlogan }}</span>
        </div>
        <PmCard
          v-for="ev in visiblePmEvents"
          :key="ev.id"
          :ev="ev"
          @open="(t, p) => emit('open', t, p)"
        />
        <button
          v-if="visiblePmEvents.length < shownPmEvents.length"
          class="btn ghost block load-more"
          @click="showMorePm"
        >
          加载更多（{{ visiblePmEvents.length }}/{{ shownPmEvents.length }}）
        </button>
        </template>
      </template>
    </div>

    <!-- 个人对赌 -->
    <div v-else-if="tab === 'personal'">
      <div class="personal-actions">
        <button class="btn create-btn" @click="openCreate">+ 开一个赌局</button>
        <button class="btn ghost topic-btn" @click="openTopics">🎲 AI 出今日话题</button>
      </div>

      <!-- S10 搜索 + 筛选 -->
      <div v-if="store.matches.length > 0" class="filters">
        <input v-model="q" class="search-input" placeholder="🔍 搜标题 / 对手名" />
        <div class="filter-row">
          <button
            v-for="f in STATUS_FILTERS"
            :key="f.k"
            class="chip"
            :class="{ on: filterStatus === f.k }"
            @click="filterStatus = f.k"
          >{{ f.label }}</button>
        </div>
        <div class="filter-row">
          <button
            v-for="f in MODE_FILTERS"
            :key="f.k"
            class="chip"
            :class="{ on: filterMode === f.k }"
            @click="filterMode = f.k"
          >{{ f.label }}</button>
        </div>
      </div>

      <div v-if="store.matches.length === 0" class="empty">
        还没有赌局，点上面开一个吧。<br />
        <span class="empty-slogan">{{ emptySlogan }}</span>
      </div>
      <div v-else-if="filteredMatches.length === 0" class="empty">
        没有匹配的赌局 🍃<br />
        <span class="faint" style="font-size:12px">换个搜索词或筛选条件试试</span>
      </div>

      <div
        v-for="m in filteredMatches"
        :key="m.id"
        class="card match-card"
        @click="emit('open', 'match', { id: m.id })"
      >
        <div class="card-head">
          <div class="title">{{ m.title }}</div>
          <div class="card-head-right">
            <span class="status" :class="m.status">{{ statusText(m) }}</span>
            <button
              class="star-btn"
              :class="{ watched: isWatched('matches', m.id) }"
              @click="handleWatchMatch($event, m.id)"
              :title="isWatched('matches', m.id) ? '取消关注' : '关注'"
            >{{ isWatched('matches', m.id) ? '★' : '☆' }}</button>
          </div>
        </div>
        <div class="meta">{{ metaText(m) }}</div>
        <div v-if="m.deadline && m.status !== 'settled'" class="countdown" :class="{ expired: isExpiredOpen(m) }">
          ⏰ {{ countdownText(m) }}<span v-if="isExpiredOpen(m)"> · 进入即自动作废退回</span>
        </div>
        <div class="opts">
          <span class="tag">{{ m.optionA }}</span>
          <span class="vs">vs</span>
          <span class="tag">{{ m.optionB }}</span>
        </div>
        <div v-if="m.mode === 'match' && m.takerJoined && m.status !== 'settled'" class="opp">
          ⚔️ {{ m.takerEmoji }} {{ m.takerName }} 接了 · 押 {{ oppSideLabel(m) }}
        </div>
        <div v-if="m.status === 'settled'" class="result" :class="{ lose: !cardWon(m) }">
          结果：{{ m.result === 'A' ? m.optionA : m.optionB }} ·
          {{ cardWon(m) ? '我赢 🎉' : '我输 💀' }}
        </div>
      </div>
    </div>

    <!-- 我的关注 -->
    <div v-else-if="tab === 'watchlist'">
      <div v-if="watchedMatches.length === 0 && watchedPm.length === 0" class="empty watch-empty">
        还没有关注的盘<br />
        <span class="faint" style="font-size:12px;margin-top:6px;display:block">去 ☆ 一个盘口试试</span>
      </div>
      <template v-else>
        <!-- 收藏的个人对赌 -->
        <div v-if="watchedMatches.length > 0" class="section-label">个人对赌</div>
        <div
          v-for="m in watchedMatches"
          :key="m.id"
          class="card match-card"
          @click="emit('open', 'match', { id: m.id })"
        >
          <div class="card-head">
            <div class="title">{{ m.title }}</div>
            <div class="card-head-right">
              <span class="status" :class="m.status">{{ statusText(m) }}</span>
              <button
                class="star-btn watched"
                @click="handleWatchMatch($event, m.id)"
                title="取消关注"
              >★</button>
            </div>
          </div>
          <div class="meta">{{ metaText(m) }}</div>
          <div class="opts">
            <span class="tag">{{ m.optionA }}</span>
            <span class="vs">vs</span>
            <span class="tag">{{ m.optionB }}</span>
          </div>
        </div>

        <!-- 收藏的系统盘 -->
        <div v-if="watchedPm.length > 0" class="section-label">系统盘</div>
        <PmCard
          v-for="ev in watchedPm"
          :key="ev.id"
          :ev="ev"
          @open="(t, p) => emit('open', t, p)"
        />
      </template>
    </div>

    <CreateMatch v-if="showCreate" :prefill-title="createPrefill" @close="showCreate = false" />

    <!-- P2 二级分类侧拉抽屉 -->
    <div v-if="drawerCat" class="drawer-mask" @click.self="drawerCat = null">
      <div class="drawer">
        <div class="drawer-hd">
          <span>{{ drawerCat }} · 选个细分</span>
          <button class="x" @click="drawerCat = null">✕</button>
        </div>
        <button
          class="drawer-item"
          :class="{ on: activeCat === drawerCat && !activeSubcat }"
          @click="pickSubcat('全部')"
        >全部{{ drawerCat }}</button>
        <button
          v-for="s in subsOf(drawerCat)"
          :key="s"
          class="drawer-item"
          :class="{ on: activeCat === drawerCat && activeSubcat === s }"
          @click="pickSubcat(s)"
        >{{ s }}</button>
      </div>
    </div>

    <!-- AI 每日出题选择层 -->
    <div v-if="showTopics" class="topic-mask" @click.self="showTopics = false">
      <div class="topic-sheet">
        <div class="topic-hd">
          <span>🎲 AI 今日话题</span>
          <button class="x" @click="showTopics = false">✕</button>
        </div>
        <div v-if="topicsLoading" class="topic-loading">
          <span class="spinner"></span> AI 正在出题…
        </div>
        <template v-else>
          <p class="topic-tip faint">挑一个秒开盘，AI 会帮你把题目锻造清楚。</p>
          <button
            v-for="(t, i) in topics"
            :key="i"
            class="topic-item"
            @click="pickTopic(t)"
          >{{ t }}</button>
          <button class="btn ghost block" style="margin-top:10px" @click="refreshTopics">换一批 🔄</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seg {
  display: flex;
  gap: 0;
  padding: 12px 16px 4px;
  background: rgba(251, 251, 253, 0.72);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}
.seg button {
  flex: 1;
  padding: 9px 4px;
  border-radius: 0;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-dim);
  font-weight: 600;
  font-size: 14px;
  transition: color .15s, border-color .15s;
}
.seg button.on {
  color: var(--blue);
  border-bottom-color: var(--blue);
}

.personal-actions {
  display: flex;
  gap: 10px;
  margin: 12px 16px;
}
.create-btn { flex: 1; }
.topic-btn { flex: 0 0 auto; white-space: nowrap; }

/* AI 出题选择层 */
.topic-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(15, 35, 48, 0.34);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.topic-sheet {
  width: 100%;
  max-width: 480px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  padding: 16px 16px 28px;
  max-height: 80vh;
  overflow-y: auto;
  box-shadow: 0 -18px 48px rgba(15, 23, 42, 0.14);
}
.topic-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 10px;
}
.topic-hd .x { color: var(--text-dim); font-size: 16px; }
.topic-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  padding: 24px 4px;
  font-size: 14px;
}
.topic-tip { font-size: 12px; margin-bottom: 10px; }
.topic-item {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  transition: border-color .15s, background .15s;
}
.topic-item:active { border-color: var(--blue); background: rgba(93, 220, 213, 0.13); }

.empty {
  text-align: center;
  color: var(--text-dim);
  padding: 40px 20px;
  font-size: 14px;
}
.empty.err { color: var(--red); }
.watch-empty { padding: 60px 20px; }
.load-more {
  margin: 10px 16px 18px;
  width: calc(100% - 32px);
}

.section-label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-faint);
  padding: 14px 16px 4px;
}

/* 收藏星按钮 */
.star-btn {
  font-size: 18px;
  color: var(--text-faint);
  line-height: 1;
  padding: 2px 4px;
  flex: 0 0 auto;
  transition: color .15s, transform .15s;
}
.star-btn:active { transform: scale(1.3); }
.star-btn.watched { color: #f0b429; }

.match-card { cursor: pointer; }
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.card-head-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.title { font-size: 17px; font-weight: 650; flex: 1; }
.status {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 6px;
  flex: 0 0 auto;
}
.status.open { background: var(--blue-dim); color: var(--blue); }
.status.matched { background: var(--amber-bg); color: var(--amber); }
.status.settled { background: var(--green-bg); color: var(--green); }
.meta { font-size: 13px; color: var(--text-dim); margin: 8px 0; }
.countdown { font-size: 13px; color: var(--amber); margin: -2px 0 8px; }
.countdown.expired { color: var(--red); }
.opts { display: flex; align-items: center; gap: 8px; }

/* S10 搜索 + 筛选 */
.filters { padding: 0 16px 4px; }
.search-input {
  width: 100%;
  margin-bottom: 8px;
  font-size: 14px;
}
.filter-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.chip {
  padding: 5px 12px;
  border-radius: 14px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 600;
}
.chip.on { background: var(--brand-gradient); color: #fff; border-color: var(--blue); }
.vs { font-size: 12px; color: var(--text-faint); }
.opp { margin-top: 8px; font-size: 13px; color: var(--amber); }
.result { margin-top: 8px; font-size: 14px; color: var(--green); }
.result.lose { color: var(--red); }

/* S15 分类标签栏（自动换行）+ 排序切换 */
.cat-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  row-gap: 8px;
  overflow: visible;
  padding: 10px 12px 6px;
}
.cat-chip {
  flex: 0 0 auto;
  padding: 5px 10px;
  border-radius: 14px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.cat-chip.on { background: var(--brand-gradient); color: #fff; border-color: var(--blue); }
/* ⚽世界杯专项：绿色突出（世界杯期间） */
.cat-chip.wc { border-color: var(--green); color: var(--green); font-weight: 700; }
.cat-chip.wc.on { background: var(--green); color: #fff; border-color: var(--green); }
/* 🇺🇸特朗普专项：红色突出 */
.cat-chip.trump { border-color: var(--red); color: var(--red); font-weight: 700; }
.cat-chip.trump.on { background: var(--red); color: #fff; border-color: var(--red); }
.sort-bar {
  display: flex;
  gap: 14px;
  padding: 6px 16px 8px;
}
.sort-chip {
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 600;
  padding: 2px 0;
}
.sort-chip.on { color: var(--blue); }

/* P2 一级 chip 二级指示符 + 当前二级标签 */
.chip-caret { font-size: 9px; margin-left: 3px; opacity: 0.65; }
.subcat-tag { display: flex; align-items: center; gap: 8px; padding: 4px 16px 0; }
.subcat-cur { font-size: 13px; font-weight: 700; color: var(--blue); }
.subcat-x {
  font-size: 11px;
  color: var(--text-faint);
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 10px;
  line-height: 1.6;
}

/* P2 二级分类侧拉抽屉（从左滑入） */
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 55;
  background: rgba(15, 35, 48, 0.34);
  backdrop-filter: blur(8px);
  display: flex;
}
.drawer {
  width: 72%;
  max-width: 290px;
  height: 100%;
  background: var(--bg-card);
  border-right: 1px solid var(--border);
  padding: 18px 14px;
  overflow-y: auto;
  box-shadow: 8px 0 36px rgba(15, 23, 42, 0.2);
  animation: drawerIn 0.22s ease;
}
@keyframes drawerIn {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}
.drawer-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 14px;
}
.drawer-hd .x { color: var(--text-dim); font-size: 15px; }
.drawer-item {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 11px 14px;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  transition: border-color 0.15s, background 0.15s;
}
.drawer-item:active { border-color: var(--blue); }
.drawer-item.on { background: var(--brand-gradient); color: #fff; border-color: var(--blue); }
.empty-slogan {
  display: inline-block;
  margin-top: 10px;
  font-size: 12px;
  font-weight: 700;
  background: var(--brand-text-gradient);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

/* —— ⚽世界杯专题 —— */
.wc-day {
  margin: 14px 2px 6px;
  font-size: 13px;
  font-weight: 700;
  color: var(--ink-2, #667);
  letter-spacing: 0.5px;
}
.wc-game-card { cursor: pointer; padding: 12px 14px; }
.wc-teams { font-size: 15px; font-weight: 700; margin-bottom: 8px; }
.wc-ml-row { display: flex; gap: 8px; }
.wc-ml {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 4px;
  border-radius: 10px;
  background: rgba(120, 130, 160, 0.08);
}
.wc-ml-name { font-style: normal; font-size: 11px; color: var(--ink-2, #667); white-space: nowrap; overflow: hidden; max-width: 100%; text-overflow: ellipsis; }
.wc-ml-price { font-size: 14px; font-variant-numeric: tabular-nums; }
.wc-sub-bar { margin-top: 2px; }
</style>
