import { openDb } from '../src/db.js'
import { hashPassword } from '../src/auth.js'

const INITIAL_BALANCE = 1_000_000
const NPCS = [
  { name: '独孤求败', emoji: '😏', title: '求一败而不可得' },
  { name: '蒙奇D路飞', emoji: '😆', title: '未来海贼王' },
  { name: '漩涡鸣人', emoji: '😎', title: '第七代火影' },
]

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

const adminName = process.env.ADMIN_NAME
const adminPassword = process.env.ADMIN_PASSWORD
const inviteCode = String(process.env.INVITE_CODE || 'beeeeet').trim().toLowerCase()
const db = openDb(process.env.DB_PATH)
const now = Date.now()

if (!adminName || !adminPassword) {
  console.error('需要 ADMIN_NAME 和 ADMIN_PASSWORD')
  process.exit(1)
}

if (db.prepare('SELECT id FROM users WHERE is_admin=1 AND status != ?').get('deleted')) {
  console.error('库里已有 admin，拒绝重复 bootstrap')
  process.exit(1)
}

const bootstrapTx = db.transaction(() => {
  const adminInfo = db.prepare(`
    INSERT INTO users (name, password_hash, is_admin, balance, emoji, title, created_at)
    VALUES (?, ?, 1, ?, '👑', '群主', ?)
  `).run(adminName, hashPassword(adminPassword), INITIAL_BALANCE, now)
  const adminId = Number(adminInfo.lastInsertRowid)
  db.prepare(`
    INSERT INTO ledger (user_id, type, kind, amount, balance_after, ref, created_at)
    VALUES (?, 'grant', 'system', ?, ?, 'bootstrap-admin', ?)
  `).run(adminId, INITIAL_BALANCE, INITIAL_BALANCE, now)

  db.prepare(`
    INSERT INTO invite_codes (code, max_uses, used_count, status, created_by, created_at)
    VALUES (?, 50, 0, 'active', ?, ?)
  `).run(inviteCode, adminId, now)

  const insertNpc = db.prepare(`
    INSERT INTO users (name, phone, password_hash, is_npc, balance, emoji, title, wins, losses, streak, max_streak, reputation, privacy, created_at)
    VALUES (?, NULL, '', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertNpcLedger = db.prepare(`
    INSERT INTO ledger (user_id, type, kind, amount, balance_after, ref, created_at)
    VALUES (?, 'grant', 'system', ?, ?, 'bootstrap-npc', ?)
  `)
  for (const npc of NPCS) {
    const npcBalance = randInt(200_000, 2_500_000)
    const npcInfo = insertNpc.run(
      npc.name,
      npcBalance,
      npc.emoji,
      npc.title,
      randInt(3, 40),
      randInt(2, 35),
      randInt(-4, 8),
      Math.max(0, randInt(2, 14)),
      randInt(60, 100),
      npc.name === '老李' ? 1 : 0,
      now,
    )
    // NPC 发金同样落 system ledger：守恒审计基线 = sum(balance) == sum(system ledger)（cc-check 🔴）
    insertNpcLedger.run(Number(npcInfo.lastInsertRowid), npcBalance, npcBalance, now)
  }
})
bootstrapTx.immediate()

console.log(`bootstrap 完成：admin=${adminName} 团码=${inviteCode}`)
