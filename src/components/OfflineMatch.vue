<script setup>
import { ref, computed } from 'vue'
import { store, NPCS, recordOfflineMatch } from '../store.js'

const emit = defineEmits(['close'])

// 线下项目选项。
const SPORTS = ['网球', '羽毛球', '台球', '乒乓球', '篮球', '飞镖', '其它']

const rivalName = ref(NPCS[0]?.name || '')
const sport = ref('网球')
const score = ref('')
const iWon = ref(true)
const useStake = ref(false) // 是否挂积分赌注
const stake = ref(10000)
const sideBet = ref('') // 可选文字彩头
const err = ref('')

const rivalEmoji = computed(
  () => store.players.find((p) => !p.isMe && p.name === rivalName.value)?.emoji || '🙂'
)

const valid = computed(() => {
  if (!rivalName.value || !sport.value) return false
  if (useStake.value) {
    const s = Number(stake.value)
    if (!(s > 0)) return false
    // 输且挂积分时需余额够（赢则进账，不限）。
    if (!iWon.value && s > store.balance) return false
  }
  return true
})

function submit() {
  err.value = ''
  try {
    recordOfflineMatch({
      rivalName: rivalName.value,
      sport: sport.value,
      score: score.value,
      iWon: iWon.value,
      stake: useStake.value ? Number(stake.value) : 0,
      sideBet: sideBet.value,
    })
    emit('close')
  } catch (e) {
    err.value = e.message || '记录失败'
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="sheet">
      <div class="sheet-head">
        <span>记录线下对战</span>
        <button class="x" @click="emit('close')">✕</button>
      </div>

      <label>对手</label>
      <div class="rival-pick">
        <button
          v-for="n in NPCS"
          :key="n.name"
          class="rival-btn"
          :class="{ on: rivalName === n.name }"
          @click="rivalName = n.name"
        >
          <span class="re">{{ n.emoji }}</span>{{ n.name }}
        </button>
      </div>

      <label>项目</label>
      <div class="sport-pick">
        <button
          v-for="s in SPORTS"
          :key="s"
          class="sport-btn"
          :class="{ on: sport === s }"
          @click="sport = s"
        >{{ s }}</button>
      </div>

      <label>最终比分（可选）</label>
      <input v-model="score" placeholder="例：6-4 / 21-18 / 3:1" maxlength="20" />

      <label>结果</label>
      <div class="pick">
        <button :class="{ on: iWon }" @click="iWon = true">我赢了 🏆</button>
        <button :class="{ on: !iWon }" @click="iWon = false">我输了 💀</button>
      </div>

      <label class="stake-toggle">
        <input type="checkbox" v-model="useStake" />
        挂积分赌注（按胜负真结算我的积分）
      </label>
      <div v-if="useStake">
        <input v-model.number="stake" type="number" min="1" />
        <div class="hint faint">
          挂 {{ Number(stake).toLocaleString() }} 积分：{{ iWon ? '赢则进账' : '输则扣除' }}。可用 {{ store.balance.toLocaleString() }}。
        </div>
      </div>

      <label>线下彩头（可选）</label>
      <input v-model="sideBet" placeholder="例：输的请吃饭 / 一瓶水" maxlength="40" />
      <div class="hint faint sidebet-note">📿 文字彩头只记录与还愿，不涉及积分/现金结算。</div>

      <div v-if="err" class="err">{{ err }}</div>
      <button class="btn block" :disabled="!valid" @click="submit">
        记录这盘 {{ rivalEmoji }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; background: rgba(15, 35, 48, 0.34); z-index: 50;
  backdrop-filter: blur(10px);
  display: flex; align-items: flex-end; justify-content: center;
}
.sheet {
  width: 100%; max-width: 480px; background: var(--bg-card);
  border-top-left-radius: 16px; border-top-right-radius: 16px;
  border: 1px solid var(--border); padding: 16px 16px 28px;
  max-height: 90vh; overflow-y: auto;
  box-shadow: 0 -18px 48px rgba(15, 23, 42, 0.14);
}
.sheet-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 16px; font-weight: 700; margin-bottom: 14px;
}
.x { color: var(--text-dim); font-size: 16px; }
label { display: block; font-size: 12px; color: var(--text-dim); margin: 12px 0 6px; }

.rival-pick, .sport-pick { display: flex; flex-wrap: wrap; gap: 8px; }
.rival-btn, .sport-btn {
  padding: 8px 10px; border-radius: 8px; font-size: 13px; font-weight: 600;
  background: var(--bg-card-2); border: 1px solid var(--border); color: var(--text-dim);
}
.rival-btn .re { margin-right: 4px; }
.rival-btn.on, .sport-btn.on { border-color: var(--blue); background: rgba(93, 220, 213, 0.13); color: var(--blue); }

.pick { display: flex; gap: 10px; }
.pick button {
  flex: 1; padding: 10px; border-radius: 8px;
  background: var(--bg-card-2); border: 1px solid var(--border);
  color: var(--text-dim); font-weight: 600; font-size: 13px;
}
.pick button.on { background: var(--brand-gradient); color: #fff; border-color: var(--blue); }

.stake-toggle {
  display: flex; align-items: center; gap: 8px; font-size: 13px;
  color: var(--text); margin-top: 14px;
}
.stake-toggle input { width: auto; }
.hint { font-size: 12px; margin: 8px 0 4px; }
.sidebet-note { color: var(--amber); }
.err { color: var(--red); font-size: 13px; margin: 8px 0; }
.btn.block { margin-top: 14px; }
</style>
