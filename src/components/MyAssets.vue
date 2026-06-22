<script setup>
import { ref, computed } from 'vue'
import {
  store, me, resetAll, getRivals, myStats, setMyEmoji, setMyPrivacy,
  canClaimWeeklySupply, claimWeeklySupply, supplyCountdownMs, resetSeason, transferPoints,
  EMOJIS,
} from '../store.js'
import { getRank } from '../core/rank.js'
import { SUPPLY_AMOUNT, TRANSFER_LIMIT } from '../core/economy.js'

const emit = defineEmits(['back', 'open'])

const m = computed(() => me() || {})
const rank = computed(() => getRank({ wins: m.value.wins || 0, losses: m.value.losses || 0 }))
const stats = computed(() => myStats())
const rivals = computed(() => getRivals())

// 展开的对手（点开看 1v1 明细）。
const openRival = ref(null)
function toggleRival(name) {
  openRival.value = openRival.value === name ? null : name
}

const showEmojiPicker = ref(false)
function pickEmoji(e) {
  setMyEmoji(e)
  showEmojiPicker.value = false
}

// P-0.5 隐私开关（读 m 响应式，切换走 store 写入口）。
const myPrivacy = computed(() => !!m.value.privacy)
function togglePrivacy() {
  setMyPrivacy(!myPrivacy.value)
}

function fmt(n) {
  return Math.round(n).toLocaleString('en-US')
}
function fmtTime(ts) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
function pct(r) {
  return (r * 100).toFixed(0) + '%'
}
function pmStatusLabel(b) {
  if (b.status === 'won') return '押中'
  if (b.status === 'lost') return '落空'
  return '待揭晓'
}
function leadText(lead) {
  if (lead > 0) return `领先 ${lead}`
  if (lead < 0) return `落后 ${-lead}`
  return '战平'
}

// ── 战绩卡出图（§5.12 晒朋友圈/小红书）──
// 合规红线：卡上只放战绩，绝不放"快来玩/扫码/兑现/赢钱"等邀请或兑现字样。
const cardRef = ref(null)
const showCard = ref(false)
const exporting = ref(false)

function openCard() {
  showCard.value = true
}
function closeCard() {
  showCard.value = false
}

async function exportCard() {
  if (!cardRef.value || exporting.value) return
  exporting.value = true
  try {
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(cardRef.value, {
      backgroundColor: '#0a0b0d',
      scale: 2, // 高清
      useCORS: true,
    })
    const url = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `战绩卡_${m.value.name || '玩家'}.png`
    a.click()
  } catch (e) {
    alert('生成战绩卡失败了，稍后再试：' + (e?.message || e))
  } finally {
    exporting.value = false
  }
}

function doReset() {
  if (confirm('确定要清空所有数据、重置为 100 万积分吗？')) resetAll()
}
function doLogout() {
  if (confirm('退出登录会清空本机账号与全部数据，确定？')) resetAll()
}

// ── S9 周补给（§5.11：每周补 2 万）──
const supplyBump = ref(0) // 领取后强制重算可领状态
const canClaim = computed(() => (supplyBump.value, canClaimWeeklySupply()))
const supplyAmt = SUPPLY_AMOUNT
function claimSupply() {
  const got = claimWeeklySupply()
  supplyBump.value++
  if (got > 0) alert(`领到本周补给 +${got.toLocaleString('en-US')} 积分（虚拟娱乐，不可兑现）`)
}
function nextSupplyText() {
  const ms = supplyCountdownMs()
  const days = Math.floor(ms / 86400000)
  const hrs = Math.floor((ms % 86400000) / 3600000)
  if (days > 0) return `${days} 天 ${hrs} 小时后可领`
  if (hrs > 0) return `${hrs} 小时后可领`
  const min = Math.max(1, Math.floor(ms / 60000))
  return `${min} 分钟后可领`
}

// ── S9 赛季年度重置（§5.11）──
function doResetSeason() {
  if (
    confirm(
      '确定开启新赛季吗？\n本赛季战绩将归档，积分重置为 100 万、战绩与连胜清零，账号与信誉保留。此操作不可撤销。'
    )
  ) {
    resetSeason()
    supplyBump.value++
  }
}

// ── S9 积分转赠（§5.11，合规敏感）──
const showTransfer = ref(false)
const transferTo = ref('')
const transferAmt = ref('')
const transferLimit = TRANSFER_LIMIT
const npcList = computed(() => store.players.filter((p) => !p.isMe && p.name))
function openTransfer() {
  transferTo.value = npcList.value[0]?.name || ''
  transferAmt.value = ''
  showTransfer.value = true
}
function doTransfer() {
  const res = transferPoints({ toName: transferTo.value, amount: transferAmt.value })
  if (!res.ok) {
    alert(res.error || '转赠失败')
    return
  }
  alert(`已转赠 ${res.amount.toLocaleString('en-US')} 积分给 ${res.toName}（虚拟娱乐·不可兑现）`)
  showTransfer.value = false
}
</script>

<template>
  <div>
    <!-- ── Hero 卡：头像 + 昵称 + 称号 + 段位 + 信誉 ── -->
    <div class="card hero">
      <div class="hero-top">
        <button class="avatar" @click="showEmojiPicker = !showEmojiPicker">{{ m.emoji }}</button>
        <div class="hero-id">
          <div class="hero-name">{{ m.name || '未命名' }}</div>
          <div class="hero-title muted">{{ m.title || '新人玩家' }}</div>
          <div class="badge" :style="{ color: rank.color, borderColor: rank.color }">
            {{ rank.icon }} {{ rank.name }}
          </div>
        </div>
        <div class="rep">
          <div class="rep-num">{{ m.reputation ?? 100 }}</div>
          <div class="rep-lbl muted">信誉</div>
        </div>
      </div>

      <!-- 头像选择器 -->
      <div v-if="showEmojiPicker" class="emoji-picker">
        <button
          v-for="e in EMOJIS"
          :key="e"
          class="emoji-opt"
          :class="{ on: e === m.emoji }"
          @click="pickEmoji(e)"
        >{{ e }}</button>
      </div>
    </div>

    <!-- ── 核心数据 ── -->
    <div class="card big">
      <div class="bal-row">
        <div>
          <div class="lbl muted">可用积分</div>
          <div class="num">{{ fmt(store.balance) }}</div>
        </div>
        <div class="frozen-box">
          <div class="lbl muted">冻结中</div>
          <div class="frozen">{{ fmt(store.frozen) }}</div>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-num">{{ stats.wins }}<span class="sep">/</span>{{ stats.losses }}</div>
          <div class="stat-lbl muted">总胜负</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ stats.total ? pct(stats.winRate) : '—' }}</div>
          <div class="stat-lbl muted">胜率</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ stats.curStreak > 0 ? '🔥' + stats.curStreak : '—' }}</div>
          <div class="stat-lbl muted">当前连胜</div>
        </div>
        <div class="stat">
          <div class="stat-num gold">{{ stats.bestWinOdds > 0 ? stats.bestWinOdds.toFixed(2) : '—' }}</div>
          <div class="stat-lbl muted">最神预测</div>
        </div>
      </div>

      <!-- 周补给 + 转赠（S9 §5.11） -->
      <div class="econ-row">
        <button v-if="canClaim" class="btn supply-btn" @click="claimSupply">
          🎁 领本周补给 +{{ supplyAmt.toLocaleString('en-US') }}
        </button>
        <button v-else class="btn supply-btn done" disabled>
          ✅ 本周已领 · {{ nextSupplyText() }}
        </button>
        <button class="btn ghost transfer-btn" @click="openTransfer">↗ 转赠</button>
      </div>
      <div class="econ-note faint">虚拟娱乐积分，永不可兑现 · 不对应现实金钱</div>
    </div>

    <!-- ── 总战绩卡 ── -->
    <div class="card">
      <div class="sec-title">总战绩</div>
      <div class="totrow">
        <span class="muted">已结算 {{ stats.total }} 单</span>
        <span class="muted">最大连胜 🔥{{ stats.maxStreak }}</span>
        <span class="muted">最神赔率 {{ stats.bestWinOdds > 0 ? stats.bestWinOdds.toFixed(2) : '—' }}</span>
      </div>
      <button class="btn block share-btn" @click="openCard">📸 生成战绩卡</button>
    </div>

    <!-- ── 我和谁的恩怨（对战史） ── -->
    <div class="card">
      <div class="sec-title">我和谁的恩怨（{{ rivals.length }}）</div>
      <div v-if="rivals.length === 0" class="muted small">还没和谁结过账，去开一盘吧</div>
      <div v-for="r in rivals" :key="r.name" class="rival">
        <div class="rival-head" @click="toggleRival(r.name)">
          <span class="rival-emoji">{{ r.emoji }}</span>
          <span class="rival-name">{{ r.name }}</span>
          <span class="rival-record">我 {{ r.wins }} 胜 {{ r.losses }} 负</span>
          <span
            class="rival-lead"
            :class="{ up: r.lead > 0, down: r.lead < 0 }"
          >{{ leadText(r.lead) }}</span>
          <span class="caret">{{ openRival === r.name ? '▾' : '▸' }}</span>
        </div>
        <div v-if="openRival === r.name" class="rival-hist">
          <div v-for="h in r.history" :key="h.matchId" class="hist-line">
            <span class="hist-res" :class="h.iWon ? 'win' : 'lose'">{{ h.iWon ? '胜' : '负' }}</span>
            <span class="hist-kind" :class="h.type === 'offline' ? 'offline' : 'predict'">
              {{ h.type === 'offline' ? '🏓 打球' : '🎯 对赌' }}
            </span>
            <span class="hist-title">{{ h.title }}</span>
            <span class="hist-time muted">{{ fmtTime(h.at) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 我的对赌 / Polymarket（保留入口） ── -->
    <div class="card">
      <div class="sec-title">我的对赌（{{ store.matches.length }}）</div>
      <div v-if="store.matches.length === 0" class="muted small">暂无</div>
      <div
        v-for="mt in store.matches"
        :key="mt.id"
        class="line"
        @click="emit('open', 'match', { id: mt.id })"
      >
        <div class="line-main">{{ mt.title }}</div>
        <div class="line-sub muted">
          {{ mt.mode === 'banker' ? '坐庄' : mt.mode === 'pool' ? '彩池' : '约赌' }} ·
          {{ mt.status === 'settled' ? '已结算 · ' + (mt.result === 'A' ? mt.optionA : mt.optionB) : (mt.status === 'open' ? '待接盘' : '已匹配') }}
          · {{ mt.mode === 'banker' ? '保证金' : '下注' }} {{ fmt(mt.ownerStake) }}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="sec-title">系统盘押注（{{ store.pmBets.length }}）</div>
      <div v-if="store.pmBets.length === 0" class="muted small">暂无</div>
      <div v-for="b in store.pmBets" :key="b.id" class="line">
        <div class="line-main">
          {{ b.eventTitle }}
          <span class="pm-stat" :class="b.status">{{ pmStatusLabel(b) }}</span>
        </div>
        <div class="line-sub muted">
          押 {{ b.zhOutcome || b.outcome }} · {{ fmt(b.stake) }} · 赔率 {{ b.odds.toFixed(2) }}
          <template v-if="b.status === 'won'"> · 派彩 +{{ fmt(b.payout) }}</template>
          <template v-else-if="b.status === 'lost'"> · 落空 -{{ fmt(b.stake) }}</template>
          · {{ fmtTime(b.at) }}
        </div>
      </div>
    </div>

    <!-- ── 战绩卡出图弹层（§5.12） ── -->
    <div v-if="showCard" class="card-mask" @click.self="closeCard">
      <div class="card-sheet">
        <!-- 被截图的深色 Polymarket 风战绩卡：只放战绩，无任何邀请/兑现字样 -->
        <div ref="cardRef" class="trophy-card">
          <div class="tc-brand">beeeeet · 買定離手战绩卡</div>
          <div class="tc-head">
            <div class="tc-avatar">{{ m.emoji }}</div>
            <div class="tc-id">
              <div class="tc-name">{{ m.name || '未命名' }}</div>
              <div class="tc-badge" :style="{ color: rank.color, borderColor: rank.color }">
                {{ rank.icon }} {{ rank.name }}
              </div>
            </div>
          </div>
          <div class="tc-grid">
            <div class="tc-cell">
              <div class="tc-num">{{ stats.total ? pct(stats.winRate) : '—' }}</div>
              <div class="tc-lbl">胜率</div>
            </div>
            <div class="tc-cell">
              <div class="tc-num">{{ stats.wins }}<span class="tc-sep">/</span>{{ stats.losses }}</div>
              <div class="tc-lbl">胜 / 负</div>
            </div>
            <div class="tc-cell">
              <div class="tc-num fire">🔥{{ stats.maxStreak }}</div>
              <div class="tc-lbl">最大连胜</div>
            </div>
            <div class="tc-cell">
              <div class="tc-num gold">{{ stats.bestWinOdds > 0 ? stats.bestWinOdds.toFixed(2) : '—' }}</div>
              <div class="tc-lbl">最神预测</div>
            </div>
          </div>
          <div class="tc-wealth">
            <span class="tc-wlbl">身家</span>
            <span class="tc-wnum">{{ fmt(store.balance) }} 积分</span>
          </div>
        </div>

        <div class="card-actions">
          <button class="btn block" :disabled="exporting" @click="exportCard">
            {{ exporting ? '生成中…' : '保存图片' }}
          </button>
          <button class="btn ghost block" @click="closeCard">关闭</button>
        </div>
      </div>
    </div>

    <!-- ── 积分转赠弹层（S9 §5.11，合规敏感） ── -->
    <div v-if="showTransfer" class="tf-mask" @click.self="showTransfer = false">
      <div class="tf-sheet">
        <div class="tf-hd">
          <span class="tf-title">↗ 转赠积分</span>
          <button class="tf-close" @click="showTransfer = false">✕</button>
        </div>
        <div class="tf-compliance">
          ⚠️ 仅熟人人情 / 还赌债的积分版。<b>平台不背书任何现实对价，积分不可兑现、不对应现实金钱，非积分买卖市场。</b>
        </div>
        <label class="tf-lbl">转给谁</label>
        <select v-model="transferTo" class="tf-select">
          <option v-for="p in npcList" :key="p.id" :value="p.name">{{ p.emoji }} {{ p.name }}</option>
        </select>
        <label class="tf-lbl">转赠金额（单笔上限 {{ transferLimit.toLocaleString('en-US') }}）</label>
        <input
          v-model="transferAmt"
          class="tf-input"
          type="number"
          inputmode="numeric"
          :max="transferLimit"
          placeholder="例如 10000"
        />
        <div class="tf-bal faint">可用积分 {{ fmt(store.balance) }}</div>
        <button class="btn block" @click="doTransfer">确认转赠</button>
        <button class="btn ghost block" @click="showTransfer = false">取消</button>
      </div>
    </div>

    <!-- ── 设置区（低频收底部） ── -->
    <div class="settings">
      <!-- P-0.5 隐私开关：别人在朋友页看不到我的最近赌局/动态 -->
      <button class="btn ghost block" @click="togglePrivacy">
        {{ myPrivacy ? '🔒 已对朋友隐藏我的最近赌局（点击公开）' : '🌐 我的最近赌局对朋友可见（点击隐藏）' }}
      </button>
      <button class="btn ghost block season-btn" @click="doResetSeason">🗓️ 开启新赛季（年度重置）</button>
      <button class="btn ghost block" @click="doReset">重置全部数据</button>
      <button class="btn ghost block danger" @click="doLogout">退出登录</button>
    </div>
  </div>
</template>

<style scoped>
/* Hero */
.hero { padding: 16px; }
.hero-top { display: flex; align-items: center; gap: 14px; }
.avatar {
  width: 56px; height: 56px; border-radius: 50%;
  background: var(--bg-card-2); border: 1px solid var(--border);
  font-size: 30px; display: flex; align-items: center; justify-content: center;
  flex: 0 0 auto;
}
.hero-id { flex: 1; min-width: 0; }
.hero-name { font-size: 18px; font-weight: 800; }
.hero-title { font-size: 12px; margin: 2px 0 6px; }
.badge {
  display: inline-block; font-size: 12px; font-weight: 700;
  border: 1px solid; border-radius: 20px; padding: 3px 10px;
}
.rep { text-align: center; flex: 0 0 auto; }
.rep-num { font-size: 22px; font-weight: 800; color: var(--amber); }
.rep-lbl { font-size: 11px; }
.emoji-picker {
  display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px;
  border-top: 1px solid var(--border); padding-top: 12px;
}
.emoji-opt {
  width: 38px; height: 38px; border-radius: 10px; font-size: 22px;
  background: var(--bg-card-2); border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
}
.emoji-opt.on { border-color: var(--blue); }

/* 核心数据 */
.card.big { padding: 18px; }
.bal-row { display: flex; align-items: flex-end; justify-content: space-between; }
.lbl { font-size: 12px; }
.num { font-size: 32px; font-weight: 800; color: var(--green); margin-top: 4px; }
.frozen-box { text-align: right; }
.frozen { font-size: 16px; font-weight: 700; color: var(--text-dim); margin-top: 4px; }
.stat-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
  margin-top: 16px; border-top: 1px solid var(--border); padding-top: 14px;
}
.stat { text-align: center; }
.stat-num { font-size: 16px; font-weight: 800; }
.stat-num .sep { color: var(--text-faint); margin: 0 1px; font-weight: 600; }
.stat-num.gold { color: var(--amber); }
.stat-lbl { font-size: 11px; margin-top: 3px; }

/* 总战绩 */
.totrow { display: flex; flex-wrap: wrap; gap: 10px 16px; font-size: 13px; }

/* 对战史 */
.sec-title { font-size: 14px; font-weight: 700; margin-bottom: 10px; }
.small { font-size: 13px; }
.rival { border-top: 1px solid var(--border); }
.rival:first-of-type { border-top: none; }
.rival-head {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 0; cursor: pointer;
}
.rival-emoji { font-size: 20px; flex: 0 0 auto; }
.rival-name { font-weight: 700; font-size: 14px; flex: 0 0 auto; }
.rival-record { font-size: 12px; color: var(--text-dim); flex: 1; }
.rival-lead { font-size: 12px; font-weight: 700; color: var(--text-dim); }
.rival-lead.up { color: var(--green); }
.rival-lead.down { color: var(--red); }
.caret { color: var(--text-faint); font-size: 12px; width: 14px; text-align: right; }
.rival-hist { padding: 0 0 10px 28px; }
.hist-line {
  display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 12px;
}
.hist-res {
  flex: 0 0 auto; font-weight: 800; width: 22px; height: 18px;
  border-radius: 4px; text-align: center; line-height: 18px; font-size: 11px;
}
.hist-res.win { color: var(--green); background: var(--green-bg); }
.hist-res.lose { color: var(--red); background: var(--red-bg); }
.hist-kind {
  flex: 0 0 auto; font-size: 10px; font-weight: 700; padding: 1px 5px;
  border-radius: 4px; white-space: nowrap;
}
.hist-kind.predict { color: var(--blue); background: var(--blue-dim); }
.hist-kind.offline { color: var(--green); background: var(--green-bg); }
.hist-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-time { flex: 0 0 auto; font-size: 11px; }

/* 列表通用 */
.line { border-top: 1px solid var(--border); padding: 10px 0; cursor: pointer; }
.line:first-of-type { border-top: none; }
.line-main { font-size: 14px; font-weight: 600; }
.line-sub { font-size: 12px; margin-top: 3px; }
.pm-stat { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; margin-left: 6px; vertical-align: middle; }
.pm-stat.pending { color: var(--amber); background: var(--amber-bg); }
.pm-stat.won { color: var(--green); background: var(--green-bg); }
.pm-stat.lost { color: var(--red); background: var(--red-bg); }

/* 设置区 */
.settings { display: flex; flex-direction: column; gap: 10px; margin: 16px; }
.settings .danger { color: var(--red); }
.season-btn { color: var(--blue); }

/* 周补给 + 转赠（S9） */
.econ-row {
  display: flex; gap: 8px; margin-top: 16px;
  border-top: 1px solid var(--border); padding-top: 14px;
}
.supply-btn { flex: 1; font-weight: 700; }
.supply-btn.done { background: var(--bg-card-2); color: var(--text-dim); opacity: 1; font-weight: 600; }
.transfer-btn { flex: 0 0 auto; padding-left: 16px; padding-right: 16px; }
.econ-note { font-size: 11px; text-align: center; margin-top: 8px; }

/* 转赠弹层 */
.tf-mask {
  position: fixed; inset: 0; z-index: 60; background: rgba(15, 35, 48, 0.34);
  backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center; padding: 24px 16px;
}
.tf-sheet {
  width: 100%; max-width: 360px; background: var(--bg-card);
  border: 1px solid var(--border); border-radius: var(--radius); padding: 16px;
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.16);
}
.tf-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.tf-title { font-size: 16px; font-weight: 800; }
.tf-close { color: var(--text-dim); font-size: 16px; padding: 2px 6px; }
.tf-compliance {
  font-size: 12px; line-height: 1.5; color: var(--text-dim);
  background: var(--red-bg, rgba(255,80,80,0.08)); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 12px; margin-bottom: 14px;
}
.tf-lbl { display: block; font-size: 12px; color: var(--text-dim); margin: 10px 0 5px; }
.tf-select, .tf-input {
  width: 100%; box-sizing: border-box; background: var(--bg-card-2);
  border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
  color: var(--text); font-size: 15px;
}
.tf-bal { font-size: 12px; margin: 8px 0 14px; }

/* 战绩卡出图 */
.share-btn { margin-top: 12px; }
.card-mask {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(15, 35, 48, 0.34);
  backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center;
  padding: 24px 16px;
}
.card-sheet { width: 100%; max-width: 360px; }

.trophy-card {
  background:
    linear-gradient(180deg, rgba(93, 220, 213, 0.08), rgba(255, 255, 255, 0) 38%),
    var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 22px 20px;
  color: var(--text);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.14);
}
.tc-brand {
  font-size: 13px; font-weight: 800; letter-spacing: 0.5px;
  color: var(--blue); margin-bottom: 16px;
}
.tc-head { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
.tc-avatar {
  width: 58px; height: 58px; border-radius: 50%;
  background: var(--bg-card-2); border: 1px solid var(--border);
  font-size: 32px; display: flex; align-items: center; justify-content: center;
  flex: 0 0 auto;
}
.tc-id { flex: 1; min-width: 0; }
.tc-name { font-size: 20px; font-weight: 800; }
.tc-badge {
  display: inline-block; font-size: 12px; font-weight: 700;
  border: 1px solid; border-radius: 20px; padding: 3px 10px; margin-top: 6px;
}
.tc-grid {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;
}
.tc-cell {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border); border-radius: 10px;
  padding: 12px; text-align: center;
}
.tc-num { font-size: 22px; font-weight: 800; }
.tc-num .tc-sep { color: var(--text-faint); margin: 0 2px; font-weight: 600; }
.tc-num.gold { color: var(--amber); }
.tc-num.fire { color: var(--amber); }
.tc-lbl { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
.tc-wealth {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border);
}
.tc-wlbl { font-size: 13px; color: var(--text-dim); }
.tc-wnum { font-size: 18px; font-weight: 800; color: var(--green); }

.card-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.card-actions .btn[disabled] { opacity: 0.6; }
</style>
