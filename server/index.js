import { buildApp } from './src/app.js'
import { openDb } from './src/db.js'

// JWT_SECRET 必填：漏配即拒绝启动（已知默认密钥=任何人可伪造 token，cc-check 🔴）
const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret) {
  console.error('缺 JWT_SECRET 环境变量，拒绝启动')
  process.exit(1)
}

const db = openDb()
const app = buildApp({
  db,
  jwtSecret,
  enableCron: true,
})

const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 8788)

try {
  await app.listen({ host, port })
  app.log.info({ host, port }, 'beeeeet online server listening')
} catch (err) {
  console.error(err)
  process.exit(1)
}
