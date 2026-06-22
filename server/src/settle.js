import { fetchPmResultById } from './pm-result.js'

const MAX_CONCURRENCY = 10
const RUNNING_STALE_MS = 30 * 60 * 1000

function balanceAfter(db, userId) {
  return db.prepare('SELECT balance FROM users WHERE id=?').get(userId).balance
}

function insertLedger(db, { userId, type, amount, ref, ts }) {
  db.prepare(`
    INSERT INTO ledger (user_id, type, kind, amount, balance_after, ref, created_at)
    VALUES (?, ?, 'system', ?, ?, ?, ?)
  `).run(userId, type, amount, balanceAfter(db, userId), ref, ts)
}

function insertFeed(db, bet, won, ts) {
  const text = won
    ? `跟系统盘对赌「${bet.event_title}」押中「${bet.zh_outcome || bet.outcome}」，派彩 ${bet.payout} 积分`
    : `跟系统盘对赌「${bet.event_title}」押「${bet.zh_outcome || bet.outcome}」落空`
  db.prepare('INSERT INTO feed (type, actor_id, text, ref, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('settle', bet.user_id, text, `pm:${bet.id}`, ts)
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function settleIdOf(bet) {
  return String(bet.market_id ?? bet.event_id)
}

function markStuckIfNeeded(db, ts) {
  const rows = db.prepare('SELECT status FROM settlement_runs ORDER BY id DESC LIMIT 4').all()
  if (rows.length < 3) return
  const bad = (row) => row.status === 'partial' || row.status === 'failed'
  if (!rows.slice(0, 3).every(bad)) return
  // 只在恰好跨过"连续 3 轮"阈值时告警一次，连败持续期间不每轮刷屏
  if (rows.length === 4 && bad(rows[3])) return
  db.prepare(`
    INSERT INTO admin_alerts (level, kind, message, created_at)
    VALUES ('critical', 'settle_stuck', ?, ?)
  `).run('系统盘结算连续 3 轮 partial/failed，请检查 Polymarket 查询与落账状态', ts)
}

function finishRun(db, runId, { status, scanned, settled, errors, ts }) {
  db.prepare(`
    UPDATE settlement_runs
    SET status=?, finished_at=?, scanned=?, settled=?, errors=?
    WHERE id=?
  `).run(status, ts, scanned, settled, errors.length ? JSON.stringify(errors) : null, runId)
  markStuckIfNeeded(db, ts)
}

function settleOneBet(db, bet, winningOutcome, ts) {
  const won = String(winningOutcome) === String(bet.outcome)
  const payout = won ? Math.round(bet.stake * bet.odds) : 0
  const status = won ? 'won' : 'lost'
  const tx = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE pm_bets
      SET status=?, result=?, payout=?, settled_at=?
      WHERE id=? AND status='pending'
    `).run(status, String(winningOutcome), payout, ts, bet.id)
    if (updated.changes === 0) return false

    const current = { ...bet, payout }
    if (won) {
      db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(payout, bet.user_id)
      insertLedger(db, { userId: bet.user_id, type: 'pm_win', amount: payout, ref: `pm:${bet.id}`, ts })
    } else {
      insertLedger(db, { userId: bet.user_id, type: 'pm_lose', amount: 0, ref: `pm:${bet.id}`, ts })
    }
    insertFeed(db, current, won, ts)
    return true
  })
  return tx.immediate()
}

export async function runSettlement(db, { fetchResult = fetchPmResultById, now = () => Date.now() } = {}) {
  const startedAt = now()
  const runId = db.transaction(() => {
    db.prepare("UPDATE settlement_runs SET status='failed', finished_at=?, errors=? WHERE status='running' AND started_at < ?")
      .run(startedAt, JSON.stringify([{ message: 'stale running settlement run' }]), startedAt - RUNNING_STALE_MS)
    const info = db.prepare("INSERT INTO settlement_runs (status, started_at) VALUES ('running', ?)").run(startedAt)
    return Number(info.lastInsertRowid)
  }).immediate()

  let scanned = 0
  let settled = 0
  const errors = []
  try {
    const pending = db.prepare("SELECT * FROM pm_bets WHERE status='pending' ORDER BY id").all()
    scanned = pending.length
    const groups = new Map()
    for (const bet of pending) {
      const settleId = settleIdOf(bet)
      if (!groups.has(settleId)) groups.set(settleId, [])
      groups.get(settleId).push(bet)
    }

    const groupEntries = [...groups.entries()]
    const resultById = new Map()
    await mapLimit(groupEntries, MAX_CONCURRENCY, async ([settleId, bets]) => {
      try {
        const preferMarket = bets.some((bet) => bet.market_id != null && bet.market_id !== '')
        resultById.set(settleId, await fetchResult(settleId, { preferMarket }))
      } catch (err) {
        errors.push({ settleId, stage: 'fetch', message: String(err?.message || err) })
      }
    })

    for (const [settleId, bets] of groupEntries) {
      const result = resultById.get(settleId)
      if (!result) continue // fetch 失败已记 errors，本轮跳过下轮重试
      if (!result.closed) continue // 未结束，正常等待
      if (!result.winningOutcome) {
        // 已关闭但解析不出赢家（疑似取消盘）：必须进 errors 走告警链路，等人工处理
        errors.push({ settleId, stage: 'resolve', message: '盘口已关闭但无法解析赢家（疑似取消盘），需人工处理' })
        continue
      }
      for (const bet of bets) {
        try {
          if (settleOneBet(db, bet, result.winningOutcome, now())) settled += 1
        } catch (err) {
          errors.push({ betId: bet.id, settleId, stage: 'settle', message: String(err?.message || err) })
        }
      }
    }

    const finishedAt = now()
    finishRun(db, runId, {
      status: errors.length ? 'partial' : 'done',
      scanned,
      settled,
      errors,
      ts: finishedAt,
    })
    return { scanned, settled, errors }
  } catch (err) {
    errors.push({ stage: 'run', message: String(err?.message || err) })
    finishRun(db, runId, { status: 'failed', scanned, settled, errors, ts: now() })
    return { scanned, settled, errors }
  }
}
