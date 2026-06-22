// 一次性迁移（2026-06-12 爹地拍板）：数字人从 6 个精简到 3 个，改名改头像。
//   保留 id 最小的 3 个 → 改名 独孤求败😏 / 蒙奇D路飞😆 / 漩涡鸣人😎（余额/好友关系保留）；
//   其余数字人 → 清零回收记 system ledger(account_close 守恒) + status='deleted' + 删好友关系。
// 幂等：再跑一次只剩 3 个 approved NPC，rename 成同名 no-op、无可删项。
//   用法：DB_PATH=/var/lib/beeeeet-online/app.db node deploy/migrate-npc-3.mjs
import Database from 'better-sqlite3'

const NEW = [
  { name: '独孤求败', emoji: '😏', title: '求一败而不可得' },
  { name: '蒙奇D路飞', emoji: '😆', title: '未来海贼王' },
  { name: '漩涡鸣人', emoji: '😎', title: '第七代火影' },
]

const db = new Database(process.env.DB_PATH)
const ts = Date.now()
const npcs = db.prepare("SELECT id, balance, frozen FROM users WHERE is_npc=1 AND status='approved' ORDER BY id").all()

const tx = db.transaction(() => {
  npcs.slice(0, 3).forEach((npc, i) => {
    db.prepare('UPDATE users SET name=?, emoji=?, title=? WHERE id=?').run(NEW[i].name, NEW[i].emoji, NEW[i].title, npc.id)
  })
  for (const npc of npcs.slice(3)) {
    const amt = npc.balance + npc.frozen
    if (amt > 0) {
      db.prepare(`
        INSERT INTO ledger (user_id, type, kind, amount, balance_after, reason, created_at)
        VALUES (?, 'account_close', 'system', ?, 0, '数字人精简回收', ?)
      `).run(npc.id, -amt, ts)
    }
    db.prepare('UPDATE users SET status=\'deleted\', balance=0, frozen=0, token_version=token_version+1, deleted_at=? WHERE id=?').run(ts, npc.id)
    db.prepare('DELETE FROM friendships WHERE user_a=? OR user_b=?').run(npc.id, npc.id)
  }
})
tx.immediate()

const held = db.prepare("SELECT COALESCE(SUM(balance+frozen),0) t FROM users WHERE status!='deleted'").get().t
const issued = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM ledger WHERE kind='system'").get().t
console.log('守恒校验:', held, '==', issued, held === issued ? '✓' : '✗ 不平!')
const live = db.prepare("SELECT name, emoji, title FROM users WHERE is_npc=1 AND status='approved' ORDER BY id").all()
console.log('保留数字人:', JSON.stringify(live, null, 0))
db.close()
