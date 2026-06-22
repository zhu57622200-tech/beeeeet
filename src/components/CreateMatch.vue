<script setup>
import { ref, computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { SLOGAN_BATTLE } from '../core/slogans.js'
import { store, createMatch, inviteMatch, isFriend, scheduleInviteResponses } from '../store.js'
import { forgeCriteria } from '../api.js'

const props = defineProps({
  prefillTitle: { type: String, default: '' },
})
const emit = defineEmits(['close'])

const title = ref(props.prefillTitle || '')
const optionA = ref('')
const optionB = ref('')
const ownerSide = ref('A')
const odds = ref(2)
const ownerStake = ref(10000)
const sideBet = ref('') // S8 可选线下文字彩头（只记录不结算）
const err = ref('')

// —— S10 截止时间（§5.13）。到截止仍无人接 → 自动作废退回。预设档，原型友好 ——
const DAY_MS = 24 * 60 * 60 * 1000
const deadlinePreset = ref(0) // 0=不设 / 1 / 3 / 7（天）
const DEADLINES = [
  { d: 0, label: '不设' },
  { d: 1, label: '1天' },
  { d: 3, label: '3天' },
  { d: 7, label: '7天' },
]

// —— S7 玩法选择：约赌撮合 / 坐庄 / 彩池 / 邀请好友（P-0.5 爹地拍板升为第 4 玩法）——
const mode = ref('match') // 'match' | 'banker' | 'pool' | 'invite'
const bankerOdds = ref(2) // 坐庄：我自设的赔率
const bankerCap = ref(50000) // 坐庄：保证金封顶(我最大亏损)
const MODES = [
  { key: 'match', label: '约赌撮合', desc: '1v1 固定赔率，谁敢接' },
  { key: 'banker', label: '我坐庄', desc: '自设赔率收注，保证金封顶' },
  { key: 'pool', label: '彩池', desc: '两边站队，赢方瓜分输方' },
  { key: 'invite', label: '邀请好友', desc: '选好友定向开局，等 TA 接' },
]

// —— 邀请好友：浮层内选人（多选），1v1 约赌口径，第一个同意者成局 ——
const friends = computed(() => store.players.filter((p) => !p.isMe && isFriend(p.name)))
const selectedFriends = ref([])
const friendPickerOpen = ref(false)
const friendPickerRef = ref(null)
function toggleFriend(name) {
  const i = selectedFriends.value.indexOf(name)
  if (i === -1) selectedFriends.value.push(name)
  else selectedFriends.value.splice(i, 1)
}
const selectedFriendSummary = computed(() => {
  const names = selectedFriends.value
  if (!names.length) return ''
  if (names.length <= 3) return names.join('、')
  return `${names.slice(0, 2).join('、')} 等 ${names.length} 人`
})
function closeFriendPicker(e) {
  if (!friendPickerOpen.value) return
  const el = friendPickerRef.value
  if (el && !el.contains(e.target)) friendPickerOpen.value = false
}
onMounted(() => document.addEventListener('pointerdown', closeFriendPicker))
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeFriendPicker))
// 切换玩法时收起下拉面板（防切回时面板突兀复开）；已选好友保留——chips/摘要可见，所见即所得。
watch(mode, () => { friendPickerOpen.value = false })

// —— S6 AI 开盘助手：把口水题锻造成无歧义判定标准 ——
const criteria = ref('') // 锻造出的判定标准（展示，可编辑）
const forging = ref(false)
const forgeHint = ref('') // 降级时的提示
const suggestA = ref('') // AI 建议选项 A
const suggestB = ref('') // AI 建议选项 B

async function doForge() {
  if (!title.value.trim() || forging.value) return
  forging.value = true
  forgeHint.value = ''
  suggestA.value = ''
  suggestB.value = ''
  try {
    const r = await forgeCriteria({ title: title.value.trim() })
    if (r.fallback) {
      forgeHint.value = r.hint || 'AI 暂时没空，请手动写清判定标准。'
    } else {
      criteria.value = r.criteria
      suggestA.value = r.optionA
      suggestB.value = r.optionB
    }
  } finally {
    forging.value = false
  }
}

// 一键采用 AI 建议的选项。
function adoptOptions() {
  if (suggestA.value) optionA.value = suggestA.value
  if (suggestB.value) optionB.value = suggestB.value
}

const valid = computed(() => {
  const base = title.value.trim() && optionA.value.trim() && optionB.value.trim()
  if (!base) return false
  if (mode.value === 'banker') {
    return (
      Number(bankerOdds.value) > 1 &&
      Number(bankerCap.value) > 0 &&
      Number(bankerCap.value) <= store.balance
    )
  }
  // match / pool / invite 都要：押额合法（pool 无需赔率；invite 还要至少选一个好友）。
  const stakeOk = Number(ownerStake.value) > 0 && Number(ownerStake.value) <= store.balance
  if (mode.value === 'pool') return stakeOk
  if (mode.value === 'invite') return Number(odds.value) > 1 && stakeOk && selectedFriends.value.length > 0
  return Number(odds.value) > 1 && stakeOk
})

function submit() {
  err.value = ''
  const deadline = deadlinePreset.value > 0 ? Date.now() + deadlinePreset.value * DAY_MS : null
  try {
    if (mode.value === 'invite') {
      // 定向邀约：1v1 约赌口径开盘（冻结我的注），被邀好友延迟响应、第一个同意者成局。
      const m = inviteMatch({
        npcNames: selectedFriends.value.slice(),
        title: title.value.trim(),
        optionA: optionA.value.trim(),
        optionB: optionB.value.trim(),
        ownerSide: ownerSide.value,
        odds: Number(odds.value),
        ownerStake: Number(ownerStake.value),
        mode: 'match',
        sideBet: sideBet.value,
        deadline,
      })
      scheduleInviteResponses(m.id, selectedFriends.value.slice())
      emit('close')
      return
    }
    createMatch({
      title: title.value.trim(),
      optionA: optionA.value.trim(),
      optionB: optionB.value.trim(),
      ownerSide: ownerSide.value,
      odds: Number(odds.value),
      ownerStake: Number(ownerStake.value),
      mode: mode.value,
      bankerOdds: Number(bankerOdds.value),
      bankerCap: Number(bankerCap.value),
      sideBet: sideBet.value,
      deadline,
    })
    emit('close')
  } catch (e) {
    err.value = e.message || '创建失败'
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="sheet">
      <div class="sheet-head">
        <span>开一个赌局</span>
        <button class="x" @click="emit('close')">✕</button>
      </div>

      <label>玩法</label>
      <div class="mode-pick">
        <button
          v-for="mo in MODES"
          :key="mo.key"
          class="mode-btn"
          :class="{ on: mode === mo.key }"
          @click="mode = mo.key"
        >
          <span class="mode-lbl">{{ mo.label }}</span>
          <span class="mode-desc">{{ mo.desc }}</span>
        </button>
      </div>

      <!-- 邀请好友：浮层内选人（可多选），第一个同意者成局 -->
      <template v-if="mode === 'invite'">
        <label>选好友（可多选）</label>
        <div ref="friendPickerRef" class="friend-select">
          <button class="friend-select-trigger" @click="friendPickerOpen = !friendPickerOpen">
            <span>
              选好友（可多选）{{ friendPickerOpen ? '▴' : '▾' }}
              <em>已选 {{ selectedFriends.length }} 人</em>
            </span>
            <b>{{ selectedFriendSummary || '未选择' }}</b>
          </button>
          <div v-if="friendPickerOpen" class="friend-dropdown">
            <button
              v-for="f in friends"
              :key="f.name"
              class="friend-option"
              :class="{ on: selectedFriends.includes(f.name) }"
              @click="toggleFriend(f.name)"
            >
              <span class="friend-option-main"><i>{{ f.emoji }}</i>{{ f.name }}</span>
              <span class="check-box">{{ selectedFriends.includes(f.name) ? '✓' : '' }}</span>
            </button>
            <div v-if="!friends.length" class="friend-empty">还没有好友</div>
          </div>
        </div>
        <div v-if="!friends.length" class="hint faint">还没有好友，先去朋友页加好友。</div>
      </template>

      <label>题目</label>
      <input v-model="title" placeholder="例：老王今晚能赢这局吗？" />

      <button
        class="forge-btn"
        :disabled="!title.trim() || forging"
        @click="doForge"
      >
        <span v-if="forging" class="spinner"></span>
        {{ forging ? 'AI 锻造中…' : '🔮 AI 帮我锻造判定标准' }}
      </button>

      <!-- 锻造结果：判定标准 + 选项建议 -->
      <div v-if="criteria" class="forge-result">
        <div class="fr-label">判定标准（可改）</div>
        <textarea v-model="criteria" class="criteria-area" rows="3"></textarea>
        <div v-if="suggestA || suggestB" class="fr-suggest">
          <span class="fr-tip">AI 建议选项：<b>{{ suggestA }}</b> vs <b>{{ suggestB }}</b></span>
          <button class="adopt-btn" @click="adoptOptions">一键采用</button>
        </div>
      </div>
      <div v-if="forgeHint" class="forge-hint">{{ forgeHint }}</div>

      <div class="two">
        <div>
          <label>选项 A</label>
          <input v-model="optionA" placeholder="赢" />
        </div>
        <div>
          <label>选项 B</label>
          <input v-model="optionB" placeholder="输" />
        </div>
      </div>

      <!-- 我押哪个：约赌/彩池需要选边；坐庄不押边 -->
      <template v-if="mode !== 'banker'">
        <label>我押哪个</label>
        <div class="pick">
          <button :class="{ on: ownerSide === 'A' }" @click="ownerSide = 'A'">
            {{ optionA || '选项 A' }}
          </button>
          <button :class="{ on: ownerSide === 'B' }" @click="ownerSide = 'B'">
            {{ optionB || '选项 B' }}
          </button>
        </div>
      </template>

      <!-- 约赌 / 邀请好友：赔率 + 下注额 -->
      <div v-if="mode === 'match' || mode === 'invite'" class="two">
        <div>
          <label>赔率 (&gt;1)</label>
          <input v-model.number="odds" type="number" step="0.1" min="1.1" />
        </div>
        <div>
          <label>下注额</label>
          <input v-model.number="ownerStake" type="number" min="1" />
        </div>
      </div>

      <!-- 坐庄：我的赔率 + 保证金封顶 -->
      <div v-else-if="mode === 'banker'" class="two">
        <div>
          <label>我开的赔率 (&gt;1)</label>
          <input v-model.number="bankerOdds" type="number" step="0.1" min="1.1" />
        </div>
        <div>
          <label>保证金封顶</label>
          <input v-model.number="bankerCap" type="number" min="1" />
        </div>
      </div>

      <!-- 彩池：只要下注额（赔率动态） -->
      <div v-else-if="mode === 'pool'">
        <label>我先押多少（赔率随两边动态变）</label>
        <input v-model.number="ownerStake" type="number" min="1" />
      </div>

      <!-- S10 截止时间（可选）。到截止仍无人接 → 自动作废、冻结原路退回 -->
      <label>截止时间（可选）</label>
      <div class="deadline-pick">
        <button
          v-for="dl in DEADLINES"
          :key="dl.d"
          class="dl-btn"
          :class="{ on: deadlinePreset === dl.d }"
          @click="deadlinePreset = dl.d"
        >{{ dl.label }}</button>
      </div>
      <div class="hint faint deadline-note">
        ⏰ 到截止仍无人接盘将自动作废，冻结积分原路退回。
      </div>

      <!-- S8 线下文字彩头（可选，三玩法通用）。平台只记录不结算 -->
      <label>线下彩头（可选）</label>
      <input v-model="sideBet" placeholder="例：输的请吃饭 / 一瓶水" maxlength="40" />
      <div class="hint faint sidebet-note">
        📿 文字彩头只做线上记录与还愿标记，不涉及积分/现金结算。
      </div>

      <div class="hint faint" v-if="mode === 'banker'">
        可用积分 {{ store.balance.toLocaleString() }}。坐庄将冻结保证金 {{ Number(bankerCap).toLocaleString() }}（你最大亏损，封顶防被薅爆）。
      </div>
      <div class="hint faint" v-else>
        可用积分 {{ store.balance.toLocaleString() }}。创建后将冻结你的下注额。
      </div>
      <div v-if="err" class="err">{{ err }}</div>

      <button class="btn block" :disabled="!valid" @click="submit">
        {{ mode === 'banker' ? '开庄收注' : mode === 'pool' ? '开彩池' : mode === 'invite' ? '发出邀约' : '创建赌局' }}
      </button>
      <div class="bet-slogan">{{ SLOGAN_BATTLE }}</div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 35, 48, 0.34);
  backdrop-filter: blur(10px);
  z-index: 50;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.sheet {
  width: 100%;
  max-width: 480px;
  background: var(--bg-card);
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  border: 1px solid var(--border);
  padding: 16px 16px 28px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 -18px 48px rgba(15, 23, 42, 0.14);
}
.sheet-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 14px;
}
.x { color: var(--text-dim); font-size: 16px; }
label {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin: 12px 0 6px;
}
.two { display: flex; gap: 10px; }
.two > div { flex: 1; }
/* 玩法选择（4 张卡 2×2） */
.mode-pick { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.mode-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 8px;
  border-radius: 8px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  text-align: left;
}
.mode-btn.on { border-color: var(--blue); background: rgba(93, 220, 213, 0.13); }
/* 邀请好友：折叠下拉多选 */
.friend-select { position: relative; }
.friend-select-trigger {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 11px;
  border-radius: 8px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  color: var(--text);
  text-align: left;
}
.friend-select-trigger span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  font-weight: 800;
}
.friend-select-trigger em {
  color: var(--text-faint);
  font-size: 11px;
  font-style: normal;
  font-weight: 600;
}
.friend-select-trigger b {
  min-width: 0;
  color: var(--blue);
  font-size: 12px;
  font-weight: 800;
  overflow-wrap: anywhere;
  text-align: right;
}
.friend-dropdown {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  max-height: 236px;
  overflow-y: auto;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.18);
}
.friend-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 9px;
  border-radius: 8px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 13px;
}
.friend-option.on { border-color: var(--blue); background: rgba(93, 220, 213, 0.13); color: var(--blue); }
.friend-option-main { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; }
.friend-option-main i { font-style: normal; font-size: 20px; }
.check-box {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid var(--border);
  color: var(--blue);
  font-weight: 900;
}
.friend-empty {
  padding: 12px;
  color: var(--text-dim);
  text-align: center;
  font-size: 13px;
}
.mode-lbl { font-size: 13px; font-weight: 700; color: var(--text); }
.mode-btn.on .mode-lbl { color: var(--blue); }
.mode-desc { font-size: 10px; color: var(--text-dim); line-height: 1.3; }

.pick { display: flex; gap: 10px; }
.pick button {
  flex: 1;
  padding: 10px;
  border-radius: 8px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-weight: 600;
  font-size: 13px;
}
.pick button.on { background: var(--brand-gradient); color: #fff; border-color: var(--blue); }
.hint { font-size: 12px; margin: 14px 0 4px; }
.sidebet-note { margin: 6px 0 0; color: var(--amber); }
/* S10 截止时间预设 */
.deadline-pick { display: flex; gap: 8px; }
.dl-btn {
  flex: 1;
  padding: 8px;
  border-radius: 8px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-weight: 600;
  font-size: 13px;
}
.dl-btn.on { background: var(--brand-gradient); color: #fff; border-color: var(--blue); }
.deadline-note { margin: 6px 0 0; color: var(--text-dim); }
.err { color: var(--red); font-size: 13px; margin: 8px 0; }
.btn.block { margin-top: 14px; }

/* ── S6 AI 开盘助手 ── */
.forge-btn {
  width: 100%;
  margin-top: 10px;
  padding: 10px;
  border-radius: 8px;
  background: rgba(93, 220, 213, 0.14);
  border: 1px dashed var(--blue);
  color: var(--blue);
  font-weight: 600;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.forge-btn:disabled { opacity: 0.55; }
.forge-btn:active:not(:disabled) { background: rgba(93, 220, 213, 0.22); }
.forge-result {
  margin-top: 10px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
}
.fr-label { font-size: 11px; color: var(--text-dim); margin-bottom: 6px; font-weight: 600; }
.criteria-area {
  width: 100%;
  resize: vertical;
  font-size: 13px;
  line-height: 1.5;
}
.fr-suggest {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.fr-tip { font-size: 12px; color: var(--text-dim); }
.fr-tip b { color: var(--text); }
.adopt-btn {
  font-size: 12px;
  font-weight: 600;
  color: var(--blue);
  padding: 4px 10px;
  border: 1px solid var(--blue);
  border-radius: 6px;
  flex: 0 0 auto;
}
.adopt-btn:active { background: var(--blue-dim); }
.forge-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--amber);
  background: rgba(224, 184, 92, 0.1);
  padding: 8px 10px;
  border-radius: 6px;
  line-height: 1.5;
}
.bet-slogan {
  margin-top: 8px;
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--text-faint);
}
</style>
