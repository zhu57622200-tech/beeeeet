<script setup>
import { ref, computed } from 'vue'
import { register, login, me, EMOJIS } from '../store.js'

const emit = defineEmits(['done'])

// 本机已有账号 → 默认进"登录/找回"模式，否则"注册"模式。
const hasAccount = computed(() => !!me()?.name)
const mode = ref(hasAccount.value ? 'login' : 'register')

const name = ref('')
const password = ref('')
const phone = ref('')
const emoji = ref('🫵')
const showEmojiPicker = ref(false)
const err = ref('')
const agreed = ref(false) // S10 准入声明：注册前必须勾选同意

function submit() {
  err.value = ''
  try {
    if (mode.value === 'register') {
      register({ name: name.value, password: password.value, phone: phone.value, emoji: emoji.value, agreedTerms: agreed.value })
    } else {
      login({ name: name.value, password: password.value })
    }
    emit('done')
  } catch (e) {
    err.value = e.message || '操作失败'
  }
}
</script>

<template>
  <div class="login-root">
    <div class="card login-card">
      <div class="brand-stage">
        <div class="table-mark">PREDICTION GAME</div>
        <div class="logo-wrap" aria-label="買定離手">
          <div class="logo" aria-hidden="true">買定離手</div>
        </div>
        <div class="brand-name-en" aria-label="beeeeet">beeeeet</div>
        <p class="slogan">你的每一次预测，都是你认知的变现</p>
      </div>

      <div class="seg">
        <button :class="{ on: mode === 'register' }" @click="mode = 'register'">注册新账号</button>
        <button :class="{ on: mode === 'login' }" @click="mode = 'login'">换账号/找回</button>
      </div>

      <label class="field-label">昵称</label>
      <input v-model="name" autocomplete="username" placeholder="熟人圈里大家怎么叫你" @keyup.enter="submit" />
      <label class="field-label">密码</label>
      <input v-model="password" type="password" autocomplete="current-password" placeholder="换设备靠昵称+密码找回" @keyup.enter="submit" />

      <!-- S10 准入声明（合规必做）：注册时必须勾选才能创建账号 -->
      <div v-if="mode === 'register'" class="register-extra">
        <label class="field-label">手机号</label>
        <input
          v-model="phone"
          type="tel"
          inputmode="numeric"
          autocomplete="tel"
          maxlength="11"
          placeholder="用于好友找到你，不对外显示"
          @keyup.enter="submit"
        />

        <label class="field-label">头像</label>
        <div class="signup-avatar">
          <button class="avatar-current" @click="showEmojiPicker = !showEmojiPicker">{{ emoji }}</button>
          <div v-if="showEmojiPicker" class="signup-emoji-picker">
            <button
              v-for="e in EMOJIS"
              :key="e"
              class="emoji-opt"
              :class="{ on: e === emoji }"
              @click="emoji = e; showEmojiPicker = false"
            >{{ e }}</button>
          </div>
        </div>
      </div>

      <div v-if="mode === 'register'" class="terms">
        <label class="terms-check">
          <input type="checkbox" v-model="agreed" />
          <span>
            我已年满 18 周岁，理解本产品仅供<b>成年熟人之间虚拟娱乐</b>，
            积分<b>永不可兑现、不对应任何现实金钱</b>，<b>非赌博</b>。
          </span>
        </label>
        <div class="hint faint" style="margin-top:8px">注册即送 100 万积分。</div>
      </div>
      <div v-else class="hint faint">用注册时的昵称+密码恢复账号。</div>

      <div v-if="err" class="err">{{ err }}</div>
      <button class="btn block" :disabled="mode === 'register' && !agreed" @click="submit">
        {{ mode === 'register' ? '创建账号，领 100 万' : '进入' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.login-root {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 0%, rgba(93, 220, 213, 0.11), transparent 46%),
    linear-gradient(180deg, #fbfbfd 0%, #f5f5f7 100%);
}
/* 背景两团青色光晕极缓慢漂移（只动 transform，GPU 合成层） */
.login-root::before,
.login-root::after {
  content: '';
  position: absolute;
  width: 360px;
  height: 360px;
  border-radius: 50%;
  pointer-events: none;
  will-change: transform;
}
.login-root::before {
  top: -120px;
  left: -100px;
  background: radial-gradient(circle, rgba(93, 220, 213, 0.16), transparent 64%);
  animation: auroraDrift 14s ease-in-out infinite;
}
.login-root::after {
  bottom: -140px;
  right: -120px;
  background: radial-gradient(circle, rgba(15, 83, 110, 0.1), transparent 64%);
  animation: auroraDrift 18s ease-in-out infinite reverse;
}
@keyframes auroraDrift {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(46px, 30px) scale(1.12); }
}
.login-card {
  position: relative;
  width: 100%;
  max-width: 380px;
  padding: 22px 20px 26px;
  overflow: hidden;
  animation: cardRise .55s cubic-bezier(.22, .9, .32, 1) both;
  background:
    linear-gradient(180deg, rgba(93, 220, 213, 0.045), rgba(93, 220, 213, 0.018) 24%, transparent 52%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(250, 251, 253, 0.98));
  border-color: rgba(14, 80, 106, 0.11);
  border-radius: 18px;
  box-shadow:
    0 22px 60px rgba(15, 23, 42, 0.13),
    inset 0 1px 0 rgba(255, 255, 255, 0.92);
}
.login-card::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  background:
    linear-gradient(90deg, transparent, rgba(93, 220, 213, 0.22), transparent) top / 100% 1px no-repeat,
    linear-gradient(180deg, rgba(14, 80, 106, 0.025), transparent 54%);
}
.brand-stage {
  position: relative;
  margin: -2px -4px 18px;
  padding: 8px 0 16px;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(93, 220, 213, 0.1) 0%, rgba(93, 220, 213, 0.045) 48%, rgba(255, 255, 255, 0) 100%);
  text-align: center;
}
/* 品牌区错峰浮现：标记→logo→英文名→slogan 依次淡入上浮 */
.table-mark { animation: brandRise .5s ease-out .1s both; }
.logo-wrap { animation: brandRise .55s ease-out .22s both; }
.brand-name-en { animation: brandRise .55s ease-out .36s both; }
.slogan { animation: brandRise .55s ease-out .5s both; }
@keyframes brandRise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes cardRise {
  from { opacity: 0; transform: translateY(18px) scale(.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.table-mark {
  margin-bottom: 9px;
  color: rgba(14, 80, 106, 0.54);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0;
}
.logo-wrap {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  width: min(306px, 100%);
  margin: 0 auto 8px;
  padding: 13px 18px 14px;
  isolation: isolate;
}
.logo-wrap::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -2;
  border: 1px solid rgba(15, 83, 110, 0.16);
  border-radius: 16px;
  background:
    radial-gradient(circle at 50% 46%, rgba(93, 220, 213, 0.13), transparent 62%),
    linear-gradient(180deg, #ffffff 0%, #fafbfd 48%, #f4f7fa 100%);
  box-shadow:
    0 16px 34px rgba(15, 83, 110, 0.12),
    0 0 0 1px rgba(255, 255, 255, 0.8),
    inset 0 1px 0 rgba(255, 255, 255, 0.94);
}
.logo-wrap::after {
  content: none;
  position: absolute;
  left: 12px;
  top: 50%;
  width: 4px;
  height: 28px;
  border-radius: 999px;
  background: #2e5cff;
  box-shadow: 0 0 18px rgba(46, 92, 255, 0.85);
  transform: translateY(-50%);
}
.logo {
  position: relative;
  font-family: 'LINE Seed Sans TC', 'LINE Seed Sans SC', 'Noto Sans CJK TC', 'Noto Sans CJK SC', 'Noto Sans SC', 'PingFang TC', 'PingFang SC', sans-serif;
  font-size: clamp(40px, 10vw, 45px);
  line-height: 1;
  font-weight: 900;
  letter-spacing: 0;
  text-align: center;
  color: #0f536e;
  /* 高光层在前、品牌渐变在后，均裁剪到文字；入场后高光扫过一次 */
  background:
    linear-gradient(105deg, transparent 42%, rgba(255, 255, 255, 0.88) 50%, transparent 58%) no-repeat -180% 0 / 220% 100%,
    linear-gradient(180deg, #0b4863 0%, #0f536e 52%, #177f91 100%);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  transform: scaleX(1.04);
  text-shadow: none;
  animation: logoSheen 1.3s ease-in-out .75s 1;
}
@keyframes logoSheen {
  from { background-position: -180% 0, 0 0; }
  to { background-position: 300% 0, 0 0; }
}
.logo::after {
  content: none;
  position: absolute;
  left: -4px;
  right: -4px;
  bottom: -5px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(93, 220, 213, 0.92), transparent);
  opacity: 0.72;
}
.brand-name-en {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 10px;
  color: #0f536e;
  font-family: Manrope, ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 32px;
  line-height: 0.95;
  font-weight: 800;
  letter-spacing: 0;
  background: linear-gradient(90deg, #0b4863 0%, #0f536e 54%, #188696 100%);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  isolation: isolate;
  text-shadow: none;
}
.brand-name-en::after {
  content: none;
  position: absolute;
  left: 24%;
  right: 12%;
  bottom: 0;
  height: 7px;
  border-radius: 999px;
  background: rgba(93, 220, 213, 0.24);
  filter: blur(7px);
  z-index: -1;
}
.slogan {
  max-width: 280px;
  margin: 0 auto;
  color: #314657;
  font-size: 14px;
  line-height: 1.55;
  font-weight: 600;
}
.seg {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  padding: 4px;
  border: 1px solid rgba(15, 83, 110, 0.12);
  border-radius: 12px;
  background: #f2f4f7;
}
.seg button {
  flex: 1;
  min-height: 42px;
  padding: 9px 8px;
  border-radius: 9px;
  background: transparent;
  border: 1px solid transparent;
  color: #617083;
  font-weight: 600;
  font-size: 13px;
  transition: background .18s, border-color .18s, color .18s, box-shadow .18s;
}
.seg button.on {
  background: linear-gradient(180deg, #17637f, #0f536e);
  color: #fff;
  border-color: rgba(93, 220, 213, 0.46);
  box-shadow: 0 10px 24px rgba(15, 83, 110, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.26);
}
.field-label {
  display: block;
  color: #526173;
  font-size: 12px;
  font-weight: 700;
  margin: 12px 0 7px;
}
.login-card input:not([type='checkbox']) {
  min-height: 44px;
  background: #f7f8fa;
  border-color: rgba(15, 83, 110, 0.12);
  border-radius: 10px;
  color: #172330;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
}
.login-card input:not([type='checkbox']):focus {
  border-color: #0f536e;
  box-shadow: 0 0 0 3px rgba(93, 220, 213, 0.2);
}
.login-card input::placeholder {
  color: rgba(82, 97, 115, 0.58);
}
.register-extra { margin-top: 2px; }
.signup-avatar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
}
.avatar-current {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #f7f8fa;
  border: 1px solid rgba(15, 83, 110, 0.12);
  font-size: 26px;
}
.signup-emoji-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.emoji-opt {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: #f7f8fa;
  border: 1px solid rgba(15, 83, 110, 0.12);
  font-size: 20px;
}
.emoji-opt.on {
  border-color: #0f536e;
  background: rgba(93, 220, 213, 0.14);
}
.hint { font-size: 12px; margin: 14px 0 4px; line-height: 1.5; }
.err { color: var(--red); font-size: 13px; margin: 8px 0; }
.login-card .btn.block {
  min-height: 44px;
  margin-top: 18px;
  border: 1px solid rgba(93, 220, 213, 0.46);
  background: linear-gradient(180deg, #17637f, #0f536e);
  color: #fff;
  box-shadow: 0 12px 26px rgba(15, 83, 110, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.28);
}
.login-card .btn.block:disabled {
  opacity: 1;
  border-color: rgba(82, 97, 115, 0.16);
  background: linear-gradient(180deg, #e8ebef, #dfe3e8);
  color: rgba(82, 97, 115, 0.58);
  box-shadow: none;
}
/* 准入声明 */
.terms {
  margin: 16px 0 4px;
  background:
    linear-gradient(180deg, rgba(93, 220, 213, 0.08), rgba(93, 220, 213, 0.025)),
    #f7f8fa;
  border: 1px solid rgba(15, 83, 110, 0.12);
  border-radius: 10px;
  padding: 13px 12px;
}
.terms-check { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
.terms-check input {
  margin-top: 3px;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  accent-color: #0f536e;
}
.terms-check span { font-size: 12px; line-height: 1.65; color: #526173; }
.terms-check b { color: #172330; }

@media (prefers-reduced-motion: reduce) {
  .login-root::before, .login-root::after { animation: none; }
  .login-card, .table-mark, .logo-wrap, .brand-name-en, .slogan { animation: none; }
  .logo { animation: none; }
}
</style>
