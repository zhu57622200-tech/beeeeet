export const ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: { status: 401, message: '请先登录' },
  AUTH_EXPIRED: { status: 401, message: '登录已失效，请重新登录' },
  BANNED: { status: 403, message: '账号已被封禁，联系群主' },
  MUTED: { status: 403, message: '你被群主禁言了' },
  NOT_FRIENDS: { status: 403, message: '加好友后才能私信和约赌' },
  FORBIDDEN: { status: 403, message: '无权限' },
  INVITE_INVALID: { status: 400, message: '邀请码无效' },
  INVITE_FULL: { status: 400, message: '邀请码已满，找群主要新码' },
  NAME_TAKEN: { status: 409, message: '昵称被占用，换一个' },
  PHONE_TAKEN: { status: 409, message: '这个手机号已注册过，试试找回密码' },
  BAD_CREDENTIALS: { status: 401, message: '昵称或密码不对' },
  RESET_CODE_INVALID: { status: 400, message: '重置码无效或已过期，找群主重发' },
  RATE_LIMITED: { status: 429, message: '操作太频繁，稍后再试' },
  INSUFFICIENT_BALANCE: { status: 400, message: '余额不足' },
  MATCH_TAKEN: { status: 409, message: '慢了一步，已被人接走' },
  MATCH_NOT_OPEN: { status: 409, message: '该局当前不可操作' },
  TRANSFER_LIMITED: { status: 400, message: '超出转赠限额' },
  VALIDATION: { status: 400, message: '参数校验失败' },
  NOT_FOUND: { status: 404, message: '资源不存在' },
  CONFLICT: { status: 409, message: '状态冲突' },
  SERVER_BUSY: { status: 503, message: '服务繁忙稍后再试' },
})

export class ApiError extends Error {
  constructor(code, message, details = {}) {
    super(message || ERROR_CODES[code]?.message || '请求失败')
    this.name = 'ApiError'
    this.code = code
    this.statusCode = ERROR_CODES[code]?.status || 500
    this.details = details
  }
}

export function apiError(code, message, details) {
  return new ApiError(code, message, details)
}

export function errorBody(err) {
  const code = err?.code && ERROR_CODES[err.code] ? err.code : 'SERVER_BUSY'
  return {
    ok: false,
    code,
    message: err?.message || ERROR_CODES[code].message,
  }
}
