<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { store, isLoggedIn, me, unreadCount, unreadFeed, markSeen, canClaimWeeklySupply, expireStaleMatches, finishOnboarding } from './store.js'
import { countUp, prefersReducedMotion } from './core/countup.js'
import HomeFeed from './components/HomeFeed.vue'
import SearchView from './components/SearchView.vue'
import MatchDetail from './components/MatchDetail.vue'
import PmDetail from './components/PmDetail.vue'
import MyAssets from './components/MyAssets.vue'
import Login from './components/Login.vue'
import CreateMatch from './components/CreateMatch.vue'
import FeedView from './components/FeedView.vue'
import Leaderboard from './components/Leaderboard.vue'
import InviteFriends from './components/InviteFriends.vue'
import FriendsView from './components/FriendsView.vue'

// 登录态：未登录(未设昵称+密码)先走登录引导。bump 用于登录成功后强制重算。
const authBump = ref(0)
const loggedIn = computed(() => (authBump.value, isLoggedIn()))
function onLoggedIn() {
  authBump.value++
  go('home')
  checkOnboarding() // 首登展示新用户引导
}

// —— S10 异常状态机：进 App 扫一遍到期无人接的盘，自动作废退回（§5.13）——
const expiredNotice = ref(0) // 本次进 App 自动作废的局数（>0 弹提示）
function runExpiry() {
  const n = expireStaleMatches()
  if (n > 0) expiredNotice.value = n
}

// —— S10 新用户引导（§5.15）：首次登录后展示一次，可跳过 ——
const showOnboard = ref(false)
const onboardStep = ref(0)
const ONBOARD_STEPS = [
  { icon: '🎲', title: '开盘对赌', text: '点底部「+ 新建」用大白话出题，AI 帮你把"怎么算赢"锻造清楚，设赔率/玩法/截止就能开盘。' },
  { icon: '📈', title: '系统盘', text: '主页「系统盘」汇集热门事件的市场参考概率，用虚拟积分跟着大盘押注，练出自己的认知水位。' },
  { icon: '🏆', title: '排行榜', text: '顶部奖杯进排行榜：身家榜 / 连胜榜 / 老赖榜，熟人圈里见真章。' },
  { icon: '🫵', title: '我的', text: '底部「我的」看战绩、账本、领周补给、转赠积分。积分永不可兑现，纯虚拟娱乐。' },
]
function checkOnboarding() {
  if (!store.onboarded) {
    onboardStep.value = 0
    showOnboard.value = true
  }
}
function nextOnboard() {
  if (onboardStep.value < ONBOARD_STEPS.length - 1) onboardStep.value++
  else closeOnboard()
}
function closeOnboard() {
  showOnboard.value = false
  finishOnboarding()
}

// 极简路由：route = { name, params }
// name: home | match | pm | search | friends | invite | profile
const route = ref({ name: 'home', params: {} })
const detailFrom = ref('home') // 进详情前的来源 tab(home/search)，返回时回到它
function go(name, params = {}) {
  route.value = { name, params }
  window.scrollTo(0, 0)
}

// 底栏当前激活的主tab（用于高亮）
const activeTab = computed(() => {
  const n = route.value.name
  if (n === 'match' || n === 'pm') return detailFrom.value // 详情高亮跟随来源
  if (n === 'home') return 'home'
  if (n === 'search') return 'search'
  if (n === 'friends') return 'friends'
  if (n === 'invite') return 'friends'
  if (n === 'profile') return 'profile'
  if (n === 'feed') return 'feed' // 动态是顶栏入口，不高亮任何底部 tab
  if (n === 'rank') return 'rank' // 排行榜也是顶栏入口，不高亮底部 tab
  return 'home'
})

// 积分胶囊：余额变动时数字滚动跳到新值 + 涨绿跌红闪一下（RAF 一次性，播完即停）。
const shownBalance = ref(store.balance)
const balFlash = ref('') // '' | 'up' | 'down'
let cancelBalCount = null
let balFlashTimer = 0
watch(() => store.balance, (nv, ov) => {
  if (nv === ov) return
  cancelBalCount?.()
  clearTimeout(balFlashTimer)
  if (prefersReducedMotion()) { balFlash.value = ''; shownBalance.value = nv; return }
  balFlash.value = nv > ov ? 'up' : 'down'
  balFlashTimer = setTimeout(() => { balFlash.value = '' }, 900)
  cancelBalCount = countUp(shownBalance.value, nv, 600, (v) => { shownBalance.value = v })
})
onUnmounted(() => {
  cancelBalCount?.()
  clearTimeout(balFlashTimer)
})
const balanceText = computed(() => shownBalance.value.toLocaleString('en-US'))
const meName = computed(() => (authBump.value, me()?.name || ''))

// S9：本周补给可领时，余额药丸上挂个小红点引导去账号页领取（§5.11）。
const supplyReady = computed(() => (authBump.value, store.lastSupplyAt, canClaimWeeklySupply()))

// 新建盘 sheet（FAB 点击，不切 tab）
const showCreate = ref(false)

// HomeFeed 的打开事件：go(name, params)
function onFeedOpen(name, params) {
  if (name === 'match' || name === 'pm') detailFrom.value = route.value.name // 记住从哪个tab进的详情
  go(name, params)
}

// —— S4 通知红点 + 动态流入口 ——
// 进 App / 每次重渲都重算未读（feed 变动会触发，因为 unreadCount 读 store.feed）。
const unread = computed(() => (authBump.value, unreadCount()))
const unreadText = computed(() => (unread.value > 99 ? '99+' : String(unread.value)))

// 通知摘要弹层（"你不在时发生了什么"）
const showNotif = ref(false)
const notifList = ref([])
function openNotif() {
  notifList.value = unreadFeed() // 快照本次未读，弹层里看完再清
  showNotif.value = true
}
function closeNotif() {
  showNotif.value = false
  markSeen() // 看完清红点
}
function notifGo(ev) {
  closeNotif()
  if (ev.ref && store.matches.some((m) => m.id === ev.ref)) {
    detailFrom.value = route.value.name === 'feed' ? 'home' : route.value.name
    go('match', { id: ev.ref })
  }
}
function notifAgo(ts) {
  const min = Math.floor((Date.now() - ts) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  return `${Math.floor(hr / 24)}天前`
}

// 进 App：已登录则扫过期盘 + 首登引导（登录后由 onLoggedIn 触发，这里覆盖"已登录直接进"）。
onMounted(() => {
  if (isLoggedIn()) {
    runExpiry()
    checkOnboarding()
  }
})

// 动态流入口：进入 feed 页前记录来源（feed 的详情返回回 home）。
function openFeed() {
  go('feed')
}
function onFeedViewOpen(name, params) {
  detailFrom.value = 'home' // 从动态进详情，返回回主页
  go(name, params)
}
</script>

<template>
  <Login v-if="!loggedIn" @done="onLoggedIn" />
  <div v-else class="app-root">
    <header class="topbar">
      <div class="brand" aria-label="beeeeet 買定離手">
        <span class="brand-en">beeeeet</span>
        <span class="brand-cn">買定離手</span>
      </div>
      <div class="top-right">
        <!-- 排行榜入口 -->
        <button class="icon-btn" :class="{ active: route.name === 'rank' }" @click="go('rank')" title="排行榜">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M5 16h3v5H5zm5.5-6h3v11h-3zM16 3h3v18h-3z"/>
          </svg>
        </button>
        <!-- 动态流入口 -->
        <button class="icon-btn" :class="{ active: route.name === 'feed' }" @click="openFeed" title="动态">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M4 5h16v2H4zm0 6h16v2H4zm0 6h10v2H4z"/>
          </svg>
        </button>
        <!-- 通知铃铛 + 红点 -->
        <button class="icon-btn bell" @click="openNotif" title="通知">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1z"/>
          </svg>
          <span v-if="unread > 0" class="badge">{{ unreadText }}</span>
        </button>
        <div class="bal" :class="{ 'has-supply': supplyReady, 'flash-up': balFlash === 'up', 'flash-down': balFlash === 'down' }" @click="go('profile')" :title="supplyReady ? '本周补给可领' : ''">
          <span class="bal-num">{{ balanceText }}</span>
          <span class="bal-unit">积分</span>
          <span v-if="supplyReady" class="supply-dot" title="本周补给可领">🎁</span>
        </div>
      </div>
    </header>

    <main>
      <!-- keep-alive 缓存主页、搜索与朋友页：进详情返回后保留筛选/二级状态。 -->
      <keep-alive :include="['HomeFeed', 'SearchView', 'FriendsView']">
        <HomeFeed v-if="route.name === 'home'" key="feed-home" init-tab="polymarket" @open="onFeedOpen" />
        <SearchView v-else-if="route.name === 'search'" @open="onFeedOpen" />
        <FriendsView
          v-else-if="route.name === 'friends'"
          @open="onFeedOpen"
          @invite-friend="(name) => go('invite', { preselect: [name] })"
        />
      </keep-alive>

      <!-- 详情/其它页（按 event/id 切换，不缓存）：独立 v-if 链，与上面的 keep-alive 平级 -->
      <MatchDetail
        v-if="route.name === 'match'"
        :key="route.params.id"
        :match-id="route.params.id"
        @back="go(detailFrom)"
      />
      <PmDetail
        v-else-if="route.name === 'pm'"
        :event="route.params.event"
        @back="go(detailFrom)"
      />
      <FeedView v-else-if="route.name === 'feed'" @open="onFeedViewOpen" />
      <Leaderboard v-else-if="route.name === 'rank'" />
      <InviteFriends
        v-else-if="route.name === 'invite'"
        :initial-selected="route.params.preselect || []"
        @open="onFeedOpen"
      />
      <MyAssets v-else-if="route.name === 'profile'" @back="go('home')" @open="go" />
    </main>

    <!-- 底部 5 位 iPhone风格：主页/搜索 ‖ +新建(居中FAB) ‖ 朋友/我的 -->
    <nav class="tabbar">
      <!-- 主页 -->
      <button class="tab-btn" :class="{ active: activeTab === 'home' }" @click="go('home')">
        <svg class="tab-ico" viewBox="0 0 24 24" fill="currentColor">
          <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
        </svg>
        <span class="tab-lbl">主页</span>
      </button>

      <!-- 搜索 -->
      <button class="tab-btn" :class="{ active: activeTab === 'search' }" @click="go('search')">
        <svg class="tab-ico" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9.5 3a6.5 6.5 0 0 1 5.17 10.45l4.44 4.44-1.41 1.41-4.44-4.44A6.5 6.5 0 1 1 9.5 3zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/>
        </svg>
        <span class="tab-lbl">搜索</span>
      </button>

      <!-- 新建 FAB（中间突出） -->
      <div class="tab-fab-wrap">
        <button class="fab" @click="showCreate = true" title="新建赌局">
          <svg viewBox="0 0 24 24" fill="currentColor" width="29" height="29">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
          </svg>
        </button>
        <span class="tab-lbl fab-lbl">新建</span>
      </div>

      <!-- 朋友 -->
      <button class="tab-btn" :class="{ active: activeTab === 'friends' }" @click="go('friends')">
        <svg class="tab-ico" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8.5 0a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM8 13c-3.31 0-6 1.79-6 4v2h12v-2c0-2.21-2.69-4-6-4zm8.5.5c-.7 0-1.36.09-1.98.26.94.83 1.48 1.94 1.48 3.24v2h6v-1.5c0-2.21-2.46-4-5.5-4z"/>
        </svg>
        <span class="tab-lbl">朋友</span>
      </button>

      <!-- 我的 -->
      <button class="tab-btn" :class="{ active: activeTab === 'profile' }" @click="go('profile')">
        <svg class="tab-ico" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
        </svg>
        <span class="tab-lbl">我的</span>
      </button>
    </nav>

    <!-- 新建 sheet（FAB 触发，浮层不切 tab）；"邀请好友"已是浮层内第 4 玩法，不再跳页 -->
    <CreateMatch v-if="showCreate" @close="showCreate = false" />

    <!-- 通知摘要：你不在时发生了什么（§5.14） -->
    <div v-if="showNotif" class="notif-mask" @click.self="closeNotif">
      <div class="notif-sheet">
        <div class="notif-hd">
          <span class="notif-title">🔔 你不在时发生了什么</span>
          <button class="notif-close" @click="closeNotif">✕</button>
        </div>
        <div v-if="notifList.length === 0" class="notif-empty muted">
          没有新动态，去开一盘吧 🎲
        </div>
        <div v-else class="notif-list">
          <div
            v-for="ev in notifList"
            :key="ev.id"
            class="notif-item"
            :class="{ clickable: ev.ref }"
            @click="notifGo(ev)"
          >
            <span class="ni-emoji">{{ ev.actorEmoji }}</span>
            <div class="ni-main">
              <div class="ni-text"><b>{{ ev.actorName }}</b> {{ ev.text }}</div>
              <div class="ni-time faint">{{ notifAgo(ev.at) }}</div>
            </div>
          </div>
        </div>
        <button class="btn block" style="margin-top:12px" @click="closeNotif">知道了</button>
      </div>
    </div>

    <!-- S10 异常状态机：到期自动作废退回提示 -->
    <div v-if="expiredNotice > 0" class="notif-mask" @click.self="expiredNotice = 0">
      <div class="notif-sheet">
        <div class="notif-hd">
          <span class="notif-title">⏰ 到期自动作废</span>
          <button class="notif-close" @click="expiredNotice = 0">✕</button>
        </div>
        <p style="font-size:14px;line-height:1.6">
          有 <b>{{ expiredNotice }}</b> 个赌局到截止仍无人接盘，已自动作废，
          冻结的积分<b>原路退回</b>到你的余额（虚拟娱乐积分，绝不锁死）。
        </p>
        <button class="btn block" style="margin-top:12px" @click="expiredNotice = 0">知道了</button>
      </div>
    </div>

    <!-- S10 新用户引导（首登一次，可跳过）-->
    <div v-if="showOnboard" class="onboard-mask">
      <div class="onboard-card">
        <div class="ob-icon">{{ ONBOARD_STEPS[onboardStep].icon }}</div>
        <div class="ob-title">{{ ONBOARD_STEPS[onboardStep].title }}</div>
        <div class="ob-text">{{ ONBOARD_STEPS[onboardStep].text }}</div>
        <div class="ob-dots">
          <span
            v-for="(s, i) in ONBOARD_STEPS"
            :key="i"
            class="ob-dot"
            :class="{ on: i === onboardStep }"
          ></span>
        </div>
        <div class="ob-actions">
          <button class="ob-skip" @click="closeOnboard">跳过</button>
          <button class="btn ob-next" @click="nextOnboard">
            {{ onboardStep < ONBOARD_STEPS.length - 1 ? '下一步' : '开始玩 🎲' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 14px 10px;
  background: rgba(251, 251, 253, 0.86);
  backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}
/* 底缘一道缓慢往复的青色流光（compositor-only：只动 transform） */
.topbar::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 42%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(24, 134, 150, 0.55), rgba(93, 220, 213, 0.7), transparent);
  animation: topbarGlide 7s ease-in-out infinite;
  pointer-events: none;
}
@keyframes topbarGlide {
  0%, 100% { transform: translateX(-60%); }
  50% { transform: translateX(calc(480px + 20%)); }
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-shrink: 0;
  white-space: nowrap;
}
.brand-en {
  font-family: Manrope, ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0;
  background: var(--brand-text-gradient);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.brand-cn {
  color: var(--text-dim);
  font-family: 'LINE Seed Sans TC', 'LINE Seed Sans SC', 'Noto Sans CJK TC', 'Noto Sans CJK SC', 'Noto Sans SC', 'PingFang TC', 'PingFang SC', sans-serif;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0;
}
.top-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.icon-btn {
  position: relative;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: 0 8px 18px rgba(15, 83, 110, 0.08);
  transition: color .15s, background .15s, border-color .15s, transform .15s;
}
.icon-btn svg { width: 18px; height: 18px; }
.icon-btn.active { color: var(--blue); border-color: rgba(15, 83, 110, 0.34); background: var(--blue-dim); }
.icon-btn:active { background: var(--bg-card-2); }
.badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--red);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  border: 1px solid #fff;
}
.bal {
  display: flex;
  align-items: baseline;
  gap: 4px;
  flex-shrink: 0;
  white-space: nowrap;
  background: var(--bg-card);
  border: 1px solid var(--border);
  padding: 6px 8px;
  border-radius: 20px;
  cursor: pointer;
  box-shadow: 0 8px 18px rgba(15, 83, 110, 0.08);
}
.bal-num {
  font-weight: 700;
  font-size: 14px;
  color: var(--green);
}
.bal-unit {
  font-size: 11px;
  color: var(--text-dim);
}
.bal.has-supply {
  border-color: var(--green);
  background: var(--green-bg);
  box-shadow: 0 8px 18px rgba(19, 136, 94, 0.12);
}
/* 余额变动闪色：涨绿跌红，一次性脉冲 */
.bal.flash-up { animation: balPulseUp .9s ease-out; }
.bal.flash-down { animation: balPulseDown .9s ease-out; }
.bal.flash-down .bal-num { color: var(--red); }
@keyframes balPulseUp {
  0% { box-shadow: 0 0 0 0 rgba(19, 136, 94, 0.45); border-color: var(--green); }
  100% { box-shadow: 0 8px 18px rgba(15, 83, 110, 0.08); }
}
@keyframes balPulseDown {
  0% { box-shadow: 0 0 0 0 rgba(199, 67, 67, 0.4); border-color: var(--red); }
  100% { box-shadow: 0 8px 18px rgba(15, 83, 110, 0.08); }
}
.supply-dot {
  font-size: 12px;
  margin-left: 2px;
}

/* ── 底栏 ── */
.tabbar {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: 480px;
  display: flex;
  align-items: flex-end;
  background: rgba(251, 251, 253, 0.9);
  backdrop-filter: blur(18px);
  border-top: 1px solid var(--border);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  z-index: 20;
  box-shadow: 0 -16px 34px rgba(15, 23, 42, 0.08);
}

.tab-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 11px 0 15px;
  color: var(--text-faint);
  font-size: 13px;
  transition: color .15s;
}
.tab-btn.active {
  color: var(--blue);
}
.tab-btn.active .tab-ico {
  animation: tabPop .32s cubic-bezier(.34, 1.56, .64, 1);
}
.tab-ico {
  width: 24px;
  height: 24px;
}
@keyframes tabPop {
  0% { transform: scale(0.82); }
  60% { transform: scale(1.12); }
  100% { transform: scale(1); }
}
.tab-lbl {
  font-size: 13px;
  font-weight: 600;
}

/* FAB 中间突出按钮 */
.tab-fab-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  padding-bottom: 15px;
  gap: 4px;
}
.fab-lbl {
  color: var(--text-faint);
  font-size: 13px;
  font-weight: 600;
}

.fab {
  width: 57px;
  height: 57px;
  border-radius: 50%;
  background: var(--brand-gradient);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 0 0 4px rgba(93, 220, 213, 0.16),
    0 10px 24px rgba(15, 83, 110, 0.24);
  transition: box-shadow .2s, transform .15s, background .15s;
  margin-top: -18px; /* 向上凸出底栏 */
}
.fab:active {
  transform: scale(0.93);
  box-shadow:
    0 0 0 6px rgba(93, 220, 213, 0.22),
    0 4px 12px rgba(15, 83, 110, 0.2);
}

/* ── 通知摘要弹层 ── */
.notif-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(15, 35, 48, 0.34);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 64px 16px 16px;
}
.notif-sheet {
  width: 100%;
  max-width: 440px;
  max-height: 70vh;
  overflow-y: auto;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.16);
}
.notif-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.notif-title { font-size: 15px; font-weight: 700; }
.notif-close { color: var(--text-dim); font-size: 16px; padding: 2px 6px; }
.notif-empty { text-align: center; padding: 30px 10px; font-size: 14px; }
.notif-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}
.notif-item:first-child { border-top: none; }
.notif-item.clickable { cursor: pointer; }
.notif-item.clickable:active { opacity: 0.7; }
.ni-emoji { font-size: 24px; flex: 0 0 auto; }
.ni-main { flex: 1; min-width: 0; }
.ni-text { font-size: 14px; line-height: 1.45; }
.ni-time { font-size: 11px; margin-top: 2px; }

/* ── S10 新用户引导 ── */
.onboard-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background:
    radial-gradient(circle at 50% 30%, rgba(93, 220, 213, 0.16), transparent 38%),
    rgba(245, 246, 248, 0.82);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.onboard-card {
  width: 100%;
  max-width: 340px;
  background:
    linear-gradient(180deg, rgba(93, 220, 213, 0.08), rgba(255, 255, 255, 0) 38%),
    var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 28px 22px 20px;
  text-align: center;
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.14);
}
.ob-icon { font-size: 40px; margin-bottom: 12px; }
.ob-title {
  font-size: 20px;
  font-weight: 900;
  margin-bottom: 10px;
  background: var(--brand-text-gradient);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.ob-text { font-size: 14px; line-height: 1.6; color: var(--text-dim); margin-bottom: 18px; }
.ob-dots { display: flex; justify-content: center; gap: 6px; margin-bottom: 18px; }
.ob-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--border);
  transition: background .2s, width .2s;
}
.ob-dot.on { background: var(--blue); width: 18px; border-radius: 4px; }
.ob-actions { display: flex; align-items: center; gap: 12px; }
.ob-skip { flex: 0 0 auto; color: var(--text-dim); font-size: 14px; padding: 8px 4px; }
.ob-next { flex: 1; }

@media (prefers-reduced-motion: reduce) {
  .topbar::after { animation: none; opacity: 0; }
  .tab-btn.active .tab-ico { animation: none; }
  .bal.flash-up, .bal.flash-down { animation: none; }
}
</style>
