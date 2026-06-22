// 联机版 API client —— §14a 工作流交付物 1。
// 职责：fetch 封装（信封解包、错误码→中文、401 跳登录、幂等键、超时/退避、loading 计数）。
// 组件不直接 import 本文件的 request；写路径统一经 store.js 的 action 调这里。

const API_BASE = import.meta.env?.VITE_API_BASE || '/api/v1'
const TIMEOUT_MS = 15_000
const GET_RETRY_ATTEMPTS = 3
const GET_RETRY_BASE_DELAYS_MS = [500, 1000]
const GET_RETRY_JITTER_MS = 100

// §3 错误码契约（P0 定死，全程不改语义）
export const ERROR_MESSAGES = {
  AUTH_REQUIRED: '请先登录',
  AUTH_EXPIRED: '登录已失效，请重新登录',
  BANNED: '账号已被封禁，联系群主',
  MUTED: '你被群主禁言了，稍后再试',
  NOT_FRIENDS: '加好友后才能私信和约赌',
  FORBIDDEN: '无权限',
  INVITE_INVALID: '邀请码无效',
  INVITE_FULL: '邀请码已满，找群主要新码',
  NAME_TAKEN: '昵称被占用，换一个',
  PHONE_TAKEN: '这个手机号已注册过，试试找回密码',
  BAD_CREDENTIALS: '昵称或密码不对',
  RESET_CODE_INVALID: '重置码无效或已过期，找群主重发',
  RATE_LIMITED: '操作太频繁，稍后再试',
  INSUFFICIENT_BALANCE: '余额不足',
  MATCH_TAKEN: '慢了一步，已被人接走',
  MATCH_NOT_OPEN: '该局当前不可操作',
  TRANSFER_LIMITED: '超出转赠限额',
  VALIDATION: '参数不合法',
  NOT_FOUND: '内容不存在',
  CONFLICT: '状态冲突，请刷新后重试',
  SERVER_BUSY: '服务繁忙，稍后再试',
  NETWORK: '网络不给力，稍后再试',
}

export class ApiClientError extends Error {
  constructor(code, message, { status = 0, retryAfter = 0 } = {}) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.SERVER_BUSY)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

// ---- token 持久化（明文密码绝不落地，§4）----
const TOKEN_KEY = 'bo_token'

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* 私密模式等存储不可用时仅内存态 */ }
}

// 401 时由 store 注册回调跳登录（避免本文件反向依赖 store/router）
let onAuthExpired = null
export function setAuthExpiredHandler(fn) { onAuthExpired = fn }

// ---- loading 计数器（表单按钮 loading 用，全局轮询不计入）----
export const loading = { count: 0 }

// ---- 幂等键 ----
export function newIdempotencyKey(prefix = 'op') {
  const rand = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return `${prefix}-${rand}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getRetryDelay(attemptIndex) {
  const base = GET_RETRY_BASE_DELAYS_MS[Math.min(attemptIndex, GET_RETRY_BASE_DELAYS_MS.length - 1)]
  return base + Math.floor(Math.random() * GET_RETRY_JITTER_MS)
}

function shouldRetryGet(err) {
  return err instanceof ApiClientError && (
    err.code === 'NETWORK' ||
    err.code === 'SERVER_BUSY' ||
    err.status >= 500
  )
}

function shouldRetryWrite(err) {
  return err?.code === 'NETWORK'
}

async function requestOnce(method, path, { body, idempotencyKey, countLoading = true, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })

  if (countLoading) loading.count++
  let res
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    throw new ApiClientError('NETWORK', null, { status: 0 })
  } finally {
    clearTimeout(timer)
    if (countLoading) loading.count--
  }

  let json = null
  try { json = await res.json() } catch { /* 非 JSON 响应按 5xx 处理 */ }

  if (json?.ok === true) return json.data ?? {}

  const code = json?.code || (res.status >= 500 ? 'SERVER_BUSY' : 'VALIDATION')
  const retryAfter = Number(res.headers.get('Retry-After')) || 0
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_EXPIRED') {
    setToken('')
    onAuthExpired?.(code)
  }
  throw new ApiClientError(code, json?.message, { status: res.status, retryAfter })
}

async function rawRequest(method, path, opts = {}) {
  if (method !== 'GET') {
    const canRetryWrite = typeof opts.idempotencyKey === 'string' && opts.idempotencyKey.length > 0
    if (!canRetryWrite) return requestOnce(method, path, opts)

    const countLoading = opts.countLoading !== false
    if (countLoading) loading.count++
    try {
      for (let attempt = 0; attempt < GET_RETRY_ATTEMPTS; attempt++) {
        try {
          return await requestOnce(method, path, { ...opts, countLoading: false })
        } catch (err) {
          const isLastAttempt = attempt === GET_RETRY_ATTEMPTS - 1
          if (isLastAttempt || opts.signal?.aborted || !shouldRetryWrite(err)) throw err
          await sleep(getRetryDelay(attempt))
        }
      }
    } finally {
      if (countLoading) loading.count--
    }
  }

  const countLoading = opts.countLoading !== false
  if (countLoading) loading.count++
  try {
    for (let attempt = 0; attempt < GET_RETRY_ATTEMPTS; attempt++) {
      try {
        return await requestOnce(method, path, { ...opts, countLoading: false })
      } catch (err) {
        const isLastAttempt = attempt === GET_RETRY_ATTEMPTS - 1
        if (isLastAttempt || opts.signal?.aborted || !shouldRetryGet(err)) throw err
        await sleep(getRetryDelay(attempt))
      }
    }
  } finally {
    if (countLoading) loading.count--
  }
}

export const api = {
  get: (path, opts) => rawRequest('GET', path, opts),
  post: (path, body, opts = {}) => rawRequest('POST', path, { ...opts, body }),
  patch: (path, body, opts = {}) => rawRequest('PATCH', path, { ...opts, body }),
  put: (path, body, opts = {}) => rawRequest('PUT', path, { ...opts, body }),
  del: (path, opts) => rawRequest('DELETE', path, opts),
  // 动钱操作统一入口：自动带幂等键
  mutate: (path, body, prefix) => rawRequest('POST', path, { body, idempotencyKey: newIdempotencyKey(prefix) }),
}

// ---- 轮询调度器（§7 节奏：盘内 10s / 大厅·榜单 30s；隐藏即停恢复立拍；失败退避 ×1.5 封顶 60s）----
export function createPoller(fn, { intervalMs = 30_000 } = {}) {
  let timer = null
  let stopped = true
  let currentDelay = intervalMs

  async function tick() {
    if (stopped) return
    try {
      await fn()
      currentDelay = intervalMs // 成功复位退避
    } catch {
      currentDelay = Math.min(currentDelay * 1.5, 60_000)
    }
    if (!stopped) timer = setTimeout(tick, currentDelay)
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      clearTimeout(timer)
      timer = null
    } else if (!stopped && !timer) {
      tick() // 恢复立即拍一次
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      currentDelay = intervalMs
      document.addEventListener('visibilitychange', onVisibility)
      tick()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      timer = null
      document.removeEventListener('visibilitychange', onVisibility)
    },
    setInterval(ms) { currentDelay = intervalMs = ms },
  }
}
