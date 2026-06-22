<script setup>
// P1 系统盘卡片：支持两种形态——
//   outright 榜单(世界杯夺冠/出线/晋级/金靴…每个候选一个 Yes/No 盘)→ 概率降序榜单预览；
//   simple 单盘(旧通用盘)→ 主盘选项概率条(原 HomeFeed.topMarketOptions 行为)。
// 列表页与关注页共用，避免重复。点卡片 emit('open')；下注/结算守恒仍由 store 用真实英文 outcome。
import { computed } from 'vue'
import { isWatched, toggleWatch } from '../store.js'
import { parseOutcomes } from '../api.js'

const props = defineProps({ ev: { type: Object, required: true } })
const emit = defineEmits(['open'])

// outright 形态判定（后端缓存挂 kind:'outright' + outright:[{marketId,name,zhName,prob,outcomes}]）。
const isOutright = computed(
  () => props.ev.kind === 'outright' && Array.isArray(props.ev.outright) && props.ev.outright.length > 0,
)
// 榜单预览只取前 5 名（完整榜单进详情看）。
const topRows = computed(() => (props.ev.outright || []).slice(0, 5))

// simple 盘主玩法选项（中文名替换、概率取真实盘口，取前 4）。
const simpleOptions = computed(() => {
  const m = props.ev.markets?.[0]
  if (!m) return []
  const opts = parseOutcomes(m).slice(0, 4)
  const zh = props.ev.zhOutcomes
  if (Array.isArray(zh) && zh.length) return opts.map((o, i) => ({ ...o, name: zh[i] || o.name }))
  return opts
})

const pct = (p) => ((p || 0) * 100).toFixed(0)
const cents = (p) => Math.round((p || 0) * 100) // 美分赔率（概率×100，体育盘口习惯）
// P3 单场对阵形态（后端缓存挂 kind:'match' + match:{teams,moneyline,spread,total}）。
const isMatch = computed(() => props.ev.kind === 'match' && !!props.ev.match)
const mlOptions = computed(() => props.ev.match?.moneyline?.options || [])
const watched = computed(() => isWatched('pm', props.ev.id))
function toggle(e) {
  e.stopPropagation()
  toggleWatch('pm', props.ev.id)
}
</script>

<template>
  <div class="card pm-card" @click="emit('open', 'pm', { event: ev })">
    <div class="pm-head">
      <img v-if="ev.icon" :src="ev.icon" class="pm-icon" alt="" loading="lazy" decoding="async" fetchpriority="low" />
      <div class="pm-title">{{ ev.title }}</div>
      <button
        class="star-btn"
        :class="{ watched }"
        @click="toggle"
        :title="watched ? '取消关注' : '关注'"
      >{{ watched ? '★' : '☆' }}</button>
    </div>
    <div class="pm-tags">
      <span v-if="ev.subcat" class="tag hot-tag">{{ ev.subcat }}</span>
      <span v-if="ev.category" class="tag">{{ ev.category }}</span>
    </div>

    <!-- outright 榜单预览 -->
    <div v-if="isOutright" class="rank-list">
      <div v-for="(row, i) in topRows" :key="row.marketId" class="rank-row">
        <span class="rank-no" :class="{ top: i === 0 }">{{ i + 1 }}</span>
        <span class="rank-name">{{ row.zhName || row.name }}</span>
        <div class="prob-track">
          <div class="prob-fill" :style="{ width: (row.prob * 100).toFixed(1) + '%' }"></div>
        </div>
        <span class="prob-pct">{{ pct(row.prob) }}%</span>
      </div>
      <div class="pm-foot faint">共 {{ ev.outright.length }} 个候选 · 点开看完整榜单</div>
    </div>

    <!-- 单场对阵：胜负线两队美分赔率 -->
    <div v-else-if="isMatch" class="ml-row">
      <div v-for="o in mlOptions" :key="o.name" class="ml-cell">
        <span class="ml-team">{{ o.zhName || o.name }}</span>
        <span class="ml-cents">{{ cents(o.prob) }}¢</span>
      </div>
      <div v-if="!mlOptions.length" class="pm-foot faint">盘口加载中…</div>
    </div>

    <!-- simple 单盘选项 -->
    <template v-else>
      <div class="pm-probs">
        <div v-for="o in simpleOptions" :key="o.name" class="prob-row">
          <span class="prob-label">{{ o.name }}</span>
          <div class="prob-track">
            <div class="prob-fill" :style="{ width: (o.prob * 100).toFixed(1) + '%' }"></div>
          </div>
          <span class="prob-pct">{{ pct(o.prob) }}%</span>
        </div>
      </div>
      <div class="pm-foot faint">
        热度 {{ Math.round(ev.volume24hr || 0).toLocaleString() }} · {{ (ev.markets || []).length }} 个盘
      </div>
    </template>
  </div>
</template>

<style scoped>
.pm-card { cursor: pointer; }
.pm-head { display: flex; gap: 10px; align-items: center; }
.pm-icon {
  width: 40px; height: 40px;
  border-radius: 8px;
  object-fit: cover;
  flex: 0 0 auto;
  background: var(--bg-card-2);
}
.pm-title { font-size: 17px; font-weight: 650; line-height: 1.35; flex: 1; }
.pm-tags { margin: 10px 0 6px; }
.hot-tag { color: var(--blue); background: var(--blue-dim); border-color: var(--blue-dim); font-weight: 700; }
.pm-probs { margin: 4px 0; }
.pm-foot { font-size: 12px; margin-top: 8px; }

/* outright 榜单 */
.rank-list { margin: 6px 0 0; }
.rank-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 0;
}
.rank-no {
  flex: 0 0 auto;
  width: 18px;
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-faint);
}
.rank-no.top { color: var(--amber); }
.rank-name {
  flex: 0 0 88px;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rank-row .prob-track { flex: 1; }
.rank-row .prob-pct { flex: 0 0 auto; min-width: 38px; font-size: 13px; font-weight: 600; text-align: right; }

/* P3 单场胜负线两队美分赔率 */
.ml-row { display: flex; gap: 8px; margin: 8px 0 2px; }
.ml-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 9px 6px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  min-width: 0;
}
.ml-team { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.ml-cents { font-size: 16px; font-weight: 800; color: var(--blue); }
</style>
