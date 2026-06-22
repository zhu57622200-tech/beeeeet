<script setup>
import { computed } from 'vue'
import { store } from '../store.js'

// 动态流（S4 §5.10 粘性内核）：朋友圈式倒序列表。
// store.feed 本身已倒序（最新在前）。点一条带 ref 的动态可跳对赌详情。
const emit = defineEmits(['open'])

const feed = computed(() => store.feed)

// 事件类型 → 左侧图标徽记。
const TYPE_ICON = {
  open: '🎲',
  watch: '👀',
  join: '⚔️',
  settle: '🏁',
  streak: '🔥',
  slap: '😂',
  expire: '⏰', // S10 到期自动作废
  appeal: '⚖️', // S10 申诉复议
}
function typeIcon(t) {
  return TYPE_ICON[t] || '📣'
}

function openMatch(ev) {
  if (!ev.ref) return
  if (store.matches.some((m) => m.id === ev.ref)) {
    emit('open', 'match', { id: ev.ref })
  } else {
    // 该局已撤盘/赛季清/到期作废，ref 失效。不再静默无反应，给轻提示（LOOP-2）。
    alert('该赌局已不存在（可能已撤盘、到期作废或赛季已清）')
  }
}

// 相对时间：刚刚 / N分钟前 / N小时前 / HH:MM。
function fmtAgo(ts) {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
</script>

<template>
  <div>
    <div class="feed-hd">
      <span class="feed-title">动态</span>
      <span class="feed-sub faint">饭桌那帮人都在干啥</span>
    </div>

    <div v-if="feed.length === 0" class="empty">
      还没有动态 🍃<br />
      <span class="faint" style="font-size:12px;margin-top:6px;display:block">开一盘就热闹起来了</span>
    </div>

    <div
      v-for="ev in feed"
      :key="ev.id"
      class="feed-item"
      :class="{ clickable: ev.ref }"
      @click="openMatch(ev)"
    >
      <div class="fi-avatar">
        <span class="fi-emoji">{{ ev.actorEmoji }}</span>
        <span class="fi-badge" :class="ev.type">{{ typeIcon(ev.type) }}</span>
      </div>
      <div class="fi-main">
        <div class="fi-line">
          <b class="fi-name">{{ ev.actorName }}</b>
          <span class="fi-text">{{ ev.text }}</span>
        </div>
        <div class="fi-time faint">{{ fmtAgo(ev.at) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.feed-hd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 14px 16px 6px;
  border-bottom: 1px solid var(--border);
}
.feed-title { font-size: 17px; font-weight: 800; }
.feed-sub { font-size: 12px; }

.empty {
  text-align: center;
  color: var(--text-dim);
  padding: 50px 20px;
  font-size: 14px;
}

.feed-item {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.feed-item.clickable { cursor: pointer; }
.feed-item.clickable:active { background: var(--bg-card); }

.fi-avatar {
  position: relative;
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
}
.fi-emoji {
  font-size: 30px;
  line-height: 36px;
}
.fi-badge {
  position: absolute;
  right: -4px;
  bottom: -4px;
  font-size: 12px;
  background: var(--bg-card-2);
  border-radius: 50%;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
}

.fi-main { flex: 1; min-width: 0; }
.fi-line { font-size: 14px; line-height: 1.45; }
.fi-name { color: var(--text); margin-right: 4px; }
.fi-text { color: var(--text-dim); }
.fi-time { font-size: 11px; margin-top: 3px; }
</style>
