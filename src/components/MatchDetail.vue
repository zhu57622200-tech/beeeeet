<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { store, addComment, settleMatchStore, npcJoin, cancelMatch, npcBetBanker, npcBetPool, myJoinPool, markSideBetFulfilled, nagSideBet, sideBetOverdue, fileAppeal, resolveAppealStore, reportCheat, revealWithDispute, castConsensusVote, arbiterCandidates, inviteArbiter, arbiterVerdict, refreshMatchDetail, acceptInboxInvite, isOnline } from '../store.js'
import { settleMatch } from '../core/wager.js'
import { countUp, prefersReducedMotion } from '../core/countup.js'
import { SLOGAN_WIN, SLOGAN_LOSE } from '../core/slogans.js'
import { formatCountdown, isSettleOverdue, tallyConsensus } from '../core/governance.js'
import { roastSettle } from '../api.js'

const props = defineProps({ matchId: String })
const emit = defineEmits(['back'])

const m = computed(() => store.matches.find((x) => String(x.id) === String(props.matchId)))
const err = ref('')
const commentText = ref('')

// 联机视角：这局是不是我开的（旧本地数据无 ownerId，视为我开的保持原行为）
const online = isOnline() // 联机模式：单机假人交互入口（喊NPC来接/押）一律隐藏
const isOwner = computed(() => !m.value?.ownerId || String(m.value.ownerId) === String(store.currentId))
const isTaker = computed(() => m.value?.takerId != null && String(m.value.takerId) === String(store.currentId))
// 围观者接盘需押额 = ownerStake × (odds − 1)，与后端 takerStakeFor 口径一致
const takerStakeNeeded = computed(() => (m.value ? Math.round((m.value.ownerStake || 0) * ((m.value.odds || 2) - 1)) : 0))
const taking = ref(false)
function doTake() {
  if (!m.value || taking.value) return
  taking.value = true
  err.value = ''
  Promise.resolve(acceptInboxInvite(m.value.id))
    .catch((e) => { err.value = e?.message || '接盘失败' })
    .finally(() => { taking.value = false })
}

// 盘内 10s 轮询（§7）：整页拉详情（留言/接盘/结算实时跟上），隐藏页由浏览器节流兜底
let detailTimer = null
onMounted(() => {
  refreshMatchDetail(props.matchId)
  detailTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') refreshMatchDetail(props.matchId)
  }, 10_000)
})
onUnmounted(() => {
  if (detailTimer) clearInterval(detailTimer)
})

// —— S6 揭晓特效 + 毒舌庄家解说 ——
const fxKind = ref('') // '' | 'win' | 'lose'：触发一次结算动画
const roast = ref('') // 毒舌解说文本
const roastLoading = ref(false)

// 监听本局状态：matched → settled 时放特效并拉取毒舌解说（异步，不阻塞）。
watch(
  () => m.value?.status,
  (now, prev) => {
    if (now === 'settled' && prev && prev !== 'settled') {
      const iWon = iWonMatch()
      triggerFx(iWon ? 'win' : 'lose')
      loadRoast()
    }
  }
)

let fxTimer = null
let cancelNetCount = null
const shownNet = ref(0) // 赢局金额滚动显示值（动画期间用，结束后回真实 myNet）
function triggerFx(kind) {
  if (fxTimer) clearTimeout(fxTimer)
  cancelNetCount?.()
  fxKind.value = kind
  fxTimer = setTimeout(() => { fxKind.value = '' }, 2200)
  if (kind === 'win') {
    const target = Math.max(0, myNet.value)
    if (prefersReducedMotion()) { shownNet.value = target; return }
    shownNet.value = 0
    cancelNetCount = countUp(0, target, 900, (v) => { shownNet.value = v })
  }
}
onUnmounted(() => { // 离开本局清理特效计时器/RAF，防对已卸载实例写入
  if (fxTimer) clearTimeout(fxTimer)
  cancelNetCount?.()
})
// 结算大字显示值：赢局动画期间滚动，其余时刻显示真实净值
const displayNet = computed(() => (fxKind.value === 'win' ? shownNet.value : myNet.value))

async function loadRoast() {
  if (!m.value) return
  roastLoading.value = true
  roast.value = ''
  const iWon = iWonMatch()
  try {
    roast.value = await roastSettle({
      title: m.value.title,
      ownerSideLabel: mode.value === 'banker' ? '庄家' : ownerSideLabel.value,
      resultLabel: m.value.result === 'A' ? m.value.optionA : m.value.optionB,
      iWon,
      takerName: m.value.takerName,
    })
  } finally {
    roastLoading.value = false
  }
}

// 金币雨 emoji（赢时漂落，金币为主）。
const confetti = ['🪙', '💰', '🪙', '✨', '🪙', '💎', '🏆', '🪙', '🤑', '🪙']

// 撤盘后该局被移除，m.value 变 undefined；computed 仍可能被求值，故全部判空兜底。
const ownerSideLabel = computed(() => (m.value?.ownerSide === 'A' ? m.value?.optionA : m.value?.optionB))
const takerSideLabel = computed(() => (m.value?.ownerSide === 'A' ? m.value?.optionB : m.value?.optionA))
const pot = computed(() => (m.value ? m.value.ownerStake + (m.value.takerJoined ? m.value.takerStake : 0) : 0))
const potentialWin = computed(() => (m.value ? pot.value - m.value.ownerStake : 0)) // 押中净赚

// —— S7 三玩法 ——
const mode = computed(() => m.value?.mode || 'match')

// 坐庄：押注汇总。
const bankerBets = computed(() => m.value?.bets || [])
const bankerPoolBySide = computed(() => {
  const s = { A: 0, B: 0 }
  bankerBets.value.forEach((b) => { s[b.side] += b.stake })
  return s
})

// 彩池：两边池总额 + 实时动态赔率（赔率 = 总池 / 本边池）。
const poolA = computed(() => m.value?.pool?.A || [])
const poolB = computed(() => m.value?.pool?.B || [])
const poolSum = computed(() => ({
  A: poolA.value.reduce((s, b) => s + b.stake, 0),
  B: poolB.value.reduce((s, b) => s + b.stake, 0),
}))
const poolTotal = computed(() => poolSum.value.A + poolSum.value.B)
function poolOdds(side) {
  const own = poolSum.value[side]
  return own > 0 ? (poolTotal.value / own).toFixed(2) : '—'
}

// 我在彩池里押的边（开盘那一注，用于高亮）。
const myPoolSide = computed(() => m.value?.ownerSide)

// 站队下注额输入。
const joinStake = ref(10000)
function joinPool(side) {
  err.value = ''
  try {
    const r = myJoinPool(m.value.id, side, Number(joinStake.value))
    if (r && typeof r.then === 'function') r.catch((e) => { err.value = e?.message || '下注失败' })
  } catch (e) {
    err.value = e.message || '下注失败'
  }
}

// 喊人来押（坐庄/彩池），制造热度。
function callBettor() {
  if (online || !m.value) return // 联机：等真人来押，按钮已隐藏
  if (mode.value === 'banker') npcBetBanker(m.value.id)
  else if (mode.value === 'pool') npcBetPool(m.value.id)
  else npcJoin(m.value.id)
}

// §A 揭晓改为「提议 → 投票 → 达阈值落账」（三玩法统一）：
// 点「结果是 X」= 发起提议（我自动同意一票），再驱动假人参与者随机延时自动投票。
// 够票则 store 内部落账；僵局则出现仲裁按钮。中间态不碰积分（守恒）。
function startReveal(resultSide) {
  if (!m.value) return
  err.value = ''
  // 联机：API 揭晓为异步 Promise，错误透给 UI；单机假人路径保持原逻辑
  const r = revealWithDispute(m.value.id, resultSide)
  if (r && typeof r.then === 'function') {
    r.catch((e) => { err.value = e?.message || '揭晓失败' })
    return
  }
  if (!r || !r.disputed) return // 无异议 → 已直接结算，结算卡自动显示
  // 有异议 → 驱动假人陆续表态（异议者反对、其余同意），复用投票面板
  const meName = store.players.find((p) => p.isMe)?.name || '我'
  m.value.consensus.voters
    .filter((v) => v !== meName)
    .forEach((v, i) => {
      const vote = r.disputers.includes(v) ? 'reject' : 'agree'
      setTimeout(() => castConsensusVote(m.value.id, v, vote), 500 + Math.random() * 1000 + i * 400)
    })
}
// 僵局时可邀请的评审候选（没参与本局的人）。
const arbiterCandsRef = ref([])
const arbiterCands = computed(() => {
  if (!m.value) return []
  const r = arbiterCandidates(m.value.id)
  if (r && typeof r.then === 'function') { // 联机：异步拉取，先回空数组下一渲染补上
    r.then((list) => { arbiterCandsRef.value = Array.isArray(list) ? list : (list?.users || []) }).catch(() => {})
    return arbiterCandsRef.value
  }
  return r
})
// 邀请某人当评审：假人版下被邀评审稍后自动裁定（真人版换成真人收到请求后点裁定）。
function inviteAsArbiter(name) {
  if (!m.value) return
  const r = inviteArbiter(m.value.id, name)
  if (r && typeof r.then === 'function') { r.catch((e) => { err.value = e?.message || '邀请仲裁失败' }); return }
  setTimeout(() => arbiterVerdict(m.value.id), 800 + Math.random() * 800) // 单机假人自动裁定
}
// 当前提议的实时计票（投票面板用）。
const consensusTally = computed(() => {
  const c = m.value?.consensus
  if (!c) return { agree: 0, reject: 0, threshold: 0, pending: 0 }
  return tallyConsensus({ votes: c.votes, voters: c.voters, rule: c.rule })
})
// 提议一发起就把共识投票面板滚到视野中央，避免被上面的押注卡挡住没看见。
watch(
  () => !!m.value?.consensus,
  (has) => {
    if (has) nextTick(() => document.querySelector('.consensus-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }
)

// 我作为庄家/彩池参与者本局净盈亏（已结算后展示）。
const myNet = computed(() => {
  if (!m.value || m.value.status !== 'settled') return 0
  if (mode.value === 'banker') {
    if (m.value.bankerPnl != null) return m.value.bankerPnl
    // 联机：庄家净盈亏 = Σ(押注者注金 − 派彩)；非庄家按自己的注算
    const bets = m.value.bets || []
    if (isOwner.value) return bets.reduce((s, b) => s + (b.stake - (b.payout || 0)), 0)
    const mine = bets.filter((b) => (b.userId != null ? String(b.userId) === String(store.currentId) : !b.npc))
    return mine.reduce((s, b) => s + ((b.payout || 0) - b.stake), 0)
  }
  if (mode.value === 'pool') {
    const myBets = [...poolA.value, ...poolB.value].filter((b) => (b.userId != null ? String(b.userId) === String(store.currentId) : !b.npc))
    const stake = myBets.reduce((s, b) => s + b.stake, 0)
    const payout = myBets.reduce((s, b) => s + (b.payout || 0), 0)
    return payout - stake
  }
  // match 约赌按视角算：开盘人赢拿对方注/输亏自己注；接盘人反之；局外人 0（联机视角修正）
  const ownerWon = m.value.result === m.value.ownerSide
  if (isOwner.value) return ownerWon ? potentialWin.value : -m.value.ownerStake
  if (isTaker.value) return ownerWon ? -(m.value.takerStake || 0) : (m.value.ownerStake || 0)
  return 0
})

// 本局"我"是否赢（跨三玩法统一口径，给特效/解说用）。
function iWonMatch() {
  if (!m.value) return false
  if (mode.value === 'match') {
    const ownerWon = m.value.result === m.value.ownerSide
    return isOwner.value ? ownerWon : isTaker.value ? !ownerWon : ownerWon
  }
  return myNet.value >= 0
}

function callFriend() {
  if (online || !m.value) return // 联机：等真人来接，按钮已隐藏
  npcJoin(m.value.id)
}
function withdraw() {
  err.value = ''
  const r = cancelMatch(m.value.id)
  if (r && typeof r.then === 'function') {
    r.then(() => emit('back')).catch((e) => { err.value = e?.message || '撤盘失败' })
    return
  }
  emit('back')
}
const replyTo = ref(null)
function startReply(c) {
  replyTo.value = c
  const mention = `@${c.by} `
  if (!commentText.value.trim().startsWith(mention)) commentText.value = mention + commentText.value.trimStart()
}
function cancelReply() {
  replyTo.value = null
  commentText.value = commentText.value.replace(/^@\S+\s*/, '')
}
function doComment() {
  const text = commentText.value.trim()
  if (!text) return
  const replyId = replyTo.value?.id || null
  const r = addComment(m.value.id, text, replyId)
  commentText.value = ''
  replyTo.value = null
  if (r && typeof r.then === 'function') {
    r.catch((e) => { commentText.value = text; replyTo.value = replyId ? m.value.comments.find((c) => c.id === replyId) : null; err.value = e?.message || '发送失败' })
  }
}
// （旧 reveal「点结果即直接结算」已废弃，三玩法统一走 startReveal 的共识提议流程）
function fmtTime(ts) {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

// —— S8 线下文字彩头履约 ——
// 结算后才可履约/催债；赢家看到"催债"，输家(或开盘人)看到"已还愿"。
const sbOverdue = computed(() => sideBetOverdue(m.value))
function fulfillSideBet() {
  if (m.value) markSideBetFulfilled(m.value.id)
}
function nagBet() {
  if (m.value) nagSideBet(m.value.id)
}

// —— S10 截止倒计时 + 揭晓超时提示（§5.13）——
const countdown = computed(() => formatCountdown(m.value?.deadline))
const settleOverdue = computed(() => isSettleOverdue(m.value))

// —— S10 申诉复议（§5.8，仅约赌局）——
const showAppeal = ref(false)
const appealReason = ref('')
const appealStake = ref(5000)
const appealErr = ref('')
// 本局当前申诉记录（pending 或最近一条）。
const myAppeal = computed(() => store.appeals.find((a) => a.matchId === m.value?.id))
const canAppeal = computed(
  () => m.value && m.value.status === 'settled' && mode.value === 'match' && !myAppeal.value
)
function doAppeal() {
  appealErr.value = ''
  const r = fileAppeal({
    matchId: m.value.id,
    reason: appealReason.value,
    stake: Number(appealStake.value),
  })
  if (r && typeof r.then === 'function') {
    r.then(() => { showAppeal.value = false; appealReason.value = '' })
      .catch((e) => { appealErr.value = e?.message || '申诉失败' })
    return
  }
  if (!r.ok) {
    appealErr.value = r.error || '申诉失败'
    return
  }
  showAppeal.value = false
  appealReason.value = ''
}
function adminResolve(verdict) {
  if (myAppeal.value) resolveAppealStore(myAppeal.value.id, verdict)
}

// —— S9 LOOP-2 举报耍赖（已结算局，仅约赌有明确对手）——
// 复用已有 reportCheat：发 feed + 降被举报方信誉（不新写结算逻辑）。
const showReport = ref(false)
const REPORT_REASONS = [
  { kind: 'delay', label: '拖延（迟迟不揭晓/不履约）' },
  { kind: 'misjudge', label: '乱判（结果判定不公）' },
  { kind: 'deadbeat', label: '赖账（线下彩头不还愿）' },
]
// 被举报方：约赌的对手——接盘方视角对手是开盘人，开盘方视角对手是接盘人。无对手不显示入口。
const reportTarget = computed(() => {
  if (mode.value !== 'match') return null
  return isTaker.value ? m.value?.ownerName : m.value?.takerName
})
// 被举报方的用户 id（联机举报接口要带，且必须是本局参与者）
const reportTargetId = computed(() => (isTaker.value ? m.value?.ownerId : m.value?.takerId))
// 已举报状态由 store.reportedCheats 派生：关闭详情再进仍显示「已举报」，且 store 级一局一举报去重
const reportDone = computed(
  () => !!(reportTarget.value && m.value && store.reportedCheats?.includes(m.value.id + '|' + reportTarget.value)),
)
function doReport(kind) {
  if (!reportTarget.value) return
  const rep = reportCheat(reportTargetId.value ?? reportTarget.value, kind, m.value?.id)
  if (rep !== null) showReport.value = false
}
</script>

<template>
  <div v-if="m">
    <div class="bar">
      <button class="back" @click="emit('back')">‹ 返回</button>
    </div>

    <div class="card">
      <div class="title">
        {{ m.title }}
        <span class="mode-tag" :class="mode">{{ mode === 'banker' ? '坐庄' : mode === 'pool' ? '彩池' : '约赌' }}</span>
        <span v-if="m.sideBet" class="sidebet-tag">📿 {{ m.sideBet.text }}</span>
      </div>
      <div v-if="m.deadline && m.status !== 'settled'" class="dl-line" :class="{ overdue: settleOverdue }">
        ⏰ {{ countdown }}
        <span v-if="settleOverdue" class="dl-warn"> · 已超揭晓宽限期，该叫裁判揭晓了</span>
      </div>
      <div class="vs-box">
        <div class="vs-opt" :class="{ mine: mode !== 'banker' && m.ownerSide === 'A' }">
          {{ m.optionA }}
          <span v-if="mode !== 'banker' && m.ownerSide === 'A'" class="badge">{{ isOwner ? '我押' : (m.ownerName || 'TA') + ' 押' }}</span>
        </div>
        <span class="vs-mid">VS</span>
        <div class="vs-opt" :class="{ mine: mode !== 'banker' && m.ownerSide === 'B' }">
          {{ m.optionB }}
          <span v-if="mode !== 'banker' && m.ownerSide === 'B'" class="badge">{{ isOwner ? '我押' : (m.ownerName || 'TA') + ' 押' }}</span>
        </div>
      </div>
      <!-- 约赌：原赔率/下注/奖池 -->
      <div v-if="mode === 'match'" class="grid">
        <div><span class="k">赔率</span><span class="v">{{ m.odds }}</span></div>
        <div><span class="k">{{ isOwner ? '我下注' : 'TA 下注' }}</span><span class="v">{{ m.ownerStake.toLocaleString() }}</span></div>
        <div v-if="m.takerJoined"><span class="k">对手押</span><span class="v">{{ m.takerStake.toLocaleString() }}</span></div>
        <div v-if="m.takerJoined"><span class="k">奖池</span><span class="v">{{ pot.toLocaleString() }}</span></div>
      </div>
      <!-- 坐庄：我的赔率 + 保证金封顶 + 当前敞口 -->
      <div v-else-if="mode === 'banker'" class="grid">
        <div><span class="k">我坐庄赔率</span><span class="v">{{ m.bankerOdds }}</span></div>
        <div><span class="k">保证金封顶</span><span class="v">{{ m.bankerCap.toLocaleString() }}</span></div>
        <div><span class="k">{{ m.optionA }} 收注</span><span class="v">{{ bankerPoolBySide.A.toLocaleString() }}</span></div>
        <div><span class="k">{{ m.optionB }} 收注</span><span class="v">{{ bankerPoolBySide.B.toLocaleString() }}</span></div>
      </div>
      <!-- 彩池：两边池 + 实时动态赔率 -->
      <div v-else class="grid">
        <div><span class="k">{{ m.optionA }} 池</span><span class="v">{{ poolSum.A.toLocaleString() }}</span></div>
        <div><span class="k">{{ m.optionB }} 池</span><span class="v">{{ poolSum.B.toLocaleString() }}</span></div>
        <div><span class="k">{{ m.optionA }} 赔率</span><span class="v">{{ poolOdds('A') }}</span></div>
        <div><span class="k">{{ m.optionB }} 赔率</span><span class="v">{{ poolOdds('B') }}</span></div>
      </div>
    </div>

    <!-- ════════ 坐庄玩法 ════════ -->
    <template v-if="mode === 'banker'">
      <div class="card" v-if="m.status !== 'settled'">
        <div class="sec-title">押注者 ({{ bankerBets.length }})</div>
        <p class="muted small" v-if="bankerBets.length === 0">还没人来押你的庄，喊两个朋友？</p>
        <div v-for="b in bankerBets" :key="b.id" class="bet-row">
          <span class="bet-emoji">{{ b.emoji }}</span>
          <b>{{ b.by }}</b>
          <span class="bet-side">押 {{ b.side === 'A' ? m.optionA : m.optionB }}</span>
          <span class="bet-stake">{{ b.stake.toLocaleString() }}</span>
        </div>
        <button v-if="!m.consensus && !online" class="btn block" style="margin-top:12px" @click="callBettor">📣 喊个朋友来押</button>
        <button v-if="m.status === 'open'" class="btn ghost block" style="margin-top:10px" @click="withdraw">撤庄退保证金</button>
      </div>
      <div v-if="m.status === 'matched' && !m.consensus" class="card">
        <div class="sec-title">揭晓结果（庄家按封顶结算）</div>
        <p class="muted small">押中者按你的赔率赢，押错者本金归你；你的亏损封顶 {{ m.bankerCap.toLocaleString() }}。你点结果即庄家裁定、直接落账；若有押注者异议，才转全员投票。</p>
        <div class="reveal">
          <button class="btn ghost" @click="startReveal('A')">结果是 {{ m.optionA }}</button>
          <button class="btn ghost" @click="startReveal('B')">结果是 {{ m.optionB }}</button>
        </div>
      </div>
    </template>

    <!-- ════════ 彩池玩法 ════════ -->
    <template v-else-if="mode === 'pool'">
      <div class="card" v-if="m.status !== 'settled'">
        <div class="sec-title">两边站队</div>
        <div class="pool-two">
          <div class="pool-col" :class="{ mine: myPoolSide === 'A' }">
            <div class="pool-name">{{ m.optionA }}<span v-if="myPoolSide === 'A'" class="badge">我押</span></div>
            <div class="pool-amt">{{ poolSum.A.toLocaleString() }}</div>
            <div class="pool-odds">赔率 {{ poolOdds('A') }}</div>
            <button v-if="!m.consensus" class="btn ghost mini" @click="joinPool('A')">站 {{ m.optionA }}</button>
          </div>
          <div class="pool-col" :class="{ mine: myPoolSide === 'B' }">
            <div class="pool-name">{{ m.optionB }}<span v-if="myPoolSide === 'B'" class="badge">我押</span></div>
            <div class="pool-amt">{{ poolSum.B.toLocaleString() }}</div>
            <div class="pool-odds">赔率 {{ poolOdds('B') }}</div>
            <button v-if="!m.consensus" class="btn ghost mini" @click="joinPool('B')">站 {{ m.optionB }}</button>
          </div>
        </div>
        <template v-if="!m.consensus">
          <label class="join-label">站队下注额</label>
          <input v-model.number="joinStake" type="number" min="1" class="join-input" />
          <p class="muted small">赔率 = 总池 ÷ 本边池，随下注实时变。赢方按占比瓜分输方池（平台 0 抽水）。</p>
          <button class="btn block" style="margin-top:8px" @click="callBettor">📣 喊朋友来站队</button>
        </template>
        <button v-if="m.status === 'open'" class="btn ghost block" style="margin-top:10px" @click="withdraw">撤池退回</button>
      </div>
      <div v-if="m.status === 'matched' && !m.consensus" class="card">
        <div class="sec-title">揭晓结果（赢方瓜分输方池）</div>
        <p class="muted small">你点结果即开盘人裁定、直接落账；若有站队者异议，才转全员投票。</p>
        <div class="reveal">
          <button class="btn ghost" @click="startReveal('A')">结果是 {{ m.optionA }}</button>
          <button class="btn ghost" @click="startReveal('B')">结果是 {{ m.optionB }}</button>
        </div>
      </div>
    </template>

    <!-- ════════ 约赌撮合（原玩法，照旧）════════ -->
    <template v-else>
    <!-- 等接盘：开盘人视角 -->
    <div v-if="m.status === 'open' && isOwner" class="card">
      <div class="sec-title">等朋友接盘…</div>
      <p class="muted small">
        你押「<b>{{ ownerSideLabel }}</b>」，朋友接盘会押对立面「{{ takerSideLabel }}」。
        押中净赚 <b class="up">{{ potentialWin.toLocaleString() }}</b>，押错亏掉
        <b class="down">{{ m.ownerStake.toLocaleString() }}</b>。
      </p>
      <button v-if="!online" class="btn block" @click="callFriend">📣 喊个朋友来接</button>
      <button class="btn ghost block" style="margin-top:10px" @click="withdraw">撤盘退回</button>
    </div>

    <!-- 等接盘：围观者视角 → 我来接盘（押对立面） -->
    <div v-else-if="m.status === 'open'" class="card">
      <div class="sec-title">{{ m.ownerName || '对方' }} 在等人接盘</div>
      <p class="muted small">
        TA 押「<b>{{ ownerSideLabel }}</b>」，你接盘就是押对立面「<b>{{ takerSideLabel }}</b>」，
        需押 <b>{{ takerStakeNeeded.toLocaleString() }}</b>。
        押中净赚 <b class="up">{{ m.ownerStake.toLocaleString() }}</b>，押错亏掉
        <b class="down">{{ takerStakeNeeded.toLocaleString() }}</b>。
      </p>
      <button class="btn block" :disabled="taking" @click="doTake">
        {{ taking ? '接盘中…' : `🤝 我来接：押「${takerSideLabel}」 ${takerStakeNeeded.toLocaleString()}` }}
      </button>
      <p v-if="err" class="down small" style="margin-top:8px">{{ err }}</p>
    </div>

    <!-- 已匹配，对手现身 -->
    <div v-else-if="m.status === 'matched'" class="card opp-card">
      <div class="sec-title">对手已就位 ⚔️</div>
      <div class="opp-line">
        <span class="opp-emoji">{{ m.takerEmoji }}</span>
        <span><b>{{ m.takerName }}</b> 接了，押「<b>{{ takerSideLabel }}</b>」 {{ m.takerStake.toLocaleString() }}</span>
      </div>
      <p class="muted small">押中净赚 <b class="up">{{ (isOwner ? potentialWin : m.ownerStake || 0).toLocaleString() }}</b>，押错亏 <b class="down">{{ (isOwner ? m.ownerStake : m.takerStake || 0).toLocaleString() }}</b>。</p>
    </div>

    <!-- 揭晓（仅有对手时可提议结算）-->
    <div v-if="m.status === 'matched' && !m.consensus" class="card">
      <div class="sec-title">揭晓结果</div>
      <p class="muted small">你点结果即直接裁定、落账；对方有异议才转全员投票表决。</p>
      <div class="reveal">
        <button class="btn ghost" @click="startReveal('A')">结果是 {{ m.optionA }}</button>
        <button class="btn ghost" @click="startReveal('B')">结果是 {{ m.optionB }}</button>
      </div>
    </div>
    </template>

    <!-- ════════ §A 共识揭晓面板（三玩法共用：提议后显示投票进度 / 僵局仲裁）════════ -->
    <div v-if="m.consensus && m.status === 'matched'" class="card consensus-card">
      <div class="sec-title">
        有异议 · 全员投票
        <span class="cs-rule">{{ m.consensus.rule === 'unanimous' ? '需双方都同意' : '需 2/3 同意' }}</span>
      </div>
      <p class="muted small">
        有人对庄家裁定「<b>{{ m.consensus.proposed === 'A' ? m.optionA : m.optionB }}</b>」有异议，进入全员投票表决：达阈值则维持落账，僵局则叫局外人评审。
      </p>
      <div class="cs-tally">
        {{ consensusTally.agree }}/{{ consensusTally.threshold }} 同意<span v-if="consensusTally.reject"> · {{ consensusTally.reject }} 反对</span>
      </div>
      <div class="cs-voters">
        <div v-for="v in m.consensus.voters" :key="v" class="cs-voter">
          <span class="cs-name">{{ v }}<span v-if="v === m.consensus.proposer" class="cs-tag">提议</span></span>
          <span class="cs-vote" :class="m.consensus.votes[v] || 'pending'">
            {{ m.consensus.votes[v] === 'agree' ? '同意 ✓' : m.consensus.votes[v] === 'reject' ? '反对 ✕' : '待投…' }}
          </span>
        </div>
      </div>
      <template v-if="m.consensus.status === 'deadlocked'">
        <p class="cs-deadlock">⚖️ 僵持不下——请一位<b>没参与这局</b>的人来当评审：</p>
        <div class="cs-arb-pick">
          <button v-for="c in arbiterCands" :key="c.name" class="cs-arb-chip" @click="inviteAsArbiter(c.name)">
            <span class="cs-arb-emoji">{{ c.emoji }}</span>{{ c.name }}
          </button>
        </div>
      </template>
      <template v-else-if="m.consensus.status === 'arbitration'">
        <p class="cs-deadlock">⚖️ 已邀请 <b>{{ m.consensus.arbiterEmoji }} {{ m.consensus.arbiter }}</b> 当评审，等 TA 裁定…</p>
      </template>
    </div>

    <!-- ════════ 已结算（三玩法共用，内容按 mode 变）════════ -->
    <div
      v-if="m.status === 'settled'"
      class="card settled-box"
      :class="{ lose: myNet < 0, 'fx-win': fxKind === 'win', 'fx-lose': fxKind === 'lose' }"
    >
      <!-- 赢：撒花层 -->
      <div v-if="fxKind === 'win'" class="confetti-layer" aria-hidden="true">
        <span
          v-for="(c, i) in confetti"
          :key="i"
          class="confetti-item"
          :style="{
            left: (4 + i * 9.6) + '%',
            animationDelay: (i * 80) + 'ms',
            animationDuration: (1.5 + (i % 3) * 0.3) + 's',
          }"
        >{{ c }}</span>
      </div>
      <div class="sec-title">已结算</div>
      <div class="settled-big">
        {{ myNet >= 0 ? '🎉 你赢了 +' + displayNet.toLocaleString() : '💀 你输了 -' + (-myNet).toLocaleString() }}
      </div>
      <div class="settled-slogan">{{ myNet >= 0 ? SLOGAN_WIN : SLOGAN_LOSE }}</div>
      <div class="settled-line">
        结果：<b>{{ m.result === 'A' ? m.optionA : m.optionB }}</b>
        <template v-if="mode === 'match'"> · 你押的「{{ isTaker ? takerSideLabel : ownerSideLabel }}」{{ iWonMatch() ? '✅' : '❌' }}</template>
        <template v-else-if="mode === 'banker'"> · 你是庄家，{{ myNet >= 0 ? '收割成功' : '被薅（已封顶）' }}</template>
        <template v-else> · 你押「{{ myPoolSide === 'A' ? m.optionA : m.optionB }}」{{ m.result === myPoolSide ? '✅' : '❌' }}</template>
      </div>
      <div class="settled-line muted small" v-if="mode === 'match' && m.takerName">
        对手 {{ isTaker ? (m.ownerEmoji || '') : (m.takerEmoji || '') }} {{ isTaker ? m.ownerName : m.takerName }} {{ iWonMatch() ? '吃瘪了' : '赢麻了' }}
      </div>
      <!-- 坐庄：逐笔结果 -->
      <div class="settled-line muted small" v-if="mode === 'banker'">
        押中者按 {{ m.bankerOdds }} 赔付，押错者本金归庄；庄家净{{ myNet >= 0 ? '赚' : '亏' }} {{ Math.abs(myNet).toLocaleString() }}。
      </div>

      <!-- 毒舌庄家解说（§5.7 引流主角）-->
      <div class="roast">
        <div class="roast-hd">🎙️ 毒舌庄家解说</div>
        <div v-if="roastLoading" class="roast-loading">
          <span class="spinner"></span> 庄家正在组织语言开喷…
        </div>
        <div v-else-if="roast" class="roast-body">{{ roast }}</div>
        <button v-else class="btn ghost roast-btn" @click="loadRoast">让庄家点评一下 🔥</button>
      </div>

      <!-- S8 线下文字彩头：履约/催债（平台只记录不结算） -->
      <div v-if="m.sideBet" class="sidebet">
        <div class="sb-hd">📿 线下彩头</div>
        <div class="sb-text">
          「{{ m.sideBet.text }}」
          <span v-if="m.sideBet.fulfilled" class="sb-done">已还愿 ✅</span>
          <span v-else-if="sbOverdue" class="sb-overdue">逾期未还 ⏰</span>
          <span v-else class="sb-pending">待还愿</span>
        </div>
        <div class="sb-note muted small">仅线下履约记录，不涉及积分/现金结算。</div>
        <div v-if="!m.sideBet.fulfilled" class="sb-actions">
          <!-- 赢家催债 -->
          <button v-if="iWonMatch()" class="btn ghost mini" @click="nagBet">📢 催债</button>
          <!-- 履约：双方都能点"标记已还愿"（不强绑积分输赢，更灵活，LOOP-2） -->
          <button class="btn mini" @click="fulfillSideBet">📿 标记已还愿</button>
        </div>
      </div>

      <!-- S10 申诉复议（§5.8，仅约赌局）-->
      <div v-if="mode === 'match'" class="appeal">
        <div class="ap-hd">⚖️ 申诉复议</div>
        <!-- 已有申诉记录 -->
        <template v-if="myAppeal">
          <div class="ap-rec">
            <div class="ap-reason" v-if="myAppeal.reason">理由：{{ myAppeal.reason }}</div>
            <div class="ap-meta muted small">
              押复议金 {{ myAppeal.stake.toLocaleString() }} ·
              <template v-if="myAppeal.status === 'pending'">待终审</template>
              <template v-else>
                已裁定：{{ myAppeal.verdict === 'overturn' ? '改判 ✅（已反向结算，复议金退回）' : '维持原判 ❌（复议金没收）' }}
              </template>
            </div>
          </div>
          <!-- 我作为管理员终审（pending 时）-->
          <div v-if="myAppeal.status === 'pending'" class="ap-admin">
            <div class="ap-admin-hd muted small">👤 管理员终审（覆写）：</div>
            <div class="ap-admin-btns">
              <button class="btn ghost mini" @click="adminResolve('uphold')">维持原判</button>
              <button class="btn mini" @click="adminResolve('overturn')">改判反转</button>
            </div>
          </div>
        </template>
        <!-- 发起申诉 -->
        <template v-else-if="canAppeal">
          <button v-if="!showAppeal" class="btn ghost mini" @click="showAppeal = true">对结果不服，申诉</button>
          <div v-else class="ap-form">
            <input v-model="appealReason" placeholder="申诉理由（可选）" maxlength="60" />
            <label class="ap-label">复议金（押多少表态，被驳回则没收）</label>
            <input v-model.number="appealStake" type="number" min="1" />
            <div v-if="appealErr" class="err" style="margin:6px 0">{{ appealErr }}</div>
            <div class="ap-form-btns">
              <button class="btn ghost mini" @click="showAppeal = false">取消</button>
              <button class="btn mini" @click="doAppeal">提交申诉</button>
            </div>
          </div>
        </template>
      </div>

      <!-- S9 LOOP-2 举报耍赖（仅约赌局且有对手）-->
      <div v-if="reportTarget" class="report">
        <div class="rp-hd">⚠️ 举报耍赖</div>
        <div v-if="reportDone" class="rp-done muted small">
          已举报 {{ reportTarget }}，信誉已下调（不影响积分，只影响信誉）。
        </div>
        <template v-else>
          <button v-if="!showReport" class="btn ghost mini" @click="showReport = true">
            举报 {{ reportTarget }} 耍赖
          </button>
          <div v-else class="rp-reasons">
            <div class="rp-tip muted small">选个理由（降被举报方信誉，发一条公示动态）：</div>
            <button
              v-for="r in REPORT_REASONS"
              :key="r.kind"
              class="btn ghost mini rp-opt"
              @click="doReport(r.kind)"
            >{{ r.label }}</button>
            <button class="btn ghost mini rp-cancel" @click="showReport = false">取消</button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="err" class="err">{{ err }}</div>

    <!-- 评论 -->
    <div class="card">
      <div class="sec-title">嘴炮区 ({{ m.comments.length }})</div>
      <div v-if="replyTo" class="replying">
        回复 {{ replyTo.emoji || '🙂' }} {{ replyTo.by }}
        <button @click="cancelReply">取消</button>
      </div>
      <div class="cmt-input">
        <input v-model="commentText" placeholder="甩两句垃圾话…" @keyup.enter="doComment" />
        <button class="btn" @click="doComment">发</button>
      </div>
      <div v-if="m.comments.length === 0" class="muted small empty">还没人说话，先开个炮</div>
      <div v-for="c in m.comments" :key="c.id" class="cmt" :class="{ slap: c.slap }">
        <div class="cmt-head">
          <span class="cmt-emoji">{{ c.emoji || '🙂' }}</span>
          <b :class="{ npc: c.npc }">{{ c.by }}</b>
          <span v-if="c.slap" class="slap-tag">打脸回放</span>
          <span class="faint">{{ fmtTime(c.at) }}</span>
          <button class="reply-btn" @click="startReply(c)">回复</button>
        </div>
        <div v-if="c.replyToName" class="reply-ref">回复 @{{ c.replyToName }}：{{ c.replyToText }}</div>
        <div class="cmt-body">{{ c.text }}</div>
      </div>
    </div>
  </div>
  <div v-else class="empty muted">赌局不存在</div>
</template>

<style scoped>
.bar { padding: 12px 16px 0; }
.back { color: var(--blue); font-size: 15px; }
.title { font-size: 17px; font-weight: 700; margin-bottom: 14px; }
.vs-box {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.vs-opt {
  flex: 1;
  text-align: center;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 8px;
  font-weight: 600;
  position: relative;
}
.vs-opt.mine { border-color: var(--blue); background: rgba(93, 220, 213, 0.13); }
.vs-mid { font-size: 12px; color: var(--text-faint); }
.badge {
  display: block;
  font-size: 10px;
  color: var(--blue);
  margin-top: 4px;
  font-weight: 700;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.grid > div {
  display: flex;
  justify-content: space-between;
  background: var(--bg-card-2);
  padding: 8px 10px;
  border-radius: 8px;
}
.k { color: var(--text-dim); font-size: 13px; }
.v { font-weight: 600; font-size: 13px; }

/* S10 截止倒计时行 */
.dl-line { font-size: 12px; color: var(--amber); margin: -6px 0 12px; }
.dl-line.overdue { color: var(--red); }
.dl-warn { font-weight: 600; }

/* S10 申诉复议 */
.appeal {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  position: relative;
  z-index: 1;
}
.ap-hd { font-size: 12px; font-weight: 700; color: var(--blue); margin-bottom: 8px; }
.ap-rec { background: var(--bg-card-2); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.ap-reason { font-size: 13px; margin-bottom: 4px; }
.ap-meta { font-size: 12px; }
.ap-admin { margin-top: 4px; }
.ap-admin-hd { margin-bottom: 6px; }
.ap-admin-btns, .ap-form-btns { display: flex; gap: 8px; }
.ap-admin-btns .btn, .ap-form-btns .btn { flex: 1; font-size: 13px; padding: 7px; width: auto; }
.ap-form input { width: 100%; margin-bottom: 8px; }
.ap-label { display: block; font-size: 11px; color: var(--text-dim); margin: 2px 0 6px; }

/* S9 举报耍赖 */
.report {
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border);
  position: relative; z-index: 1;
}
.rp-hd { font-size: 12px; font-weight: 700; color: #ff9d6b; margin-bottom: 8px; }
.rp-tip { margin-bottom: 6px; }
.rp-reasons { display: flex; flex-direction: column; gap: 6px; }
.rp-reasons .btn.mini { width: 100%; font-size: 13px; padding: 7px; text-align: left; }
.rp-cancel { color: var(--text-dim); }
.rp-done { padding: 2px 0; }

.sec-title { font-size: 14px; font-weight: 700; margin-bottom: 8px; }
.small { font-size: 13px; line-height: 1.5; }
.up { color: var(--green); }
.down { color: var(--red); }
.reveal { display: flex; gap: 10px; margin-top: 10px; }
.reveal .btn { flex: 1; }

/* §A 共识揭晓面板 */
.consensus-card { border-color: var(--blue); }
.cs-rule {
  font-size: 11px; font-weight: 700; color: var(--blue);
  background: var(--blue-dim); border-radius: 6px; padding: 2px 7px; margin-left: 6px;
  vertical-align: middle;
}
.cs-tally { font-size: 15px; font-weight: 800; color: var(--text); margin: 10px 0 8px; }
.cs-voters { display: flex; flex-direction: column; gap: 6px; }
.cs-voter {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; border-radius: 8px; background: var(--bg-card-2);
}
.cs-name { font-size: 14px; font-weight: 700; color: var(--text); }
.cs-tag {
  font-size: 10px; font-weight: 700; color: #fff; background: var(--blue);
  border-radius: 5px; padding: 1px 5px; margin-left: 5px; vertical-align: middle;
}
.cs-vote { font-size: 13px; font-weight: 700; }
.cs-vote.agree { color: var(--green); }
.cs-vote.reject { color: var(--red); }
.cs-vote.pending { color: var(--text-faint); }
.cs-deadlock { font-size: 13px; color: var(--red); margin: 12px 0 10px; line-height: 1.5; }
/* 僵局：邀请局外人当评审的候选 chip */
.cs-arb-pick { display: flex; flex-wrap: wrap; gap: 8px; }
.cs-arb-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 12px; border-radius: 18px;
  background: var(--bg-card-2); border: 1px solid var(--border);
  color: var(--text); font-size: 13px; font-weight: 600;
}
.cs-arb-chip:active { background: var(--blue-dim); border-color: var(--blue); }
.cs-arb-emoji { font-size: 16px; }

/* ── S7 玩法标签 ── */
.mode-tag {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
  margin-left: 8px;
  vertical-align: middle;
}
.mode-tag.match { background: var(--blue-dim); color: var(--blue); }
.mode-tag.banker { background: var(--amber-bg); color: var(--amber); }
.mode-tag.pool { background: var(--green-bg); color: var(--green); }

/* ── S8 线下彩头 ── */
.sidebet-tag {
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px;
  margin-left: 6px; vertical-align: middle;
  background: rgba(224, 184, 92, 0.12); color: var(--amber);
}
.sidebet {
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border);
  position: relative; z-index: 1;
}
.sb-hd { font-size: 12px; font-weight: 700; color: var(--amber); margin-bottom: 6px; }
.sb-text { font-size: 14px; font-weight: 600; }
.sb-done { color: var(--green); font-size: 12px; margin-left: 6px; }
.sb-overdue { color: var(--red); font-size: 12px; margin-left: 6px; }
.sb-pending { color: var(--text-dim); font-size: 12px; margin-left: 6px; }
.sb-note { margin: 4px 0 8px; }
.sb-actions { display: flex; gap: 10px; }
.sb-actions .btn.mini { font-size: 13px; padding: 7px 14px; width: auto; }

/* ── 坐庄押注行 ── */
.bet-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.bet-row:first-of-type { border-top: none; }
.bet-emoji { font-size: 18px; }
.bet-side { color: var(--text-dim); }
.bet-stake { margin-left: auto; font-weight: 700; }

/* ── 彩池两列 ── */
.pool-two { display: flex; gap: 10px; margin-bottom: 12px; }
.pool-col {
  flex: 1;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 8px;
  text-align: center;
}
.pool-col.mine { border-color: var(--blue); background: rgba(93, 220, 213, 0.13); }
.pool-name { font-size: 13px; font-weight: 700; margin-bottom: 6px; }
.pool-amt { font-size: 18px; font-weight: 800; }
.pool-odds { font-size: 12px; color: var(--text-dim); margin: 4px 0 8px; }
.btn.mini { font-size: 12px; padding: 6px 8px; width: 100%; }
.join-label { display: block; font-size: 12px; color: var(--text-dim); margin: 4px 0 6px; }
.join-input { width: 100%; margin-bottom: 8px; }

.opp-card { border-color: var(--amber-bg); }
.opp-line { display: flex; align-items: center; gap: 10px; font-size: 14px; margin-bottom: 8px; }
.opp-emoji { font-size: 24px; }

.settled-box { border-color: var(--green); position: relative; overflow: hidden; }
.settled-box.lose { border-color: var(--red); }
.settled-big { font-size: 22px; font-weight: 800; margin: 6px 0 10px; }
.settled-box .settled-big { color: var(--green); }
.settled-box.lose .settled-big { color: var(--red); }
.settled-line { font-size: 14px; margin: 4px 0; }

/* ── S6 揭晓特效 ── */
/* 赢：绿光环脉冲 */
.settled-box.fx-win {
  animation: confettiPulse 1.4s ease-out;
}
@keyframes confettiPulse {
  0%   { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0.0); transform: scale(1); }
  18%  { box-shadow: 0 0 0 6px rgba(46, 204, 113, 0.45), 0 0 28px rgba(46, 204, 113, 0.55); transform: scale(1.015); }
  60%  { box-shadow: 0 0 0 3px rgba(46, 204, 113, 0.25), 0 0 18px rgba(46, 204, 113, 0.3); transform: scale(1); }
  100% { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0.0); transform: scale(1); }
}
/* 输：红光 + 震动 */
.settled-box.fx-lose {
  animation: loseShake 0.5s ease-in-out, loseGlow 1.4s ease-out;
}
@keyframes loseShake {
  0%, 100% { transform: translateX(0); }
  15% { transform: translateX(-8px); }
  30% { transform: translateX(7px); }
  45% { transform: translateX(-5px); }
  60% { transform: translateX(4px); }
  75% { transform: translateX(-2px); }
}
@keyframes loseGlow {
  0%   { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.0); }
  20%  { box-shadow: 0 0 0 5px rgba(231, 76, 60, 0.45), 0 0 26px rgba(231, 76, 60, 0.55); }
  100% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.0); }
}
/* 撒花 emoji 漂落 */
.confetti-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 2;
}
.confetti-item {
  position: absolute;
  top: -24px;
  font-size: 20px;
  opacity: 0;
  animation: confettiFall 1.8s ease-in forwards;
}
@keyframes confettiFall {
  0%   { transform: translateY(-24px) rotate(0deg); opacity: 0; }
  10%  { opacity: 1; }
  100% { transform: translateY(220px) rotate(320deg); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .settled-box.fx-win, .settled-box.fx-lose { animation: none; }
  .confetti-item { animation: none; display: none; }
}

/* 毒舌庄家解说 */
.roast {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  position: relative;
  z-index: 1;
}
.roast-hd { font-size: 12px; font-weight: 700; color: var(--amber); margin-bottom: 6px; }
.roast-loading { font-size: 13px; color: var(--text-dim); display: flex; align-items: center; gap: 6px; }
.roast-body {
  font-size: 14px;
  line-height: 1.55;
  color: var(--text);
  background: rgba(224, 184, 92, 0.08);
  border-left: 3px solid var(--amber);
  padding: 8px 10px;
  border-radius: 0 8px 8px 0;
}
.roast-btn { margin-top: 2px; font-size: 13px; }

.err { color: var(--red); font-size: 13px; margin: 8px 16px; }

.cmt-input { display: flex; gap: 8px; margin-bottom: 12px; }
.cmt-input input { flex: 1; }
.replying {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--blue-dim);
  color: var(--blue);
  font-size: 12px;
  font-weight: 700;
}
.replying button, .reply-btn {
  color: var(--blue);
  font-size: 12px;
  font-weight: 700;
}
.reply-btn { margin-left: auto; }
.reply-ref {
  margin: 3px 0 5px;
  padding: 5px 8px;
  border-left: 2px solid var(--border);
  color: var(--text-dim);
  background: var(--bg-card-2);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.35;
}
.cmt {
  border-top: 1px solid var(--border);
  padding: 10px 0 0;
  margin-top: 10px;
}
.cmt:first-of-type { border-top: none; margin-top: 0; }
.cmt-head { display: flex; align-items: center; gap: 6px; font-size: 12px; margin-bottom: 3px; }
.cmt-emoji { font-size: 15px; }
.cmt-head b.npc { color: var(--amber); }
.cmt-body { font-size: 14px; }
.empty { padding: 14px 0; }

/* 打脸回放高亮 */
.cmt.slap {
  background: var(--red-bg);
  border-radius: 8px;
  padding: 10px;
  margin-top: 10px;
  border-top: none;
}
.slap-tag {
  font-size: 10px;
  font-weight: 700;
  color: var(--red);
  background: rgba(231, 76, 60, 0.18);
  padding: 1px 6px;
  border-radius: 5px;
}
.settled-slogan {
  font-size: 12px;
  font-weight: 700;
  margin: -4px 0 8px;
  color: var(--green);
  opacity: .85;
}
.settled-box.lose .settled-slogan { color: var(--red); }
</style>
