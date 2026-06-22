<script setup>
import { ref, computed, onMounted } from 'vue'
import {
  store,
  isFriend,
  inviteMatch,
  npcAcceptInvite,
  npcBetBanker,
  npcBetPool,
  seedInboxInvites,
  inboxPendingCount,
  acceptInboxInvite,
  declineInboxInvite,
} from '../store.js'
import { forgeCriteria } from '../api.js'

const emit = defineEmits(['open'])
const props = defineProps({
  initialSelected: {
    type: Array,
    default: () => [],
  },
})
const tab = ref('inbox')

const pendingCount = computed(() => inboxPendingCount())
const pendingInvites = computed(() => store.inbox.filter((x) => x.status === 'pending'))

onMounted(() => {
  if (inboxPendingCount() < 3) seedInboxInvites(3)
  const valid = new Set(friends.value.map((f) => f.name))
  const picked = props.initialSelected.filter((name) => valid.has(name))
  picked.forEach((name) => {
    if (!selected.value.includes(name)) selected.value.push(name)
  })
  if (picked.length) tab.value = 'outgoing'
})

function mySideLabel(inv) {
  return inv.mySide === 'A' ? inv.optionA : inv.optionB
}
function fmtStake(n) {
  return Number(n || 0).toLocaleString()
}
function acceptInvite(id) {
  const m = acceptInboxInvite(id)
  if (m) emit('open', 'match', { id: m.id })
}
function declineInvite(id) {
  declineInboxInvite(id)
}

// —— 好友清单（本地 demo：NPC 当熟人好友，可多选邀请）——
// 取 players 里的 NPC（非"我"），有真实战绩/称号，更像熟人。
const friends = computed(() => store.players.filter((p) => !p.isMe && isFriend(p.name)))
const selected = ref([]) // 选中的好友名

function toggleFriend(name) {
  const i = selected.value.indexOf(name)
  if (i === -1) selected.value.push(name)
  else selected.value.splice(i, 1)
}
function isSelected(name) {
  return selected.value.includes(name)
}

// —— 赌局规则（复用约赌表单字段）——
const title = ref('')
const optionA = ref('')
const optionB = ref('')
const ownerSide = ref('A')
const odds = ref(2)
const ownerStake = ref(10000)
const sideBet = ref('')
const err = ref('')

// —— S7 玩法选择：约赌撮合 / 我坐庄 / 彩池（复用 CreateMatch 的玩法地基）——
const mode = ref('match') // 'match' | 'banker' | 'pool'
const bankerOdds = ref(2) // 坐庄：我自设赔率
const bankerCap = ref(50000) // 坐庄：保证金封顶(我最大亏损)
const MODES = [
  { key: 'match', label: '约赌撮合', desc: '1v1 固定赔率，谁敢接' },
  { key: 'banker', label: '我坐庄', desc: '自设赔率收注，保证金封顶' },
  { key: 'pool', label: '彩池', desc: '两边站队，赢方瓜分输方' },
]

// —— AI 开盘助手（复用 forgeCriteria）——
const criteria = ref('')
const forging = ref(false)
const forgeHint = ref('')
const suggestA = ref('')
const suggestB = ref('')

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
function adoptOptions() {
  if (suggestA.value) optionA.value = suggestA.value
  if (suggestB.value) optionB.value = suggestB.value
}

const valid = computed(() => {
  if (!selected.value.length) return false
  if (!title.value.trim() || !optionA.value.trim() || !optionB.value.trim()) return false
  if (mode.value === 'banker') {
    return Number(bankerOdds.value) > 1 && Number(bankerCap.value) > 0 && Number(bankerCap.value) <= store.balance
  }
  const stakeOk = Number(ownerStake.value) > 0 && Number(ownerStake.value) <= store.balance
  if (mode.value === 'pool') return stakeOk
  return Number(odds.value) > 1 && stakeOk
})

// —— 发起邀约 → NPC 模拟同意 → 成局 ——
// invitees: [{ name, emoji, status: 'pending'|'agreed' }]；matchId 记成局后的局 id。
const phase = ref('form') // 'form' | 'inviting' | 'done'
const invitees = ref([])
const matchId = ref(null)
let timers = []

function clearTimers() {
  timers.forEach((t) => clearTimeout(t))
  timers = []
}

function startInvite() {
  err.value = ''
  let m
  try {
    m = inviteMatch({
      npcNames: selected.value.slice(),
      title: title.value.trim(),
      optionA: optionA.value.trim(),
      optionB: optionB.value.trim(),
      mode: mode.value,
      ownerSide: ownerSide.value,
      odds: Number(odds.value),
      ownerStake: Number(ownerStake.value),
      bankerOdds: Number(bankerOdds.value),
      bankerCap: Number(bankerCap.value),
      sideBet: sideBet.value,
    })
  } catch (e) {
    err.value = e.message || '发起失败'
    return
  }
  matchId.value = m.id
  invitees.value = selected.value.map((name) => {
    const npc = friends.value.find((f) => f.name === name)
    return { name, emoji: npc?.emoji || '🙂', status: 'pending' }
  })
  phase.value = 'inviting'
  // 每个被邀好友：0.5~2s 随机延时后"模拟同意"，像真人陆续响应。
  invitees.value.forEach((inv, i) => {
    const delay = 500 + Math.random() * 1500 + i * 300
    timers.push(
      setTimeout(() => {
        // 按玩法模拟被邀好友响应：约赌=接盘同意；坐庄/彩池=定向下注站队。
        if (mode.value === 'banker') npcBetBanker(matchId.value, inv.name)
        else if (mode.value === 'pool') npcBetPool(matchId.value, inv.name)
        else npcAcceptInvite(matchId.value, inv.name)
        inv.status = 'agreed'
        if (invitees.value.every((x) => x.status === 'agreed')) phase.value = 'done'
      }, delay)
    )
  })
}

// 进对赌中：跳到该局详情。
function goMatch() {
  clearTimers()
  emit('open', 'match', { id: matchId.value })
}

// 再约一局：重置表单回到选人。
function reset() {
  clearTimers()
  phase.value = 'form'
  selected.value = []
  title.value = ''
  optionA.value = ''
  optionB.value = ''
  ownerSide.value = 'A'
  odds.value = 2
  ownerStake.value = 10000
  mode.value = 'match'
  bankerOdds.value = 2
  bankerCap.value = 50000
  sideBet.value = ''
  criteria.value = ''
  suggestA.value = ''
  suggestB.value = ''
  forgeHint.value = ''
  err.value = ''
  invitees.value = []
  matchId.value = null
}

const agreedCount = computed(() => invitees.value.filter((x) => x.status === 'agreed').length)
</script>

<template>
  <div class="invite-wrap">
    <div class="inv-tabs">
      <button class="inv-tab" :class="{ on: tab === 'inbox' }" @click="tab = 'inbox'">
        <span>📨 收到的</span>
        <span v-if="pendingCount" class="inv-badge">{{ pendingCount }}</span>
      </button>
      <button class="inv-tab" :class="{ on: tab === 'outgoing' }" @click="tab = 'outgoing'">✉️ 我发起</button>
    </div>

    <template v-if="tab === 'inbox'">
      <div v-if="pendingInvites.length" class="inv-list">
        <div v-for="inv in pendingInvites" :key="inv.id" class="inv-card">
          <div class="inv-head">
            <span class="inv-emoji">{{ inv.fromEmoji }}</span>
            <div class="inv-who">
              <b>{{ inv.fromName }}</b>
              <span class="faint">邀请你赌一局：{{ inv.title }}</span>
            </div>
          </div>
          <div class="inv-meta faint">
            你押 {{ mySideLabel(inv) }} · 赔率 {{ inv.odds }} · 下注 {{ fmtStake(inv.stake) }}
          </div>
          <div class="inv-actions">
            <button class="inv-accept" @click="acceptInvite(inv.id)">同意</button>
            <button class="inv-decline" @click="declineInvite(inv.id)">拒绝</button>
          </div>
        </div>
      </div>
      <div v-else class="inv-empty">📭 暂时没有新邀请</div>
    </template>

    <template v-else>
    <!-- 扫码邀请占位（接云后开放）-->
    <div class="qr-placeholder">
      <span class="qr-ico">📷</span>
      <div class="qr-text">
        <b>扫码邀请好友</b>
        <span class="faint">上线后开放，现在先从熟人清单约一局</span>
      </div>
    </div>

    <!-- 阶段一：选人 + 设规则 -->
    <template v-if="phase === 'form'">
      <div class="sec-label">选好友（可多选）</div>
      <div class="friends">
        <button
          v-for="f in friends"
          :key="f.name"
          class="friend"
          :class="{ on: isSelected(f.name) }"
          @click="toggleFriend(f.name)"
        >
          <span class="f-emoji">{{ f.emoji }}</span>
          <span class="f-name">{{ f.name }}</span>
          <span class="f-title faint">{{ f.title }}</span>
          <span v-if="isSelected(f.name)" class="f-check">✓</span>
        </button>
        <div v-if="!friends.length" class="inv-empty">还没有好友，先去朋友页加好友。</div>
      </div>

      <div class="sec-label">设赌局规则</div>
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
      <label>题目</label>
      <input v-model="title" placeholder="例：周末这局谁赢？" />
      <button class="forge-btn" :disabled="!title.trim() || forging" @click="doForge">
        <span v-if="forging" class="spinner"></span>
        {{ forging ? 'AI 锻造中…' : '🔮 AI 帮我锻造判定标准' }}
      </button>
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

      <!-- 约赌/彩池要选边；坐庄不押边（与 CreateMatch 一致） -->
      <template v-if="mode !== 'banker'">
        <label>我押哪个</label>
        <div class="pick">
          <button :class="{ on: ownerSide === 'A' }" @click="ownerSide = 'A'">{{ optionA || '选项 A' }}</button>
          <button :class="{ on: ownerSide === 'B' }" @click="ownerSide = 'B'">{{ optionB || '选项 B' }}</button>
        </div>
      </template>

      <!-- 约赌：赔率 + 下注额 -->
      <div v-if="mode === 'match'" class="two">
        <div>
          <label>赔率 (&gt;1)</label>
          <input v-model.number="odds" type="number" step="0.1" min="1.1" />
        </div>
        <div>
          <label>下注额</label>
          <input v-model.number="ownerStake" type="number" min="1" />
        </div>
      </div>

      <!-- 坐庄：我开的赔率 + 保证金封顶 -->
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
      <div v-else>
        <label>我先押多少（赔率随两边动态变）</label>
        <input v-model.number="ownerStake" type="number" min="1" />
      </div>

      <label>线下彩头（可选）</label>
      <input v-model="sideBet" placeholder="例：输的请吃饭 / 一瓶水" maxlength="40" />
      <div class="hint faint">📿 文字彩头只做线上记录与还愿标记，不涉及积分/现金结算。</div>

      <div class="hint faint">
        可用积分 {{ store.balance.toLocaleString() }}。发起后冻结你的下注额，等好友同意成局。
        熟人虚拟积分对赌，积分永不可兑现。
      </div>
      <div v-if="err" class="err">{{ err }}</div>
      <button class="btn block" :disabled="!valid" @click="startInvite">
        发起邀约（已选 {{ selected.length }} 人）
      </button>
    </template>

    <!-- 阶段二/三：邀约响应中 / 成局 -->
    <template v-else>
      <div class="sec-label">{{ phase === 'done' ? '🎉 邀约已成局' : '⏳ 等好友响应…' }}</div>
      <div class="match-brief">
        <div class="mb-title">「{{ title }}」</div>
        <div class="mb-meta faint">
          <template v-if="mode === 'banker'">我坐庄 · 赔率 {{ bankerOdds }} · 保证金 {{ Number(bankerCap).toLocaleString() }}</template>
          <template v-else-if="mode === 'pool'">彩池 · 我押 {{ ownerSide === 'A' ? optionA : optionB }} {{ Number(ownerStake).toLocaleString() }}</template>
          <template v-else>我押 {{ ownerSide === 'A' ? optionA : optionB }} · 赔率 {{ odds }} · 下注 {{ Number(ownerStake).toLocaleString() }}</template>
        </div>
      </div>

      <div class="invitees">
        <div v-for="inv in invitees" :key="inv.name" class="inv-row">
          <span class="iv-emoji">{{ inv.emoji }}</span>
          <span class="iv-name">{{ inv.name }}</span>
          <span class="iv-status" :class="inv.status">
            {{ inv.status === 'agreed' ? (mode === 'match' ? '已同意 ✓' : '已下注 ✓') : '邀请中…' }}
          </span>
        </div>
      </div>

      <div class="invite-tip faint">
        <template v-if="mode === 'match'">{{ agreedCount }}/{{ invitees.length }} 已同意。第一个同意的好友接盘成局，可进对赌中。</template>
        <template v-else>{{ agreedCount }}/{{ invitees.length }} 已下注/站队，可进局查看。</template>
      </div>

      <button class="btn block" :disabled="agreedCount === 0" @click="goMatch">
        进对赌中查看 →
      </button>
      <button class="btn ghost block" style="margin-top:10px" @click="reset">再约一局</button>
    </template>
    </template>
  </div>
</template>

<style scoped>
.invite-wrap { padding: 16px; }
.invite-wrap :deep(.faint) { color: var(--text-dim); }

.inv-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 14px;
}
.inv-tab {
  min-width: 0;
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 14px;
  font-weight: 700;
}
.inv-tab.on {
  color: var(--blue);
  border-color: var(--blue);
  background: rgba(93, 220, 213, 0.13);
}
.inv-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--red);
  color: #fff;
  font-size: 11px;
  line-height: 1;
}
.inv-list { display: flex; flex-direction: column; gap: 10px; }
.inv-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
}
.inv-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}
.inv-emoji { font-size: 26px; flex: 0 0 auto; line-height: 1; }
.inv-who {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.35;
}
.inv-who b { color: var(--text); font-size: 15px; }
.inv-who span { font-size: 14px; overflow-wrap: anywhere; }
.inv-meta {
  margin-top: 9px;
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.inv-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.inv-actions button {
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 700;
}
.inv-accept {
  color: #fff;
  background: var(--brand-gradient);
  border: 1px solid var(--blue);
}
.inv-decline {
  color: var(--text-dim);
  background: var(--bg-card-2);
  border: 1px solid var(--border);
}
.inv-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  background: var(--bg-card);
  border: 1px dashed var(--border);
  border-radius: 10px;
  color: var(--text-dim);
  font-size: 14px;
}

/* 扫码占位 */
.qr-placeholder {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--bg-card);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: 14px;
  margin-bottom: 16px;
}
.qr-ico { font-size: 33px; flex: 0 0 auto; }
.qr-text { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: var(--text-dim); }
.qr-text b { font-size: 16px; color: var(--text); }
.qr-text .faint { font-size: 12px; color: var(--text-dim); }

.sec-label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  text-transform: uppercase;
  margin: 16px 0 8px;
}

/* 好友清单 */
.friends { display: flex; flex-direction: column; gap: 8px; }
.friend {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  text-align: left;
}
.friend.on { border-color: var(--blue); background: rgba(93, 220, 213, 0.13); }
.f-emoji { font-size: 24px; flex: 0 0 auto; }
.f-name { font-size: 15px; font-weight: 700; color: var(--text); }
.f-title { font-size: 12px; color: var(--text-dim); }
.f-check {
  margin-left: auto;
  color: var(--blue);
  font-weight: 800;
  font-size: 18px;
}

label { display: block; font-size: 13px; color: var(--text-dim); margin: 13px 0 7px; font-weight: 600; }
input, textarea { width: 100%; }
.two { display: flex; gap: 10px; }
.two > div { flex: 1; }
.pick { display: flex; gap: 10px; }
.pick button {
  flex: 1;
  padding: 10px;
  border-radius: 8px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  color: var(--text);
  font-weight: 600;
  font-size: 14px;
}
.pick button.on { background: var(--brand-gradient); color: #fff; border-color: var(--blue); }
/* 玩法选择（与 CreateMatch 同款） */
.mode-pick { display: flex; gap: 8px; }
.mode-btn {
  flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 10px 8px; border-radius: 8px;
  background: var(--bg-card-2); border: 1px solid var(--border); text-align: left;
}
.mode-btn.on { border-color: var(--blue); background: rgba(93, 220, 213, 0.13); }
.mode-lbl { font-size: 13px; font-weight: 700; color: var(--text); }
.mode-btn.on .mode-lbl { color: var(--blue); }
.mode-desc { font-size: 10px; color: var(--text-dim); line-height: 1.3; }
.hint { font-size: 13px; margin: 9px 0 5px; color: var(--text-dim); line-height: 1.55; }
.err { color: var(--red); font-size: 14px; margin: 9px 0; }
.btn.block { margin-top: 16px; }

/* AI 锻造（与 CreateMatch 同款）*/
.forge-btn {
  width: 100%;
  margin-top: 10px;
  padding: 10px;
  border-radius: 8px;
  background: rgba(93, 220, 213, 0.14);
  border: 1px dashed var(--blue);
  color: var(--blue);
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.forge-btn:disabled { opacity: 0.55; }
.forge-result {
  margin-top: 10px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
}
.fr-label { font-size: 12px; color: var(--text-dim); margin-bottom: 7px; font-weight: 700; }
.criteria-area { resize: vertical; font-size: 14px; line-height: 1.55; }
.fr-suggest {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.fr-tip { font-size: 13px; color: var(--text-dim); }
.fr-tip b { color: var(--text); }
.adopt-btn {
  font-size: 13px;
  font-weight: 600;
  color: var(--blue);
  padding: 4px 10px;
  border: 1px solid var(--blue);
  border-radius: 6px;
  flex: 0 0 auto;
}
.forge-hint {
  margin-top: 8px;
  font-size: 13px;
  color: var(--amber);
  background: rgba(224, 184, 92, 0.1);
  padding: 8px 10px;
  border-radius: 6px;
  line-height: 1.5;
}

/* 邀约响应 */
.match-brief {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.mb-title { font-size: 17px; font-weight: 700; }
.mb-meta { font-size: 13px; margin-top: 5px; color: var(--text-dim); }
.invitees { display: flex; flex-direction: column; gap: 8px; }
.inv-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-card-2);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.iv-emoji { font-size: 22px; }
.iv-name { font-size: 15px; font-weight: 700; }
.iv-status { margin-left: auto; font-size: 13px; font-weight: 700; }
.iv-status.pending { color: var(--amber); }
.iv-status.agreed { color: var(--green); }
.invite-tip { font-size: 13px; margin: 14px 0 4px; color: var(--text-dim); }
</style>
