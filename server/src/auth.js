import crypto from 'node:crypto'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'

export const BCRYPT_COST = 10
export const JWT_TTL_SECONDS = 7 * 24 * 60 * 60
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_COST)
}

export function verifyPassword(password, hash) {
  return Boolean(hash) && bcrypt.compareSync(password, hash)
}

export function signToken(user, secret, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000)
  return jwt.sign(
    { uid: user.id, tv: user.token_version, iat },
    secret,
    { algorithm: 'HS256', expiresIn: JWT_TTL_SECONDS },
  )
}

export function verifyToken(token, secret) {
  return jwt.verify(token, secret, { algorithms: ['HS256'] })
}

export function generateResetCode() {
  let raw = ''
  const bytes = crypto.randomBytes(8)
  for (let i = 0; i < 8; i += 1) raw += CROCKFORD[bytes[i] % CROCKFORD.length]
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

export function normalizeResetCode(code) {
  return String(code || '').replace(/-/g, '').trim().toUpperCase()
}
