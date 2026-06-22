<script setup>
import { ref, computed, nextTick, onMounted, onActivated, onUnmounted, watch } from 'vue'
import {
  store,
  chatWith,
  friendStatus,
  isFriend,
  requestFriend,
  respondFriendRequest,
  removeFriend,
  scheduleIncomingRequestDemo,
  searchPlayers,
  sendChat,
  refreshFriends,
} from '../store.js'

defineOptions({ name: 'FriendsView' })

const emit = defineEmits(['open', 'invite-friend'])

const selectedName = ref('')
const view = ref('list') // list | profile | chat
const draft = ref('')
const err = ref('')
const chatBox = ref(null)
const searchText = ref('')
let stopIncomingDemo = null

const people = computed(() => store.players.filter((p) => !p.isMe))
const friends = computed(() => people.value.filter((p) => isFriend(p.name)))
const circlePeople = computed(() => people.value.filter((p) => !isFriend(p.name)))
const selectedFriend = computed(() => people.value.find((p) => p.name === selectedName.value) || null)
const profileUnlocked = computed(() => selectedFriend.value ? isFriend(selectedFriend.value.name) : false)
const messages = computed(() => selectedName.value ? chatWith(selectedName.value) : [])
const searchKey = computed(() => searchText.value.trim())
const searchResults = computed(() => searchPlayers(searchText.value))
const pendingRequests = computed(() => {
  const list = Array.isArray(store.friendRequests) ? store.friendRequests : []
  return list.map((r) => {
    const p = people.value.find((x) => x.name === r.fromName)
    return { ...r, emoji: p?.emoji || '🙂', title: p?.title || '' }
  })
})

onMounted(() => {
  stopIncomingDemo = scheduleIncomingRequestDemo()
  refreshFriends().catch(() => {})
})
// keep-alive 缓存：每次切到「朋友」tab 都拉最新好友（新注册的朋友实时出现）
onActivated(() => {
  refreshFriends().catch(() => {})
})
onUnmounted(() => {
  if (stopIncomingDemo) stopIncomingDemo()
})

// 防白屏兜底：keep-alive 恢复后若所选玩家已不存在（联机后朋友可能被删），自动退回列表。
watch(selectedFriend, (f) => {
  if (!f && view.value !== 'list') {
    selectedName.value = ''
    view.value = 'list'
  }
})

function openFriend(name) {
  selectedName.value = name
  view.value = 'profile'
  err.value = ''
}
function back() {
  if (view.value === 'chat') {
    view.value = 'profile'
    err.value = ''
    return
  }
  selectedName.value = ''
  view.value = 'list'
}
function openChat() {
  if (!profileUnlocked.value) return
  view.value = 'chat'
  nextTick(scrollChat)
}
function inviteFriend() {
  if (selectedName.value && profileUnlocked.value) emit('invite-friend', selectedName.value)
}
function addFriend(name) {
  requestFriend(name)
}
function answerRequest(id, accept) {
  respondFriendRequest(id, accept)
}
function deleteFriend() {
  const name = selectedFriend.value?.name
  if (!name) return
  if (!confirm(`确定删除 ${name} 吗？私信记录会保留。`)) return
  removeFriend(name)
  selectedName.value = ''
  view.value = 'list'
}
function send() {
  err.value = ''
  try {
    sendChat(selectedName.value, draft.value)
    draft.value = ''
    nextTick(scrollChat)
  } catch (e) {
    err.value = e.message || '发送失败'
  }
}
function scrollChat() {
  const el = chatBox.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => messages.value.length,
  () => {
    if (view.value === 'chat') nextTick(scrollChat)
  }
)

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US')
}
function streakText(n) {
  if (n > 0) return `连胜 ${n}`
  if (n < 0) return `连败 ${Math.abs(n)}`
  return '无连胜'
}
function ago(ts) {
  if (!Number.isFinite(ts)) return '' // 字段缺失兜底，避免渲染 NaN
  const min = Math.floor((Date.now() - ts) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  return `${Math.floor(hr / 24)}天前`
}
function statusLabel(m) {
  if (m.status === 'settled') return '已揭晓'
  if (m.status === 'matched') return '对赌中'
  if (m.status === 'consensus') return '共识中'
  return '待接盘'
}
function matchHasFriend(m, name) {
  if (m.takerName === name) return true
  if ((m.bets || []).some((b) => b.by === name)) return true
  const pool = [...(m.pool?.A || []), ...(m.pool?.B || [])]
  return pool.some((b) => b.by === name)
}
const friendMatches = computed(() => {
  const name = selectedName.value
  if (!name) return []
  const activeRank = (m) => {
    if (['open', 'matched', 'consensus'].includes(m.status)) return 0
    if (['voting', 'deadlocked', 'arbitration'].includes(m.consensus?.status)) return 0
    return 1
  }
  return store.matches
    .filter((m) => matchHasFriend(m, name))
    .slice()
    .sort((a, b) => activeRank(a) - activeRank(b) || (b.settledAt || b.createdAt || 0) - (a.settledAt || a.createdAt || 0))
    .slice(0, 10)
})
const friendFeed = computed(() => {
  const name = selectedName.value
  if (!name) return []
  return store.feed.filter((e) => e.actorName === name).slice(0, 10)
})
</script>

<template>
  <div class="friends-wrap">
    <template v-if="view === 'list'">
      <div class="page-head">
        <div>
          <div class="eyebrow">熟人圈</div>
          <h1>朋友</h1>
        </div>
        <div class="count">{{ friends.length }} 位好友</div>
      </div>

      <section class="friend-search">
        <input v-model="searchText" placeholder="按昵称或完整手机号找朋友" />
        <div v-if="searchKey" class="search-result-list">
          <div
            v-for="p in searchResults"
            :key="p.name"
            class="search-result-row"
          >
            <button class="friend-open" @click="openFriend(p.name)">
              <span class="avatar small">{{ p.emoji }}</span>
              <span class="friend-main">
                <b>{{ p.name }}</b>
                <span class="muted">{{ p.title }}</span>
              </span>
            </button>
            <button
              v-if="!isFriend(p.name) && friendStatus(p.name) !== 'requested'"
              class="add-btn"
              @click="addFriend(p.name)"
            >
              加好友
            </button>
            <span v-else-if="friendStatus(p.name) === 'requested'" class="requested-label">已申请</span>
            <span v-else class="requested-label">已是好友</span>
          </div>
          <div v-if="!searchResults.length" class="search-empty">没找到这个人</div>
        </div>
      </section>

      <section v-if="pendingRequests.length" class="incoming-card">
        <div class="section-title">好友申请</div>
        <div
          v-for="r in pendingRequests"
          :key="r.id"
          class="incoming-row"
        >
          <span class="avatar small">{{ r.emoji }}</span>
          <span class="friend-main">
            <b>{{ r.fromName }}</b>
            <span class="muted">{{ r.title || '想加你为好友' }}</span>
          </span>
          <button class="mini-btn" @click="answerRequest(r.id, true)">通过</button>
          <button class="mini-btn ghost" @click="answerRequest(r.id, false)">拒绝</button>
        </div>
      </section>

      <div class="section-title">我的好友</div>
      <div class="friend-list">
        <button
          v-for="f in friends"
          :key="f.name"
          class="friend-row"
          @click="openFriend(f.name)"
        >
          <span class="avatar">{{ f.emoji }}</span>
          <span class="friend-main">
            <b>{{ f.name }}</b>
            <span class="muted">{{ f.title }}</span>
          </span>
          <span class="friend-stat">
            <b>{{ f.wins }}/{{ f.losses }}</b>
            <span>{{ streakText(f.streak) }}</span>
          </span>
        </button>
        <div v-if="!friends.length" class="empty">还没有好友，先从圈子里加一个。</div>
      </div>

      <div class="section-title circle-title">圈子里的人</div>
      <div class="friend-list">
        <div
          v-for="f in circlePeople"
          :key="f.name"
          class="friend-row"
        >
          <button class="friend-open" @click="openFriend(f.name)">
            <span class="avatar">{{ f.emoji }}</span>
            <span class="friend-main">
              <b>{{ f.name }}</b>
              <span class="muted">{{ f.title }}</span>
            </span>
          </button>
          <button
            v-if="friendStatus(f.name) !== 'requested'"
            class="add-btn"
            @click="addFriend(f.name)"
          >
            加好友
          </button>
          <span v-else class="requested-label">已申请</span>
        </div>
        <div v-if="!circlePeople.length" class="empty">圈子里的人都已经是好友了。</div>
      </div>
    </template>

    <template v-else-if="selectedFriend">
      <div class="subbar">
        <button class="back-btn" @click="back">‹</button>
        <span>{{ view === 'chat' ? '私信' : '朋友主页' }}</span>
      </div>

      <template v-if="view === 'profile'">
        <section class="profile-hero">
          <div class="hero-left">
            <span class="big-avatar">{{ selectedFriend.emoji }}</span>
            <div>
              <h1>{{ selectedFriend.name }}</h1>
              <div class="muted">{{ selectedFriend.title }}</div>
            </div>
          </div>
          <div class="rep-pill">信誉 {{ selectedFriend.reputation ?? 100 }}</div>
        </section>

        <div class="stats-grid">
          <div class="stat-cell">
            <b>{{ selectedFriend.wins }}/{{ selectedFriend.losses }}</b>
            <span class="muted">胜负</span>
          </div>
          <div class="stat-cell">
            <b>{{ streakText(selectedFriend.streak) }}</b>
            <span class="muted">状态</span>
          </div>
          <div class="stat-cell">
            <b>{{ fmt(selectedFriend.balance) }}</b>
            <span class="muted">身家</span>
          </div>
        </div>

        <div class="action-row" :class="{ locked: !profileUnlocked }">
          <template v-if="profileUnlocked">
            <button class="btn" @click="openChat">💬 私信</button>
            <button class="btn ghost" @click="inviteFriend">🎲 对 TA 开赌局</button>
          </template>
          <button
            v-else-if="friendStatus(selectedFriend.name) !== 'requested'"
            class="btn"
            @click="addFriend(selectedFriend.name)"
          >
            加好友
          </button>
          <div v-else class="requested-card">已申请，等 TA 点头。</div>
        </div>

        <!-- P-0.5 隐私开关：TA 设了隐私则最近赌局/动态全部遮挡 -->
        <template v-if="!profileUnlocked">
          <section class="section">
            <div class="section-title">TA 最近赌了什么</div>
            <div class="empty">加为好友后可查看最近赌局。</div>
          </section>
          <section class="section">
            <div class="section-title">TA 的动态</div>
            <div class="empty">加为好友后可查看动态。</div>
          </section>
        </template>
        <section v-else-if="selectedFriend.privacy" class="section">
          <div class="empty">🔒 TA 设置了隐私，不展示最近赌局和动态</div>
        </section>
        <template v-else>
        <section class="section">
          <div class="section-title">TA 最近赌了什么</div>
          <div class="section-hint faint">点击可进入赌局围观或参与。</div>
          <div v-if="friendMatches.length" class="recent-list">
            <button
              v-for="m in friendMatches"
              :key="m.id"
              class="recent-item"
              @click="emit('open', 'match', { id: m.id })"
            >
              <span class="recent-main">
                <b>{{ m.title }}</b>
                <span class="muted">{{ statusLabel(m) }} · {{ ago(m.settledAt || m.createdAt) }}</span>
              </span>
              <span class="chev">›</span>
            </button>
          </div>
          <div v-else class="empty">最近没动静</div>
        </section>

        <section class="section">
          <div class="section-title">TA 的动态</div>
          <div v-if="friendFeed.length" class="feed-list">
            <button
              v-for="ev in friendFeed"
              :key="ev.id"
              class="feed-item"
              :class="{ clickable: ev.ref }"
              @click="ev.ref && emit('open', 'match', { id: ev.ref })"
            >
              <span>{{ ev.actorEmoji }}</span>
              <span class="feed-main">
                <b>{{ ev.text }}</b>
                <em>{{ ago(ev.at) }}</em>
              </span>
            </button>
          </div>
          <div v-else class="empty">最近没动静</div>
        </section>
        </template>
        <button v-if="profileUnlocked" class="delete-friend-btn" @click="deleteFriend">删除好友</button>
      </template>

      <template v-else>
        <section class="chat-head">
          <span class="big-avatar">{{ selectedFriend.emoji }}</span>
          <div>
            <h1>{{ selectedFriend.name }}</h1>
            <div class="muted">{{ selectedFriend.title }}</div>
          </div>
        </section>

        <div ref="chatBox" class="chat-box">
          <div v-if="!messages.length" class="empty chat-empty">还没聊过，先放句狠话。</div>
          <div
            v-for="msg in messages"
            :key="msg.id"
            class="bubble-row"
            :class="{ mine: msg.from === 'me' }"
          >
            <div class="bubble">
              <span>{{ msg.text }}</span>
              <em>{{ ago(msg.at) }}</em>
            </div>
          </div>
        </div>

        <div class="chat-input">
          <input v-model="draft" placeholder="发条私信" @keyup.enter="send" />
          <button class="btn send-btn" :disabled="!draft.trim()" @click="send">发送</button>
        </div>
        <div v-if="err" class="err">{{ err }}</div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.friends-wrap { padding: 16px; }
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 14px;
}
.eyebrow {
  font-size: 12px;
  font-weight: 800;
  color: var(--blue);
  margin-bottom: 4px;
}
h1 {
  font-size: 24px;
  line-height: 1.2;
  letter-spacing: 0;
}
.count {
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 700;
}
.friend-list { display: flex; flex-direction: column; gap: 9px; }
.friend-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  text-align: left;
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.06);
}
.friend-open {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
}
.avatar {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--bg-card-2);
  font-size: 25px;
}
.avatar.small {
  width: 34px;
  height: 34px;
  font-size: 21px;
}
.friend-search {
  margin: 0 0 14px;
  padding: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.friend-search input { width: 100%; }
.search-result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.search-result-row,
.incoming-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px;
  border-radius: 9px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
}
.search-empty {
  padding: 10px;
  color: var(--text-dim);
  font-size: 13px;
  text-align: center;
}
.incoming-card {
  margin-bottom: 16px;
  padding: 12px;
  border-radius: 10px;
  background: rgba(93, 220, 213, 0.08);
  border: 1px solid rgba(93, 220, 213, 0.22);
}
.incoming-card .section-title { margin-bottom: 9px; color: var(--blue); }
.mini-btn {
  flex: 0 0 auto;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--brand-gradient);
  color: #fff;
  font-size: 12px;
  font-weight: 800;
}
.mini-btn.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.friend-main {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}
.friend-main b { font-size: 16px; }
.friend-main span { font-size: 12px; overflow-wrap: anywhere; }
.friend-stat {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  font-size: 12px;
  color: var(--text-dim);
}
.friend-stat b { color: var(--text); font-size: 14px; }
.circle-title { margin-top: 18px; }
.add-btn {
  flex: 0 0 auto;
  min-width: 76px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(93, 220, 213, 0.14);
  border: 1px solid var(--blue);
  color: var(--blue);
  font-size: 13px;
  font-weight: 800;
}
.requested-label {
  flex: 0 0 auto;
  min-width: 76px;
  color: var(--text-faint);
  font-size: 13px;
  font-weight: 800;
  text-align: center;
}
.subbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: var(--text-dim);
  font-size: 14px;
  font-weight: 700;
}
.back-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--blue);
  font-size: 28px;
  line-height: 1;
}
.profile-hero,
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
}
.chat-head { justify-content: flex-start; margin-bottom: 12px; }
.hero-left {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}
.big-avatar {
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--bg-card-2);
  font-size: 34px;
}
.rep-pill {
  flex: 0 0 auto;
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--green-bg);
  color: var(--green);
  border: 1px solid rgba(19, 136, 94, 0.24);
  font-size: 12px;
  font-weight: 800;
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 10px;
}
.stat-cell {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 8px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  text-align: center;
}
.stat-cell b {
  color: var(--blue);
  font-size: 15px;
  overflow-wrap: anywhere;
}
.stat-cell span { font-size: 12px; }
.action-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 12px 0 16px;
}
.action-row.locked { grid-template-columns: 1fr; }
.requested-card {
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px dashed var(--border);
  color: var(--text-dim);
  font-size: 14px;
  font-weight: 800;
}
.section { margin-top: 16px; }
.section-title {
  font-size: 13px;
  font-weight: 800;
  color: var(--text-dim);
  margin-bottom: 8px;
}
.section-hint {
  margin: -3px 0 8px;
  font-size: 12px;
}
.recent-list,
.feed-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.recent-item,
.feed-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  text-align: left;
}
.recent-main,
.feed-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.recent-main b,
.feed-main b {
  font-size: 14px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.recent-main span,
.feed-main em {
  font-size: 12px;
  color: var(--text-faint);
  font-style: normal;
}
.chev {
  color: var(--text-faint);
  font-size: 22px;
}
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 82px;
  padding: 16px;
  background: var(--bg-card);
  border: 1px dashed var(--border);
  border-radius: 10px;
  color: var(--text-dim);
  font-size: 14px;
}
.chat-box {
  height: calc(100vh - 270px);
  min-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 8px 0 12px;
}
.chat-empty { margin-top: 20px; }
.bubble-row {
  display: flex;
  justify-content: flex-start;
}
.bubble-row.mine { justify-content: flex-end; }
.bubble {
  max-width: 78%;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.05);
}
.mine .bubble {
  color: #fff;
  background: var(--brand-gradient);
  border-color: rgba(15, 83, 110, 0.34);
}
.bubble span {
  font-size: 15px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.bubble em {
  align-self: flex-end;
  color: var(--text-faint);
  font-size: 10px;
  font-style: normal;
}
.mine .bubble em { color: rgba(255, 255, 255, 0.72); }
.chat-input {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.delete-friend-btn {
  width: 100%;
  margin-top: 16px;
  padding: 10px;
  border-radius: 10px;
  background: transparent;
  border: 1px solid rgba(213, 75, 75, 0.34);
  color: var(--red);
  font-size: 13px;
  font-weight: 800;
}
.send-btn {
  min-width: 70px;
  padding-left: 12px;
  padding-right: 12px;
}
.err {
  margin-top: 8px;
  color: var(--red);
  font-size: 13px;
}
</style>
