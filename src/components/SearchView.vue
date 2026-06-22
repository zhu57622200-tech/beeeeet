<script setup>
import { computed, onMounted, ref } from 'vue'
import { store, toggleWatch, isWatched, refreshPmIfStale, pmCachedList, autoSettlePendingBets } from '../store.js'
import { searchMarkets } from '../core/search.js'
import { randomSlogan } from '../core/slogans.js'
import PmCard from './PmCard.vue'

defineOptions({ name: 'SearchView' })

const emptySlogan = randomSlogan()

const emit = defineEmits(['open'])

const q = ref('')
const pmLoading = ref(false)
const pmError = ref('')

const keyword = computed(() => q.value.trim())
const pmEvents = computed(() =>
  pmCachedList().map((ev) => ({
    ...ev,
    enTitle: store.pmCache.byId?.[String(ev.id)]?.enTitle || '',
  })),
)
const watchedPm = computed(() => pmEvents.value.filter((ev) => isWatched('pm', ev.id)))
const watchedMatches = computed(() => store.matches.filter((m) => isWatched('matches', m.id)))
const results = computed(() => searchMarkets({ pmList: pmEvents.value, matches: store.matches, query: q.value }))
const hasResults = computed(() => results.value.pm.length > 0 || results.value.matches.length > 0)
const hasWatchlist = computed(() => watchedPm.value.length > 0 || watchedMatches.value.length > 0)

async function loadPm() {
  // 与 HomeFeed 同款（B1 口径）：进系统盘视图就尝试结算 pending 押注，幂等防重复派彩。
  autoSettlePendingBets().catch(() => {})
  pmLoading.value = true
  pmError.value = ''
  try {
    await refreshPmIfStale()
  } catch (e) {
    if (!pmEvents.value.length) pmError.value = e.message || '加载失败'
  } finally {
    pmLoading.value = false
  }
}

function clearSearch() {
  q.value = ''
}

function openMatch(m) {
  emit('open', 'match', { id: m.id })
}

function handleWatchMatch(e, id) {
  e.stopPropagation()
  toggleWatch('matches', id)
}

function sideLabel(m) {
  return m.ownerSide === 'A' ? m.optionA : m.optionB
}

function statusText(m) {
  const banker = m.mode === 'banker'
  const pool = m.mode === 'pool'
  if (m.status === 'open') return banker ? '坐庄收注' : pool ? '彩池开放' : '待接盘'
  if (m.status === 'matched') return banker ? '坐庄中' : pool ? '彩池中' : '对赌中'
  return '已揭晓'
}

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

onMounted(loadPm)
</script>

<template>
  <div class="search-view">
    <div class="search-head">
      <div class="search-box">
        <svg class="search-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M9.5 3a6.5 6.5 0 0 1 5.17 10.45l4.44 4.44-1.41 1.41-4.44-4.44A6.5 6.5 0 1 1 9.5 3zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/>
        </svg>
        <input v-model="q" class="search-input" placeholder="搜系统盘 / 约赌" />
        <button v-if="q" class="clear-btn" title="清空" @click="clearSearch">✕</button>
      </div>
    </div>

    <div v-if="pmLoading && !pmEvents.length" class="empty">
      <span class="spinner"></span> 正在加载系统盘…
    </div>
    <div v-else-if="pmError" class="empty err">
      加载失败：{{ pmError }}<br />
      <button class="btn ghost" style="margin-top:10px" @click="loadPm">重试</button>
    </div>

    <template v-else-if="!keyword">
      <div v-if="!hasWatchlist" class="empty watch-empty">
        还没有关注的盘<br />
        <span class="faint" style="font-size:12px;margin-top:6px;display:block">去 ☆ 一个盘口，之后会在这里集中查看</span>
      </div>
      <template v-else>
        <div v-if="watchedPm.length > 0" class="section-label">已关注的盘</div>
        <PmCard
          v-for="ev in watchedPm"
          :key="ev.id"
          :ev="ev"
          @open="(t, p) => emit('open', t, p)"
        />

        <div v-if="watchedMatches.length > 0" class="section-label">已关注的约赌</div>
        <div
          v-for="m in watchedMatches"
          :key="m.id"
          class="card match-card"
          @click="openMatch(m)"
        >
          <div class="card-head">
            <div class="title">{{ m.title }}</div>
            <div class="card-head-right">
              <span class="status" :class="m.status">{{ statusText(m) }}</span>
              <button class="star-btn watched" title="取消关注" @click="handleWatchMatch($event, m.id)">★</button>
            </div>
          </div>
          <div class="meta">{{ metaText(m) }}</div>
          <div class="opts">
            <span class="tag">{{ m.optionA }}</span>
            <span class="vs">vs</span>
            <span class="tag">{{ m.optionB }}</span>
          </div>
        </div>
      </template>
    </template>

    <template v-else>
      <div v-if="!hasResults" class="empty">没有找到相关盘口<br /><span class="empty-slogan">{{ emptySlogan }}</span></div>
      <template v-else>
        <div v-if="results.pm.length > 0" class="section-label">系统盘</div>
        <PmCard
          v-for="ev in results.pm"
          :key="ev.id"
          :ev="ev"
          @open="(t, p) => emit('open', t, p)"
        />

        <div v-if="results.matches.length > 0" class="section-label">约赌</div>
        <div
          v-for="m in results.matches"
          :key="m.id"
          class="card match-card"
          @click="openMatch(m)"
        >
          <div class="card-head">
            <div class="title">{{ m.title }}</div>
            <div class="card-head-right">
              <span class="status" :class="m.status">{{ statusText(m) }}</span>
              <button
                class="star-btn"
                :class="{ watched: isWatched('matches', m.id) }"
                :title="isWatched('matches', m.id) ? '取消关注' : '关注'"
                @click="handleWatchMatch($event, m.id)"
              >{{ isWatched('matches', m.id) ? '★' : '☆' }}</button>
            </div>
          </div>
          <div class="meta">{{ metaText(m) }}</div>
          <div class="opts">
            <span class="tag">{{ m.optionA }}</span>
            <span class="vs">vs</span>
            <span class="tag">{{ m.optionB }}</span>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.search-view { min-height: 60vh; }
.search-head {
  position: sticky;
  top: 57px;
  z-index: 9;
  padding: 12px 16px 8px;
  background: rgba(251, 251, 253, 0.82);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--border);
}
.search-box {
  position: relative;
  display: flex;
  align-items: center;
}
.search-ico {
  position: absolute;
  left: 12px;
  width: 18px;
  height: 18px;
  color: var(--text-faint);
  pointer-events: none;
}
.search-input {
  padding-left: 38px;
  padding-right: 38px;
  font-size: 15px;
}
.clear-btn {
  position: absolute;
  right: 8px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--text-faint);
  font-size: 13px;
}
.clear-btn:active { background: var(--bg-card-2); }
.empty {
  text-align: center;
  color: var(--text-dim);
  padding: 40px 20px;
  font-size: 14px;
}
.empty.err { color: var(--red); }
.watch-empty { padding: 60px 20px; }
.section-label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--text-faint);
  padding: 14px 16px 4px;
}
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
.title { font-size: 17px; font-weight: 650; flex: 1; line-height: 1.35; }
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
.opts { display: flex; align-items: center; gap: 8px; }
.vs { font-size: 12px; color: var(--text-faint); }
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
</style>
