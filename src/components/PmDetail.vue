<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  store,
  placePmBet,
  settlePmBetReal,
  pmCommentsFor,
  seedNpcPmComments,
  postPmComment,
} from '../store.js'
import { parseOutcomes, pmResolvedOutcome } from '../api.js'
import { countUp, prefersReducedMotion } from '../core/countup.js'
import { SLOGAN_BATTLE, SLOGAN_WIN } from '../core/slogans.js'

const props = defineProps({ event: Object })
const emit = defineEmits(['back'])

// 取第一个 market 作为可下注盘口（多数 event 主盘在 markets[0]）
const market = computed(() => props.event.markets?.[0] || null)
// 盘口问题中文展示名（缓存的 market.zhQuestion；查不到降级英文 question）。
// 只用于显示；下注/结算的守恒命脉仍用真实英文 outcome，不受影响。
const zhQuestion = computed(() => {
  const m = market.value
  if (!m) return '盘口'
  return m.zhQuestion || m.question || '盘口'
})
// S15：选项概率取真实盘口；显示名用中文（缓存的 zhOutcomes，按序对齐），
// 但下注/结算仍用真实 outcome 名（name），中文名只放在 zhName 供展示。
const options = computed(() => {
  if (!market.value) return []
  const opts = parseOutcomes(market.value)
  const zh = props.event.zhOutcomes
  return opts.map((o, i) => ({
    ...o,
    zhName: Array.isArray(zh) && zh[i] ? zh[i] : o.name,
  }))
})
// S15：分类徽章替代源平台 tags（来源隐藏）。
const tags = computed(() => (props.event.category ? [props.event.category] : []))

// myPick：simple 盘存选中 outcome 英文名；outright 盘存选中候选的 marketId。
const myPick = ref(null)
const stake = ref(10000)
const betErr = ref('')
const betOk = ref('')

// P1 outright 榜单形态（世界杯夺冠/出线/晋级/金靴…）：候选列表带赔率（1/prob）。
const isOutright = computed(
  () => props.event.kind === 'outright' && Array.isArray(props.event.outright) && props.event.outright.length > 0,
)
const outrightRows = computed(() =>
  (props.event.outright || []).map((r) => ({
    ...r,
    zhName: r.zhName || r.name,
    odds: r.prob > 0 ? (1 / r.prob).toFixed(2) : '—',
  })),
)
// 选中的候选（按 marketId 命中）。
const pickedRow = computed(() => outrightRows.value.find((r) => r.marketId === myPick.value) || null)

// P3 单场对阵形态：三组玩法（胜负线/让分/大小分），选中项存 matchPick。
const isMatch = computed(() => props.event.kind === 'match' && !!props.event.match)
const matchPick = ref(null) // { marketId, outcome(英文), zhName, prob, label }
// 三组玩法（带中文组名 + 盘口线），过滤掉后端没给的组。
const matchGroups = computed(() => {
  const m = props.event.match || {}
  const groups = []
  if (m.moneyline) groups.push({ key: 'ml', label: '胜负线', marketId: m.moneyline.marketId, options: m.moneyline.options || [] })
  if (m.spread) groups.push({ key: 'sp', label: '让分 ' + (m.spread.line ?? ''), marketId: m.spread.marketId, options: m.spread.options || [] })
  if (m.total) groups.push({ key: 'tot', label: '大小分 ' + (m.total.line ?? ''), marketId: m.total.marketId, options: m.total.options || [] })
  return groups
})
function selectMatchPick(group, o) {
  matchPick.value = {
    marketId: group.marketId,
    outcome: o.name, // 真实英文 outcome（守恒命脉）
    zhName: o.zhName || o.name,
    prob: o.prob,
    label: group.label,
  }
}
const matchOdds = computed(() => (matchPick.value && matchPick.value.prob > 0 ? (1 / matchPick.value.prob).toFixed(2) : '—'))

// ⚽世界杯单场（kind='wcgame'）：胜负线/半场结果/波胆 三组，每个选项是独立 Yes/No 盘（押 Yes=该结果成立）。
const isWcGame = computed(() => props.event.kind === 'wcgame')
const wcPick = ref(null) // { marketId, zhName, prob, label }
const wcGroups = computed(() => {
  const g = props.event.groups || {}
  const out = []
  if (g.moneyline?.length) out.push({ key: 'ml', label: '胜负线', options: g.moneyline })
  if (g.halftime?.length) out.push({ key: 'ht', label: '半场结果', options: g.halftime })
  if (g.exactScore?.length) out.push({ key: 'score', label: '波胆 · 精确比分', options: g.exactScore, grid: true })
  return out
})
function selectWcPick(group, o) {
  wcPick.value = { marketId: o.marketId, zhName: o.zhName, prob: o.prob, label: group.label }
}
const wcOdds = computed(() => (wcPick.value && wcPick.value.prob > 0 ? (1 / wcPick.value.prob).toFixed(2) : '—'))

const pickedProb = computed(() => {
  const o = options.value.find((x) => x.name === myPick.value)
  return o ? o.prob : 0
})
// 选中项的中文展示名（下注/结算仍用真实 name）。
const pickedZhName = computed(() => {
  const o = options.value.find((x) => x.name === myPick.value)
  return o ? o.zhName : ''
})
const pickedOdds = computed(() => (pickedProb.value > 0 ? (1 / pickedProb.value).toFixed(2) : '—'))

function placeBet() {
  betErr.value = ''
  betOk.value = ''
  if (isWcGame.value ? !wcPick.value : isMatch.value ? !matchPick.value : !myPick.value) {
    betErr.value = isOutright.value ? '请先选一个候选' : isWcGame.value ? '请先选一个玩法' : isMatch.value ? '请先选一个盘口' : '请先选一个结果'
    return
  }
  try {
    if (isWcGame.value) {
      // 世界杯单场：选项绑独立 marketId，押 Yes=该结果成立（真实英文 outcome，守恒）。
      const p = wcPick.value
      const __betP0 = placePmBet({
        eventId: props.event.id,
        marketId: p.marketId,
        eventTitle: `${props.event.zhTitle || props.event.title} · ${p.label}`,
        marketQuestion: `${p.label}：${p.zhName}`,
        outcome: 'Yes',
        zhOutcome: p.zhName,
        prob: p.prob,
        stake: Number(stake.value),
      })
      betOk.value = `已押「${p.label}：${p.zhName}」，扣 ${Number(stake.value).toLocaleString()} 积分（赔率 ${wcOdds.value}）`
      if (__betP0 && typeof __betP0.then === 'function') { const msg = betOk.value; betOk.value = '下注中…'; __betP0.then(() => { betOk.value = msg }).catch((e) => { betOk.value = ''; betErr.value = e?.message || '下注失败' }) }
      return
    }
    if (isOutright.value) {
      // outright：押某候选「夺冠/出线/晋级」= 在该候选 Yes/No 盘押 Yes（真实英文 outcome，守恒）。
      const r = pickedRow.value
      if (!r) {
        betErr.value = '请先选一个候选'
        return
      }
      const __betP1 = placePmBet({
        eventId: props.event.id,
        marketId: r.marketId, // 绑候选盘 id，结算按 market 单查
        eventTitle: `${r.zhName} · ${props.event.title}`,
        marketQuestion: r.name,
        outcome: 'Yes', // 押该候选成立 = Yes（守恒命脉）
        zhOutcome: r.zhName,
        prob: r.prob,
        stake: Number(stake.value),
      })
      betOk.value = `已押「${r.zhName}」，扣 ${Number(stake.value).toLocaleString()} 积分（赔率 ${r.odds}）`
      // 联机：API 失败时撤掉乐观成功语并透出错误（防静默吞错显示假成功）
      if (__betP1 && typeof __betP1.then === 'function') { const msg = betOk.value; betOk.value = '下注中…'; __betP1.then(() => { betOk.value = msg }).catch((e) => { betOk.value = ''; betErr.value = e?.message || '下注失败' }) }
    } else if (isMatch.value) {
      // 单场：押某玩法(胜负线/让分/大小分)的某选项,绑该玩法盘 marketId,outcome 真实英文(守恒)。
      const p = matchPick.value
      const __betP2 = placePmBet({
        eventId: props.event.id,
        marketId: p.marketId,
        eventTitle: `${props.event.title} · ${p.label}`,
        marketQuestion: p.label,
        outcome: p.outcome,
        zhOutcome: p.zhName,
        prob: p.prob,
        stake: Number(stake.value),
      })
      betOk.value = `已押「${p.label}：${p.zhName}」，扣 ${Number(stake.value).toLocaleString()} 积分（赔率 ${matchOdds.value}）`
      // 联机：API 失败时撤掉乐观成功语并透出错误（防静默吞错显示假成功）
      if (__betP2 && typeof __betP2.then === 'function') { const msg = betOk.value; betOk.value = '下注中…'; __betP2.then(() => { betOk.value = msg }).catch((e) => { betOk.value = ''; betErr.value = e?.message || '下注失败' }) }
    } else {
      const __betP3 = placePmBet({
        eventId: props.event.id,
        marketId: market.value?.id ?? null, // 主盘 id（无则降级 eventId 结算）
        eventTitle: props.event.title,
        marketQuestion: market.value.question,
        outcome: myPick.value, // 真实英文 outcome（守恒命脉）
        zhOutcome: pickedZhName.value, // 中文显示名（只供展示）
        prob: pickedProb.value,
        stake: Number(stake.value),
      })
      betOk.value = `已押 ${pickedZhName.value}，扣 ${Number(stake.value).toLocaleString()} 积分（赔率 ${pickedOdds.value}）`
      // 联机：API 失败时撤掉乐观成功语并透出错误（防静默吞错显示假成功）
      if (__betP3 && typeof __betP3.then === 'function') { const msg = betOk.value; betOk.value = '下注中…'; __betP3.then(() => { betOk.value = msg }).catch((e) => { betOk.value = ''; betErr.value = e?.message || '下注失败' }) }
    }
  } catch (e) {
    betErr.value = e.message
  }
}

// 我在该盘口的未结算押注（用于「揭晓结算」入口）
const myPendingBets = computed(() =>
  store.pmBets.filter(
    // 优先用 eventId 精确绑定(防同名盘串台)；旧 bet 无 eventId 时退回标题匹配
    (b) => b.status === 'pending' && (b.eventId != null ? b.eventId === props.event.id : b.eventTitle === props.event.title),
  ),
)
const settleMsg = ref('')

// —— 赢局特效（与 MatchDetail 同语言：金币雨 + 派彩金额滚动）——
const winFx = ref(false)
const shownPayout = ref(0)
const winCoins = ['🪙', '💰', '🪙', '✨', '🪙', '💎', '🏆', '🪙', '🤑', '🪙']
let winFxTimer = null
let cancelPayoutCount = null
function triggerWinFx(payout) {
  if (winFxTimer) clearTimeout(winFxTimer)
  cancelPayoutCount?.()
  winFx.value = true
  winFxTimer = setTimeout(() => { winFx.value = false }, 2200)
  if (prefersReducedMotion()) { shownPayout.value = payout; return }
  shownPayout.value = 0
  cancelPayoutCount = countUp(0, payout, 900, (v) => { shownPayout.value = v })
}
onUnmounted(() => { // 离开盘口详情清理特效计时器/RAF
  if (winFxTimer) clearTimeout(winFxTimer)
  cancelPayoutCount?.()
})

// 把真实英文 outcome 名映射成中文显示名（查 options 的 zhName，查不到回退英文）。
// 只用于显示层；结算比较仍由 store 用真实英文 outcome（守恒命脉）。
function zhOf(outcomeName) {
  const o = options.value.find((x) => x.name === outcomeName)
  return o ? o.zhName : outcomeName
}

// S16 揭晓结算（默认等真实）：盘口已真实结束 → 按真实结果派彩（有依据）；
//   盘口没结束 → 不再默认模拟顶替，提示「等盘口结束自动揭晓」（进系统盘会自动结算）。
function settleBet(bet) {
  settleMsg.value = ''
  try {
    if (isOutright.value || isMatch.value) {
      // outright/单场 玩法盘真实结果按其 marketId 单查，进系统盘会自动结算；此处不顶替。
      settleMsg.value = '盘口结束后会自动按真实结果揭晓 ⏳'
      return
    }
    const realWin = pmResolvedOutcome(market.value)
    if (realWin) {
      const res = settlePmBetReal(bet.id, realWin) // 比较仍用真实英文 realWin
      const zhWin = zhOf(realWin)
      if (res.status === 'won') {
        settleMsg.value = `真实揭晓「${zhWin}」，押中！派彩 ${res.payout.toLocaleString()} 积分 🎯`
        triggerWinFx(res.payout)
      } else {
        settleMsg.value = `真实揭晓「${zhWin}」，押错了，本金已计入。`
      }
    } else {
      // 盘口未结束：等真实结果（自动结算会在盘口结束后判），不默认模拟。
      settleMsg.value = '盘口还没结束，等盘口结束后会自动按真实结果揭晓 ⏳'
    }
  } catch (e) {
    settleMsg.value = e.message
  }
}

// 「提前揭晓」已移除（2026-06-11 爹地拍板）：系统盘只按真实结果揭晓，预测表态走留言板。
// 原因：模拟开奖让人感觉"币可以往前刷"，破坏"认知变现"的核心——没有真实依据就没有派彩。

// 留言板（替代原 DeepSeek 预测）：本地留言 + 进盘 seed 的 NPC 预设氛围评论。
const draft = ref('')
const boardErr = ref('')
const replyTo = ref(null)
// 直接读 store.pmComments，保证发完留言/seed 后响应式刷新。
const comments = computed(() => {
  // 触发响应式依赖：读一下该盘评论数组引用。
  void store.pmComments[String(props.event.id)]
  return pmCommentsFor(props.event.id)
})

function send() {
  boardErr.value = ''
  const text = draft.value
  const replyId = replyTo.value?.id || null
  try {
    const r = postPmComment(props.event.id, text, replyId)
    draft.value = ''
    replyTo.value = null
    if (r && typeof r.then === 'function') r.catch((e) => { draft.value = text; replyTo.value = replyId ? comments.value.find((c) => c.id === replyId) : null; boardErr.value = e?.message || '发送失败' })
  } catch (e) {
    boardErr.value = e.message
  }
}
function startReply(c) {
  replyTo.value = c
  const mention = `@${c.by} `
  if (!draft.value.trim().startsWith(mention)) draft.value = mention + draft.value.trimStart()
}
function cancelReply() {
  replyTo.value = null
  draft.value = draft.value.replace(/^@\S+\s*/, '')
}

// 进盘时 seed 一批 NPC 氛围评论（幂等：已 seed 不重复）。
onMounted(() => {
  seedNpcPmComments(props.event.id)
})
</script>

<template>
  <div>
    <div class="bar"><button class="back" @click="emit('back')">‹ 返回</button></div>

    <div class="card">
      <div class="pm-head">
        <img v-if="event.icon" :src="event.icon" class="icon" alt="" />
        <div class="title">{{ event.title }}</div>
      </div>
      <div class="tags">
        <span v-for="t in tags" :key="t" class="tag">{{ t }}</span>
      </div>
      <p v-if="event.description" class="desc muted">{{ event.description.slice(0, 220) }}<span v-if="event.description.length > 220">…</span></p>
    </div>

    <!-- 押注 -->
    <div class="card">
      <!-- outright 榜单（世界杯夺冠/出线/晋级/金靴…）：选候选押注 -->
      <template v-if="isOutright">
        <div class="sec-title">{{ event.title }}</div>
        <p class="muted small" style="margin-bottom:10px">选一个候选押注，押中按赔率派彩。概率越低、赔率越高。</p>
        <div
          v-for="(r, i) in outrightRows"
          :key="r.marketId"
          class="opt-row rank"
          :class="{ on: myPick === r.marketId }"
          @click="myPick = r.marketId"
        >
          <span class="rank-no" :class="{ top: i === 0 }">{{ i + 1 }}</span>
          <span class="opt-name rank-name">{{ r.zhName }}</span>
          <div class="prob-track">
            <div class="prob-fill" :style="{ width: (r.prob * 100).toFixed(1) + '%' }"></div>
          </div>
          <span class="opt-pct">{{ (r.prob * 100).toFixed(0) }}%</span>
          <span class="odds-cell faint">{{ r.odds }}x</span>
        </div>
        <div class="bet-row">
          <input v-model.number="stake" type="number" min="1" placeholder="下注积分" />
          <span class="odds-tip faint" v-if="pickedRow">赔率 {{ pickedRow.odds }}</span>
        </div>
        <button class="btn block" @click="placeBet">押「{{ pickedRow?.zhName || '选一个候选' }}」</button>
          <div class="bet-slogan">{{ SLOGAN_BATTLE }}</div>
        <div v-if="betErr" class="err">{{ betErr }}</div>
        <div v-if="betOk" class="ok">{{ betOk }}</div>
      </template>

      <!-- ⚽世界杯单场（Polymarket 赛程盘）：胜负线/半场结果/波胆 三组，每选项独立盘口 -->
      <template v-else-if="isWcGame">
        <div class="sec-title">{{ event.zhTitle || event.title }}</div>
        <p class="muted small" style="margin-bottom:10px">选个玩法押注，押中按赔率派彩。</p>
        <div v-for="g in wcGroups" :key="g.key" class="mgroup">
          <div class="mgroup-label">{{ g.label }}</div>
          <!-- 波胆走紧凑网格，三向走常规行 -->
          <div v-if="g.grid" class="wc-score-grid">
            <button
              v-for="o in g.options"
              :key="o.marketId"
              class="wc-score-cell"
              :class="{ on: wcPick && wcPick.marketId === o.marketId }"
              @click="selectWcPick(g, o)"
            >
              <span class="wc-score">{{ o.zhName }}</span>
              <span class="wc-score-pct">{{ (o.prob * 100).toFixed(0) }}%</span>
            </button>
          </div>
          <template v-else>
            <div
              v-for="o in g.options"
              :key="o.marketId"
              class="opt-row mopt"
              :class="{ on: wcPick && wcPick.marketId === o.marketId }"
              @click="selectWcPick(g, o)"
            >
              <span class="opt-name">{{ o.zhName }}</span>
              <div class="prob-track">
                <div class="prob-fill" :style="{ width: (o.prob * 100).toFixed(1) + '%' }"></div>
              </div>
              <span class="opt-pct">{{ (o.prob * 100).toFixed(0) }}%</span>
              <span class="odds-cell faint">{{ o.prob > 0 ? (1 / o.prob).toFixed(2) : '—' }}x</span>
            </div>
          </template>
        </div>
        <div v-if="!wcGroups.length" class="muted small">该比赛暂无可下注盘口</div>
        <template v-if="wcGroups.length">
          <div class="bet-row">
            <input v-model.number="stake" type="number" min="1" placeholder="下注积分" />
            <span class="odds-tip faint" v-if="wcPick">赔率 {{ wcOdds }}</span>
          </div>
          <button class="btn block" @click="placeBet">押「{{ wcPick ? wcPick.label + '：' + wcPick.zhName : '选个玩法' }}」</button>
          <div class="bet-slogan">{{ SLOGAN_BATTLE }}</div>
          <div v-if="betErr" class="err">{{ betErr }}</div>
          <div v-if="betOk" class="ok">{{ betOk }}</div>
        </template>
      </template>

      <!-- 单场对阵（NBA/世界杯单场）：胜负线/让分/大小分 三组 -->
      <template v-else-if="isMatch">
        <div class="sec-title">{{ event.title }}</div>
        <p class="muted small" style="margin-bottom:10px">选个盘口押注，押中按赔率派彩。</p>
        <div v-for="g in matchGroups" :key="g.key" class="mgroup">
          <div class="mgroup-label">{{ g.label }}</div>
          <div
            v-for="o in g.options"
            :key="o.name"
            class="opt-row mopt"
            :class="{ on: matchPick && matchPick.marketId === g.marketId && matchPick.outcome === o.name }"
            @click="selectMatchPick(g, o)"
          >
            <span class="opt-name">{{ o.zhName || o.name }}</span>
            <div class="prob-track">
              <div class="prob-fill" :style="{ width: (o.prob * 100).toFixed(1) + '%' }"></div>
            </div>
            <span class="opt-pct">{{ (o.prob * 100).toFixed(0) }}%</span>
            <span class="odds-cell faint">{{ o.prob > 0 ? (1 / o.prob).toFixed(2) : '—' }}x</span>
          </div>
        </div>
        <div v-if="!matchGroups.length" class="muted small">该比赛暂无可下注盘口</div>
        <template v-if="matchGroups.length">
          <div class="bet-row">
            <input v-model.number="stake" type="number" min="1" placeholder="下注积分" />
            <span class="odds-tip faint" v-if="matchPick">赔率 {{ matchOdds }}</span>
          </div>
          <button class="btn block" @click="placeBet">押「{{ matchPick ? matchPick.label + '：' + matchPick.zhName : '选个盘口' }}」</button>
          <div class="bet-slogan">{{ SLOGAN_BATTLE }}</div>
          <div v-if="betErr" class="err">{{ betErr }}</div>
          <div v-if="betOk" class="ok">{{ betOk }}</div>
        </template>
      </template>

      <!-- simple 单盘 -->
      <template v-else>
        <div class="sec-title">{{ zhQuestion }}</div>
        <div v-if="options.length === 0" class="muted small">该盘口暂无可下注选项</div>
        <div
          v-for="o in options"
          :key="o.name"
          class="opt-row"
          :class="{ on: myPick === o.name }"
          @click="myPick = o.name"
        >
          <span class="opt-name">{{ o.zhName }}</span>
          <div class="prob-track">
            <div class="prob-fill" :style="{ width: (o.prob * 100).toFixed(1) + '%' }"></div>
          </div>
          <span class="opt-pct">{{ (o.prob * 100).toFixed(0) }}%</span>
        </div>

        <template v-if="options.length">
          <div class="bet-row">
            <input v-model.number="stake" type="number" min="1" placeholder="下注积分" />
            <span class="odds-tip faint" v-if="myPick">赔率 {{ pickedOdds }}</span>
          </div>
          <button class="btn block" @click="placeBet">押「{{ pickedZhName || '选一个' }}」</button>
          <div class="bet-slogan">{{ SLOGAN_BATTLE }}</div>
          <div v-if="betErr" class="err">{{ betErr }}</div>
          <div v-if="betOk" class="ok">{{ betOk }}</div>
        </template>
      </template>
    </div>

    <!-- 揭晓结算（S11）：跟系统盘对赌闭环 -->
    <div v-if="myPendingBets.length || winFx" class="card settle-card" :class="{ 'fx-win': winFx }">
      <!-- 赢：金币雨 + 派彩金额滚动横幅 -->
      <div v-if="winFx" class="coin-layer" aria-hidden="true">
        <span
          v-for="(c, i) in winCoins"
          :key="i"
          class="coin-item"
          :style="{
            left: (4 + i * 9.6) + '%',
            animationDelay: (i * 80) + 'ms',
            animationDuration: (1.5 + (i % 3) * 0.3) + 's',
          }"
        >{{ c }}</span>
      </div>
      <div v-if="winFx" class="win-banner">🎯 派彩 +{{ shownPayout.toLocaleString() }}<div class="win-sub">{{ SLOGAN_WIN }}</div></div>
      <div class="sec-title">⚖️ 揭晓结算</div>
      <p class="muted small">
        跟系统盘对赌，押中按市场赔率派彩、押错本金充公。<b>盘口结束后按真实结果自动揭晓（有依据）</b>，
        没揭晓前可去留言板亮出你的预测。
      </p>
      <div v-for="b in myPendingBets" :key="b.id" class="settle-row">
        <span class="settle-info">押「{{ b.zhOutcome || zhOf(b.outcome) }}」· {{ b.stake.toLocaleString() }} · 赔率 {{ b.odds.toFixed(2) }}</span>
        <div class="settle-btns">
          <button class="btn ghost settle-btn" @click="settleBet(b)">揭晓</button>
        </div>
      </div>
      <div v-if="settleMsg" class="ok">{{ settleMsg }}</div>
    </div>

    <!-- 留言板（替代原 DeepSeek 预测）-->
    <div class="card board-card">
      <div class="sec-title">💬 留言板</div>
      <div v-if="comments.length === 0" class="muted small">还没人留言，来抢个沙发 👇</div>
      <div v-for="c in comments" :key="c.id" class="cmt" :class="{ mine: !c.npc }">
        <span class="cmt-who">{{ c.emoji }} {{ c.by }}</span>
        <button class="reply-btn" @click="startReply(c)">回复</button>
        <span v-if="c.replyToName" class="reply-ref">回复 @{{ c.replyToName }}：{{ c.replyToText }}</span>
        <span class="cmt-text">{{ c.text }}</span>
      </div>
      <div v-if="replyTo" class="replying">
        回复 {{ replyTo.emoji || '🙂' }} {{ replyTo.by }}
        <button @click="cancelReply">取消</button>
      </div>
      <div class="board-input">
        <input v-model="draft" type="text" maxlength="120" placeholder="说点什么…" @keyup.enter="send" />
        <button class="btn send-btn" @click="send">发送</button>
      </div>
      <div v-if="boardErr" class="err">{{ boardErr }}</div>
    </div>
  </div>
</template>

<style scoped>
.bar { padding: 12px 16px 0; }
.back { color: var(--blue); font-size: 15px; }
.pm-head { display: flex; gap: 12px; align-items: center; }
.icon { width: 48px; height: 48px; border-radius: 10px; object-fit: cover; background: var(--bg-card-2); }
.title { font-size: 17px; font-weight: 700; line-height: 1.3; }
.tags { margin: 12px 0 0; }
.desc { font-size: 13px; line-height: 1.55; margin-top: 12px; }

.sec-title { font-size: 14px; font-weight: 700; margin-bottom: 10px; }
.small { font-size: 13px; line-height: 1.5; }

.opt-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
}
.opt-row.on { border-color: var(--blue); background: rgba(93, 220, 213, 0.13); }
.opt-name { flex: 0 0 auto; min-width: 50px; font-weight: 600; font-size: 13px; }
.opt-pct { flex: 0 0 auto; min-width: 38px; text-align: right; font-weight: 700; font-size: 13px; }

/* outright 榜单行 */
.opt-row.rank { gap: 8px; }
.rank-no {
  flex: 0 0 auto;
  width: 18px;
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-faint);
}
.rank-no.top { color: var(--amber); }
.rank-name { flex: 0 0 76px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.odds-cell { flex: 0 0 auto; min-width: 40px; text-align: right; font-size: 12px; font-weight: 600; }

.bet-row { display: flex; align-items: center; gap: 10px; margin: 12px 0 10px; }
.bet-row input { flex: 1; }
.odds-tip { font-size: 12px; flex: 0 0 auto; }

.err { color: var(--red); font-size: 13px; margin-top: 8px; }
.ok { color: var(--green); font-size: 13px; margin-top: 8px; }

.settle-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
.settle-info { font-size: 13px; }
.settle-btns { display: flex; gap: 8px; flex: 0 0 auto; }
.settle-btn { flex: 0 0 auto; padding: 6px 14px; font-size: 13px; }

/* ── 赢局特效（与 MatchDetail 同语言）── */
.settle-card { position: relative; overflow: hidden; }
.settle-card.fx-win {
  border-color: var(--green);
  animation: pmWinPulse 1.4s ease-out;
}
@keyframes pmWinPulse {
  0%   { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0); transform: scale(1); }
  18%  { box-shadow: 0 0 0 6px rgba(46, 204, 113, 0.45), 0 0 28px rgba(46, 204, 113, 0.55); transform: scale(1.015); }
  60%  { box-shadow: 0 0 0 3px rgba(46, 204, 113, 0.25), 0 0 18px rgba(46, 204, 113, 0.3); transform: scale(1); }
  100% { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0); transform: scale(1); }
}
.coin-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 2;
}
.coin-item {
  position: absolute;
  top: -24px;
  font-size: 20px;
  opacity: 0;
  animation: coinFall 1.8s ease-in forwards;
}
@keyframes coinFall {
  0%   { transform: translateY(-24px) rotate(0deg); opacity: 0; }
  10%  { opacity: 1; }
  100% { transform: translateY(220px) rotate(320deg); opacity: 0; }
}
.win-banner {
  font-size: 20px;
  font-weight: 800;
  color: var(--green);
  margin-bottom: 8px;
}
@media (prefers-reduced-motion: reduce) {
  .settle-card.fx-win { animation: none; }
  .coin-item { animation: none; display: none; }
}

.board-card .cmt {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  padding: 7px 0;
  border-top: 1px solid var(--border);
  font-size: 13px;
  line-height: 1.5;
}
.board-card .cmt:first-of-type { border-top: none; }
.cmt-who { flex: 0 0 auto; font-weight: 600; color: var(--text-dim); }
.cmt.mine .cmt-who { color: var(--blue); }
.cmt-text { flex: 1; word-break: break-word; }
.reply-btn {
  flex: 0 0 auto;
  color: var(--blue);
  font-size: 12px;
  font-weight: 700;
}
.reply-ref {
  flex: 1 0 100%;
  padding: 5px 8px;
  border-left: 2px solid var(--border);
  color: var(--text-dim);
  background: var(--bg-card-2);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.35;
}
.replying {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--blue-dim);
  color: var(--blue);
  font-size: 12px;
  font-weight: 700;
}
.replying button { color: var(--blue); font-size: 12px; font-weight: 700; }
.board-input { display: flex; gap: 8px; margin-top: 12px; }
.board-input input { flex: 1; }
.send-btn { flex: 0 0 auto; padding: 0 18px; }

/* P3 单场三组玩法 */
.mgroup { margin-bottom: 14px; }
.mgroup-label { font-size: 13px; font-weight: 700; color: var(--text-dim); margin-bottom: 6px; }
.opt-row.mopt { gap: 9px; }
.bet-slogan {
  margin-top: 8px;
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--text-faint);
}
.win-sub {
  font-size: 12px;
  font-weight: 700;
  color: var(--green);
  opacity: .85;
  margin-top: 2px;
}

/* —— ⚽世界杯单场：波胆比分网格 —— */
.wc-score-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-top: 6px;
}
.wc-score-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 2px;
  border-radius: 10px;
  border: 1px solid rgba(120, 130, 160, 0.18);
  background: rgba(120, 130, 160, 0.06);
  font: inherit;
  cursor: pointer;
}
.wc-score-cell.on {
  border-color: var(--brand, #2f6df6);
  background: rgba(47, 109, 246, 0.10);
}
.wc-score { font-weight: 700; font-size: 14px; font-variant-numeric: tabular-nums; }
.wc-score-pct { font-size: 11px; color: var(--ink-2, #667); }
</style>
