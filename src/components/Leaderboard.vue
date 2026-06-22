<script setup>
import { ref, computed } from 'vue'
import { store, getDeadbeatBoard } from '../store.js'
import { wealthBoard, predictBoard, streakBoard } from '../core/leaderboard.js'
import { getRank } from '../core/rank.js'
import { SLOGAN_RANK } from '../core/slogans.js'

// 四榜 Tab 切换：身家 / 神预测 / 连胜 / 老赖（§5.12）。实名 + 高亮"我"。
const tab = ref('wealth')
const TABS = [
  { key: 'wealth', label: '身家榜', hint: '总积分排行' },
  { key: 'predict', label: '神预测榜', hint: '胜率排行 · 满 5 单进榜' },
  { key: 'streak', label: '连胜榜', hint: '历史最大连胜' },
  { key: 'deadbeat', label: '老赖榜', hint: '线下彩头逾期未还愿 + 低信誉 · 公开处刑' },
]

const rows = computed(() => {
  if (tab.value === 'predict') return predictBoard(store.players)
  if (tab.value === 'streak') return streakBoard(store.players)
  return wealthBoard(store.players)
})

// 老赖榜：逾期欠条 + 低信誉（依赖 store.matches/offlineMatches/players，会响应式更新）。
const deadbeat = computed(() => getDeadbeatBoard())

const hint = computed(() => TABS.find((t) => t.key === tab.value)?.hint || '')

// 前三名奖牌（金银铜）。
function medal(rank) {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : ''
}
// §E 名次配色档：前三各异(金/银/铜)、4-6 同一色、其余同一色。
function rankClass(rank) {
  if (rank === 1) return 'rk1'
  if (rank === 2) return 'rk2'
  if (rank === 3) return 'rk3'
  if (rank <= 6) return 'rk46'
  return 'rkrest'
}
// 玩家段位（神预测/连胜榜副标题旁的小徽章用）。
function rankOf(id) {
  const p = store.players.find((x) => x.id === id)
  return getRank({ wins: p?.wins || 0, losses: p?.losses || 0 })
}
</script>

<template>
  <div class="lb">
    <!-- 三榜 Tab -->
    <div class="lb-tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="lb-tab"
        :class="{ on: tab === t.key }"
        @click="tab = t.key"
      >{{ t.label }}</button>
    </div>
    <div class="lb-hint muted">{{ hint }}</div>
    <div class="lb-slogan">{{ SLOGAN_RANK }}</div>

    <!-- ── 老赖榜（§5.12 公开处刑） ── -->
    <template v-if="tab === 'deadbeat'">
      <div class="card">
        <div class="dead-sec">⛔ 逾期欠条（线下彩头未还愿）</div>
        <div v-if="deadbeat.debts.length === 0" class="empty muted">
          目前没人欠彩头未还愿，江湖一片祥和 🕊️
        </div>
        <div v-for="d in deadbeat.debts" :key="d.kind + d.id" class="dead-row">
          <span class="emoji">{{ d.debtorEmoji }}</span>
          <div class="who">
            <div class="name">{{ d.debtorName }} <span class="tag-owe">欠</span></div>
            <div class="sub muted">
              {{ d.kind === 'offline' ? '🏓' : '🎯' }} {{ d.title }} · 「{{ d.text }}」
            </div>
          </div>
          <div class="overdue">逾期 {{ d.overdueDays }} 天</div>
        </div>
      </div>

      <div class="card">
        <div class="dead-sec">📉 信誉不良（低于 70）</div>
        <div v-if="deadbeat.lowRep.length === 0" class="empty muted">
          大家信誉都还过得去 👍
        </div>
        <div
          v-for="p in deadbeat.lowRep"
          :key="p.name"
          class="dead-row"
          :class="{ me: p.isMe }"
        >
          <span class="emoji">{{ p.emoji }}</span>
          <div class="who">
            <div class="name">{{ p.name }} <span v-if="p.isMe" class="me-tag">我</span></div>
            <div class="sub muted">信誉受损，欠债不还/乱判/拖延者，慎与之赌</div>
          </div>
          <div class="rep-val">信誉 {{ p.reputation }}</div>
        </div>
      </div>

      <div class="foot muted">仅限熟人圈内娱乐 · 线下自行核实、如有异议可申诉 · 平台只记录不结算、积分永不可兑现</div>
    </template>

    <!-- ── 三榜（身家/神预测/连胜） ── -->
    <div v-else class="card">
      <div v-if="rows.length === 0" class="empty muted">
        还没人达标上榜，去开几盘攒战绩吧 🎲
      </div>
      <div
        v-for="r in rows"
        :key="r.id"
        class="row"
        :class="[rankClass(r.rank), { me: r.isMe, top: r.rank <= 3 }]"
      >
        <div class="rk">
          <span v-if="r.rank <= 3" class="medal">{{ medal(r.rank) }}</span>
          <span v-else class="rk-num">{{ r.rank }}</span>
        </div>
        <span class="emoji">{{ r.emoji }}</span>
        <div class="who">
          <div class="name">
            {{ r.name }}
            <span v-if="r.isMe" class="me-tag">我</span>
          </div>
          <div class="sub muted">
            <span class="dot" :style="{ color: rankOf(r.id).color }">{{ rankOf(r.id).icon }}</span>
            {{ r.sub }}
          </div>
        </div>
        <div class="val">{{ r.value }}</div>
      </div>
    </div>

    <div v-if="tab !== 'deadbeat'" class="foot muted">实名榜单 · 仅积分战绩，永不可兑现</div>
  </div>
</template>

<style scoped>
.lb { padding-bottom: 80px; }
.lb-tabs {
  display: flex; gap: 8px; padding: 14px 16px 0;
}
.lb-tab {
  flex: 1; padding: 10px 2px; border-radius: 20px; font-size: 13px; font-weight: 700;
  white-space: nowrap;
  color: var(--text-dim); background: var(--bg-card); border: 1px solid var(--border);
  transition: color .15s, background .15s, border-color .15s;
}
.lb-tab.on { color: #fff; background: var(--brand-gradient); border-color: var(--blue); }
.lb-hint { font-size: 13px; padding: 9px 16px 0; }

.card { margin: 12px 16px; }
.empty { text-align: center; padding: 40px 10px; font-size: 15px; }

.row {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 4px; border-top: 1px solid var(--border);
}
.row:first-child { border-top: none; }
.row.me {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
  border-radius: 10px;
}
.row.top .name { font-weight: 800; }

/* ── §E 名次配色：前三各异(金/银/铜) / 4-6 同色 / 其余默认 ── */
.row.rk1, .row.rk2, .row.rk3, .row.rk46 {
  border-top-color: transparent;
  border-radius: 10px;
  padding-left: 9px; padding-right: 9px;
  margin-bottom: 6px;
}
.row.rk1 {
  background: linear-gradient(90deg, rgba(245, 179, 1, 0.20), rgba(245, 179, 1, 0.04));
  border-left: 4px solid #f5b301;
}
.row.rk1 .name { font-weight: 900; font-size: 16px; color: #b8860b; }
.row.rk1 .medal { font-size: 23px; }
.row.rk2 {
  background: linear-gradient(90deg, rgba(150, 160, 175, 0.22), rgba(150, 160, 175, 0.05));
  border-left: 4px solid #9aa3b2;
}
.row.rk2 .name { font-weight: 800; color: #5f6775; }
.row.rk2 .medal { font-size: 21px; }
.row.rk3 {
  background: linear-gradient(90deg, rgba(205, 127, 50, 0.18), rgba(205, 127, 50, 0.04));
  border-left: 4px solid #cd7f32;
}
.row.rk3 .name { font-weight: 800; color: #a0673a; }
.row.rk46 {
  background: rgba(93, 220, 213, 0.09);
  border-left: 3px solid var(--blue);
}
.row.rkrest { }

.rk { width: 26px; flex: 0 0 auto; text-align: center; }
.medal { font-size: 20px; }
.rk-num { font-size: 15px; font-weight: 700; color: var(--text-faint); }
.emoji { font-size: 26px; flex: 0 0 auto; }
.who { flex: 1; min-width: 0; }
.name {
  font-size: 15px; font-weight: 700;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.me-tag {
  display: inline-block; font-size: 11px; font-weight: 700; color: #fff;
  background: var(--brand-gradient); border-radius: 6px; padding: 1px 5px; margin-left: 4px;
  vertical-align: middle;
}
.sub { font-size: 13px; margin-top: 3px; }
.sub .dot { margin-right: 2px; }
.val { font-size: 14px; font-weight: 800; flex: 0 0 auto; text-align: right; }

.foot { text-align: center; font-size: 12px; padding: 6px 16px 0; }

/* 老赖榜 */
.dead-sec { font-size: 14px; font-weight: 800; margin-bottom: 8px; color: var(--text); }
.dead-row {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 4px; border-top: 1px solid var(--border);
}
.dead-row:first-of-type { border-top: none; }
.dead-row.me { background: rgba(93, 220, 213, 0.14); border-radius: 10px; padding-left: 8px; padding-right: 8px; }
.tag-owe {
  display: inline-block; font-size: 11px; font-weight: 700; color: #fff;
  background: var(--red); border-radius: 6px; padding: 1px 5px; margin-left: 4px; vertical-align: middle;
}
.overdue { font-size: 13px; font-weight: 800; color: var(--red); flex: 0 0 auto; text-align: right; }
.rep-val { font-size: 13px; font-weight: 800; color: #ffae42; flex: 0 0 auto; text-align: right; }
.lb-slogan {
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  margin: 2px 16px 8px;
  background: var(--brand-text-gradient);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
</style>
