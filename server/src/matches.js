import { apiError } from './errors.js'
import { allocateIntegerPayouts, settleBanker, settleMatch, settlePool, takerStakeFor } from '../../src/core/wager.js'
import { isStaleOpen, tallyConsensus, validateAppeal } from '../../src/core/governance.js'

function side(value, field = 'side') {
  const out = String(value || '').toUpperCase()
  if (out !== 'A' && out !== 'B') throw apiError('VALIDATION', `${field} 必须是 A 或 B`)
  return out
}

function positiveInt(value, field) {
  const out = Math.round(Number(value) || 0)
  if (!(out > 0)) throw apiError('VALIDATION', `${field} 必须大于 0`)
  return out
}

function odds(value, field) {
  const out = Number(value)
  if (!(out > 1)) throw apiError('VALIDATION', `${field} 必须大于 1`)
  return out
}

function text(value, field) {
  const out = String(value || '').trim()
  if (!out) throw apiError('VALIDATION', `${field} 不能为空`)
  return out
}

function optText(value) {
  const out = String(value || '').trim()
  return out || null
}

function readJson(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function matchRef(id) {
  return `match:${id}`
}

function rowToMatch(row, bets = []) {
  return {
    id: row.id,
    mode: row.mode,
    title: row.title,
    optionA: row.option_a,
    optionB: row.option_b,
    status: row.status,
    result: row.result,
    ownerId: row.owner_id,
    ownerSide: row.owner_side,
    odds: row.odds,
    ownerStake: row.owner_stake,
    takerId: row.taker_id,
    takerSide: row.taker_side,
    takerStake: row.taker_stake,
    bankerOdds: row.banker_odds,
    bankerCap: row.banker_cap,
    invitedIds: readJson(row.invited_ids, []),
    consensus: readJson(row.consensus, null),
    deadline: row.deadline,
    sideBetText: row.side_bet_text,
    settledAt: row.settled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bets,
  }
}

function getMatch(db, id) {
  const row = db.prepare('SELECT * FROM matches WHERE id=?').get(id)
  if (!row) throw apiError('NOT_FOUND')
  return row
}

function getBets(db, matchId) {
  return db.prepare(`
    SELECT id, match_id AS matchId, user_id AS userId, side, stake, payout, created_at AS createdAt
    FROM match_bets
    WHERE match_id=?
    ORDER BY id
  `).all(matchId)
}

function getParticipantIds(db, match) {
  const ids = new Set([match.owner_id])
  if (match.taker_id) ids.add(match.taker_id)
  for (const bet of db.prepare('SELECT user_id FROM match_bets WHERE match_id=?').all(match.id)) ids.add(bet.user_id)
  return [...ids]
}

function assertParticipant(db, match, userId) {
  if (getParticipantIds(db, match).includes(userId)) return
  throw apiError('FORBIDDEN')
}

function balanceAfter(db, userId) {
  return db.prepare('SELECT balance FROM users WHERE id=?').get(userId).balance
}

function insertLedger(db, { userId, type, kind = 'player', amount, ref, ts, requestId, actorAdminId, reason }) {
  db.prepare(`
    INSERT INTO ledger (user_id, type, kind, amount, balance_after, ref, actor_admin_id, reason, request_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, type, kind, amount, balanceAfter(db, userId), ref, actorAdminId || null, reason || null, requestId || null, ts)
}

function feed(db, type, actorId, textValue, ref, ts) {
  db.prepare('INSERT INTO feed (type, actor_id, text, ref, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(type, actorId || null, textValue, ref, ts)
}

function freeze(db, userId, amount, ts, ref, requestId) {
  const info = db.prepare('UPDATE users SET balance=balance-?, frozen=frozen+? WHERE id=? AND balance>=?')
    .run(amount, amount, userId, amount)
  if (info.changes === 0) throw apiError('INSUFFICIENT_BALANCE')
  insertLedger(db, { userId, type: 'freeze', amount: 0, ref, ts, requestId })
}

function refund(db, userId, amount, ts, ref, requestId, type = 'void_refund') {
  if (!(amount > 0)) return
  const info = db.prepare('UPDATE users SET balance=balance+?, frozen=frozen-? WHERE id=? AND frozen>=?')
    .run(amount, amount, userId, amount)
  if (info.changes === 0) throw apiError('CONFLICT', '冻结余额不足，无法退款')
  insertLedger(db, { userId, type, amount: 0, ref, ts, requestId })
}

function settleFrozen(db, userId, stake, payout, ts, ref, requestId, won) {
  const info = db.prepare('UPDATE users SET balance=balance+?, frozen=frozen-? WHERE id=? AND frozen>=?')
    .run(payout, stake, userId, stake)
  if (info.changes === 0) throw apiError('CONFLICT', '冻结余额不足，无法结算')
  insertLedger(db, {
    userId,
    type: won ? 'settle_win' : 'settle_lose',
    amount: payout - stake,
    ref,
    ts,
    requestId,
  })
}

function updateStats(db, userId, won, oddsValue = 0) {
  if (won) {
    db.prepare(`
      UPDATE users
      SET wins=wins+1, streak=streak+1, max_streak=MAX(max_streak, streak+1), best_win_odds=MAX(best_win_odds, ?)
      WHERE id=?
    `).run(oddsValue || 0, userId)
  } else {
    db.prepare('UPDATE users SET losses=losses+1, streak=0 WHERE id=?').run(userId)
  }
}

function voidMatch(db, match, ts, feedType, requestId) {
  if (match.mode === 'match') {
    refund(db, match.owner_id, match.owner_stake || 0, ts, matchRef(match.id), requestId)
    if (match.taker_id && match.taker_stake) refund(db, match.taker_id, match.taker_stake, ts, matchRef(match.id), requestId)
  } else {
    if (match.mode === 'banker') refund(db, match.owner_id, match.banker_cap || 0, ts, matchRef(match.id), requestId)
    const bets = db.prepare('SELECT * FROM match_bets WHERE match_id=?').all(match.id)
    for (const bet of bets) refund(db, bet.user_id, bet.stake, ts, matchRef(match.id), requestId)
    db.prepare('UPDATE match_bets SET payout=stake WHERE match_id=? AND payout IS NULL').run(match.id)
  }
  db.prepare("UPDATE matches SET status='voided', updated_at=? WHERE id=?").run(ts, match.id)
  feed(db, feedType, null, `${match.title} 已作废退款`, matchRef(match.id), ts)
}

function settleMatchRow(db, match, result, ts, requestId) {
  if (match.status === 'settled' || match.status === 'voided') throw apiError('CONFLICT', '该局已经结束')
  const ref = `${matchRef(match.id)}:settle`
  if (match.mode === 'match') {
    if (!match.taker_id || !match.taker_stake) throw apiError('MATCH_NOT_OPEN')
    const payout = settleMatch({
      ownerStake: match.owner_stake,
      takerStake: match.taker_stake,
      ownerSide: match.owner_side,
      result,
    })
    settleFrozen(db, match.owner_id, match.owner_stake, payout.ownerPayout, ts, ref, requestId, payout.ownerPayout > match.owner_stake)
    settleFrozen(db, match.taker_id, match.taker_stake, payout.takerPayout, ts, ref, requestId, payout.takerPayout > match.taker_stake)
    updateStats(db, match.owner_id, payout.ownerPayout > match.owner_stake, match.odds)
    updateStats(db, match.taker_id, payout.takerPayout > match.taker_stake, match.odds)
  } else if (match.mode === 'pool') {
    const bets = db.prepare('SELECT * FROM match_bets WHERE match_id=? ORDER BY id').all(match.id)
    const winners = bets.filter((bet) => bet.side === result)
    const totalPool = bets.reduce((sum, bet) => sum + bet.stake, 0)
    if (winners.length === 0) {
      voidMatch(db, match, ts, 'expire', requestId)
      return 'voided'
    }
    const sideA = bets.filter((bet) => bet.side === 'A').map((bet) => bet.stake)
    const sideB = bets.filter((bet) => bet.side === 'B').map((bet) => bet.stake)
    const theoretical = settlePool({ sideA, sideB, result }).payouts
    const winnerTheoretical = []
    const winnerBets = []
    for (const p of theoretical.filter((payout) => payout.side === result)) {
      const sameSide = bets.filter((bet) => bet.side === result)
      const bet = sameSide[p.index]
      winnerBets.push(bet)
      winnerTheoretical.push({ payout: p.payout, stake: bet.stake })
    }
    const integerPayouts = allocateIntegerPayouts(winnerTheoretical, totalPool)
    const payoutById = new Map()
    winnerBets.forEach((bet, index) => payoutById.set(bet.id, integerPayouts[index]))
    for (const bet of bets) {
      const payout = payoutById.get(bet.id) || 0
      db.prepare('UPDATE match_bets SET payout=? WHERE id=?').run(payout, bet.id)
      settleFrozen(db, bet.user_id, bet.stake, payout, ts, ref, requestId, payout > bet.stake)
      updateStats(db, bet.user_id, payout > bet.stake)
    }
  } else if (match.mode === 'banker') {
    const bets = db.prepare('SELECT * FROM match_bets WHERE match_id=? ORDER BY id').all(match.id)
    const settled = settleBanker({
      bankerOdds: match.banker_odds,
      bankerCap: match.banker_cap,
      result,
      bets: bets.map((bet) => ({ side: bet.side, stake: bet.stake })),
    })
    const betPayouts = settled.payouts.map((payout) => Math.round(payout.payout))
    const bankerReturn = match.banker_cap + bets.reduce((sum, bet) => sum + bet.stake, 0) - betPayouts.reduce((sum, amount) => sum + amount, 0)
    const bankerPnl = bankerReturn - match.banker_cap
    settleFrozen(db, match.owner_id, match.banker_cap, bankerReturn, ts, ref, requestId, bankerPnl > 0)
    updateStats(db, match.owner_id, bankerPnl > 0, match.banker_odds)
    for (const payout of settled.payouts) {
      const bet = bets[payout.betIndex]
      const amount = betPayouts[payout.betIndex]
      db.prepare('UPDATE match_bets SET payout=? WHERE id=?').run(amount, bet.id)
      settleFrozen(db, bet.user_id, bet.stake, amount, ts, ref, requestId, amount > bet.stake)
      updateStats(db, bet.user_id, amount > bet.stake, match.banker_odds)
    }
  }
  db.prepare("UPDATE matches SET status='settled', result=?, settled_at=?, updated_at=? WHERE id=?")
    .run(result, ts, ts, match.id)
  feed(db, 'settle', null, `${match.title} 已结算`, matchRef(match.id), ts)
  return 'settled'
}

function currentWorstLoss(bets, bankerOdds, sideValue) {
  // 与结算口径逐笔对齐：结算时 payout = Math.round(stake*odds)，
  // 预检若用浮点 stake*(odds-1) 会在边界局放进超额注，结算后庄家回款为负。
  let pnl = 0
  for (const bet of bets) {
    if (bet.side === sideValue) pnl -= Math.round(bet.stake * bankerOdds) - bet.stake
    else pnl += bet.stake
  }
  return Math.max(0, -pnl)
}

function assertBankerExposure(match, bets, newBet) {
  const next = [...bets, newBet]
  const worst = Math.max(currentWorstLoss(next, match.banker_odds, 'A'), currentWorstLoss(next, match.banker_odds, 'B'))
  if (worst <= match.banker_cap) return
  const currentForSide = currentWorstLoss(bets, match.banker_odds, newBet.side)
  const remaining = Math.max(0, Math.floor((match.banker_cap - currentForSide) / (match.banker_odds - 1)))
  throw apiError('VALIDATION', `超出庄家敞口，剩余可押额度 ${remaining}`)
}

function matchNet(match, result) {
  if (match.mode !== 'match') throw apiError('VALIDATION', '暂只支持 match 改判')
  const ownerWins = result === match.owner_side
  return new Map([
    [match.owner_id, ownerWins ? match.taker_stake : -match.owner_stake],
    [match.taker_id, ownerWins ? -match.taker_stake : match.owner_stake],
  ])
}

function applyBalanceDelta(db, userId, delta, ts, ref, requestId, actorAdminId) {
  if (delta === 0) return 0
  if (delta > 0) {
    db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(delta, userId)
    insertLedger(db, { userId, type: 'settle_win', amount: delta, ref, ts, requestId, actorAdminId })
    return 0
  }
  const need = -delta
  const row = db.prepare('SELECT balance FROM users WHERE id=?').get(userId)
  const taken = Math.min(row.balance, need)
  db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(taken, userId)
  insertLedger(db, { userId, type: 'settle_lose', amount: -taken, ref, ts, requestId, actorAdminId })
  return need - taken
}

function resolveAppeal(db, appeal, verdict, newResult, adminId, ts, requestId) {
  const match = getMatch(db, appeal.match_id)
  if (match.status !== 'settled') throw apiError('CONFLICT', '只有已结算局可终审')
  if (verdict === 'uphold') {
    db.prepare("UPDATE appeals SET status='resolved', verdict='uphold', resolved_at=?, resolved_by=? WHERE id=?")
      .run(ts, adminId, appeal.id)
    feed(db, 'appeal', adminId, `${match.title} 申诉维持原判`, matchRef(match.id), ts)
    return
  }
  const result = side(newResult || (match.result === 'A' ? 'B' : 'A'), 'newResult')
  if (result === match.result) throw apiError('VALIDATION', '改判结果不能等于原结果')

  const oldNet = matchNet(match, match.result)
  const nextNet = matchNet(match, result)
  let absorbed = 0
  for (const [userId, next] of nextNet.entries()) {
    const delta = next - (oldNet.get(userId) || 0)
    absorbed += applyBalanceDelta(db, userId, delta, ts, `${matchRef(match.id)}:appeal`, requestId, adminId)
  }
  db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(appeal.stake, appeal.user_id)
  insertLedger(db, {
    userId: appeal.user_id,
    type: 'appeal_refund',
    kind: 'system',
    amount: appeal.stake,
    ref: `${matchRef(match.id)}:appeal`,
    ts,
    requestId,
    actorAdminId: adminId,
  })
  if (absorbed > 0) {
    insertLedger(db, {
      userId: adminId,
      type: 'system_absorb',
      kind: 'system',
      amount: absorbed,
      ref: `${matchRef(match.id)}:appeal`,
      ts,
      requestId,
      actorAdminId: adminId,
      reason: '申诉改判余额不足，系统吸收差额',
    })
    db.prepare("INSERT INTO admin_alerts (level, kind, message, created_at) VALUES ('warn', 'conservation', ?, ?)")
      .run(`申诉改判 ${match.id} 余额不足，系统吸收 ${absorbed}`, ts)
  }
  db.prepare("UPDATE matches SET result=?, updated_at=? WHERE id=?").run(result, ts, match.id)
  db.prepare("UPDATE appeals SET status='resolved', verdict='overturn', new_result=?, resolved_at=?, resolved_by=? WHERE id=?")
    .run(result, ts, adminId, appeal.id)
  feed(db, 'appeal', adminId, `${match.title} 申诉改判`, matchRef(match.id), ts)
}

export function sweepExpiredMatches(db, ts = Date.now()) {
  const tx = db.transaction(() => {
    const rows = db.prepare("SELECT * FROM matches WHERE status='open'").all()
    let count = 0
    for (const row of rows) {
      if (!isStaleOpen(row, ts)) continue
      voidMatch(db, row, ts, 'expire', null)
      count += 1
    }
    return { expired: count }
  })
  return tx.immediate()
}

// 给前端补双方展示信息（昵称/头像）——列表/详情都要，前端模板按名字渲染
function attachNames(db, matches) {
  const ids = new Set()
  for (const m of matches) {
    if (m.ownerId) ids.add(m.ownerId)
    if (m.takerId) ids.add(m.takerId)
  }
  if (!ids.size) return matches
  const list = [...ids]
  const rows = db.prepare(`SELECT id, name, emoji FROM users WHERE id IN (${list.map(() => '?').join(',')})`).all(...list)
  const byId = new Map(rows.map((u) => [u.id, u]))
  for (const m of matches) {
    const owner = byId.get(m.ownerId)
    const taker = byId.get(m.takerId)
    m.ownerName = owner?.name || null
    m.ownerEmoji = owner?.emoji || null
    m.takerName = taker?.name || null
    m.takerEmoji = taker?.emoji || null
  }
  return matches
}

// "我的对赌"独立数据源：我 owner/taker/下过注(match_bets)的全部局。
// 区别于 GET /matches 的全站大厅列表——后者是广场，前者才是"我参与的"。
export function matchesForUser(db, userId, limit = 100) {
  const safeLimit = Math.min(200, Math.max(1, Math.round(Number(limit) || 100)))
  const rows = db.prepare(`
    SELECT * FROM matches m
    WHERE m.owner_id = @uid OR m.taker_id = @uid
       OR EXISTS (SELECT 1 FROM match_bets b WHERE b.match_id = m.id AND b.user_id = @uid)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT @lim
  `).all({ uid: userId, lim: safeLimit })
  return attachNames(db, rows.map((row) => rowToMatch(row)))
}

export function registerMatchRoutes(app, { db, requireAuth, requireAdmin, ok, runIdempotent, idempotencyKey, now }) {
  app.get('/api/v1/matches', { preHandler: requireAuth }, async (req) => {
    const limit = Math.min(50, Math.max(1, Number(req.query?.limit || 20) || 20))
    const status = String(req.query?.status || '').trim()
    const rows = status
      ? db.prepare('SELECT * FROM matches WHERE status=? ORDER BY created_at DESC, id DESC LIMIT ?').all(status, limit)
      : db.prepare('SELECT * FROM matches ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
    return ok({ matches: attachNames(db, rows.map((row) => rowToMatch(row))) })
  })

  app.get('/api/v1/matches/:id', { preHandler: requireAuth }, async (req) => {
    const row = getMatch(db, Number(req.params.id))
    const match = attachNames(db, [rowToMatch(row, getBets(db, row.id))])[0]
    // 详情页一并带留言（盘内 10s 轮询整页返回，§7 口径）
    match.comments = db.prepare(`
      SELECT c.id, c.user_id AS userId, u.name, u.emoji, c.text, c.is_slap AS isSlap, c.created_at AS createdAt
      FROM comments c JOIN users u ON u.id=c.user_id
      WHERE c.scope='match' AND c.ref_id=? AND c.deleted_at IS NULL
      ORDER BY c.id ASC
    `).all(String(row.id))
    return ok({ match })
  })

  app.post('/api/v1/matches', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const mode = String(req.body?.mode || 'match')
      if (!['match', 'banker', 'pool'].includes(mode)) throw apiError('VALIDATION', 'mode 参数不合法')
      const title = text(req.body?.title, 'title')
      const optionA = text(req.body?.optionA ?? req.body?.option_a, 'optionA')
      const optionB = text(req.body?.optionB ?? req.body?.option_b, 'optionB')
      const deadline = req.body?.deadline == null ? null : Math.round(Number(req.body.deadline) || 0)
      const invitedIds = req.body?.invite ?? req.body?.invitedIds ?? req.body?.invited_ids ?? []
      let ownerSide = null
      let ownerStake = null
      let matchOdds = null
      let bankerOdds = null
      let bankerCap = null

      if (mode === 'match') {
        ownerSide = side(req.body?.ownerSide ?? req.body?.owner_side, 'ownerSide')
        ownerStake = positiveInt(req.body?.ownerStake ?? req.body?.owner_stake, 'ownerStake')
        matchOdds = odds(req.body?.odds, 'odds')
        freeze(db, req.user.id, ownerStake, ts, 'match:new', key)
      } else if (mode === 'banker') {
        bankerOdds = odds(req.body?.bankerOdds ?? req.body?.banker_odds, 'bankerOdds')
        bankerCap = positiveInt(req.body?.bankerCap ?? req.body?.banker_cap, 'bankerCap')
        freeze(db, req.user.id, bankerCap, ts, 'match:new', key)
      } else {
        ownerSide = side(req.body?.ownerSide ?? req.body?.owner_side, 'ownerSide')
        ownerStake = positiveInt(req.body?.ownerStake ?? req.body?.owner_stake, 'ownerStake')
        freeze(db, req.user.id, ownerStake, ts, 'match:new', key)
      }

      const info = db.prepare(`
        INSERT INTO matches (
          mode, title, option_a, option_b, owner_id, owner_side, odds, owner_stake,
          banker_odds, banker_cap, invited_ids, deadline, side_bet_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mode,
        title,
        optionA,
        optionB,
        req.user.id,
        ownerSide,
        matchOdds,
        ownerStake,
        bankerOdds,
        bankerCap,
        JSON.stringify(Array.isArray(invitedIds) ? invitedIds : []),
        deadline,
        optText(req.body?.sideBetText ?? req.body?.side_bet_text),
        ts,
        ts,
      )
      const matchId = Number(info.lastInsertRowid)
      db.prepare("UPDATE ledger SET ref=? WHERE ref='match:new' AND request_id=?").run(matchRef(matchId), key)
      if (mode === 'pool') {
        db.prepare('INSERT INTO match_bets (match_id, user_id, side, stake, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(matchId, req.user.id, ownerSide, ownerStake, ts)
      }
      feed(db, 'open', req.user.id, `${title} 开盘`, matchRef(matchId), ts)
      const row = getMatch(db, matchId)
      return { match: rowToMatch(row, getBets(db, matchId)) }
    }))
  })

  app.post('/api/v1/matches/:id/take', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const match = getMatch(db, Number(req.params.id))
      if (match.mode !== 'match') throw apiError('VALIDATION', '只有 match 模式可接盘')
      if (match.status === 'consensus') throw apiError('MATCH_NOT_OPEN')
      if (match.owner_id === req.user.id) throw apiError('VALIDATION', '不能接自己的盘')
      const takerStake = takerStakeFor(match.owner_stake, match.odds)
      const takerSide = match.owner_side === 'A' ? 'B' : 'A'
      freeze(db, req.user.id, takerStake, ts, matchRef(match.id), key)
      const updated = db.prepare(`
        UPDATE matches
        SET taker_id=?, taker_side=?, taker_stake=?, status='matched', updated_at=?
        WHERE id=? AND status='open' AND taker_id IS NULL
      `).run(req.user.id, takerSide, takerStake, ts, match.id)
      if (updated.changes === 0) throw apiError('MATCH_TAKEN')
      feed(db, 'join', req.user.id, `${match.title} 被接盘`, matchRef(match.id), ts)
      const row = getMatch(db, match.id)
      return { match: rowToMatch(row, getBets(db, match.id)) }
    }))
  })

  app.post('/api/v1/matches/:id/pool-bets', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const match = getMatch(db, Number(req.params.id))
      if (match.status === 'consensus') throw apiError('MATCH_NOT_OPEN')
      if (match.mode !== 'pool') throw apiError('VALIDATION', '只有 pool 模式可下注')
      if (!['open', 'matched'].includes(match.status)) throw apiError('MATCH_NOT_OPEN')
      const stake = positiveInt(req.body?.stake, 'stake')
      const betSide = side(req.body?.side, 'side')
      freeze(db, req.user.id, stake, ts, matchRef(match.id), key)
      db.prepare('INSERT INTO match_bets (match_id, user_id, side, stake, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(match.id, req.user.id, betSide, stake, ts)
      db.prepare("UPDATE matches SET status='matched', updated_at=? WHERE id=? AND status='open'").run(ts, match.id)
      return { match: rowToMatch(getMatch(db, match.id), getBets(db, match.id)) }
    }))
  })

  app.post('/api/v1/matches/:id/banker-bets', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const match = getMatch(db, Number(req.params.id))
      if (match.status === 'consensus') throw apiError('MATCH_NOT_OPEN')
      if (match.mode !== 'banker') throw apiError('VALIDATION', '只有 banker 模式可押庄')
      if (!['open', 'matched'].includes(match.status)) throw apiError('MATCH_NOT_OPEN')
      if (match.owner_id === req.user.id) throw apiError('VALIDATION', '庄家不能押自己的庄')
      const stake = positiveInt(req.body?.stake, 'stake')
      const betSide = side(req.body?.side, 'side')
      const bets = db.prepare('SELECT side, stake FROM match_bets WHERE match_id=?').all(match.id)
      assertBankerExposure(match, bets, { side: betSide, stake })
      freeze(db, req.user.id, stake, ts, matchRef(match.id), key)
      db.prepare('INSERT INTO match_bets (match_id, user_id, side, stake, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(match.id, req.user.id, betSide, stake, ts)
      db.prepare("UPDATE matches SET status='matched', updated_at=? WHERE id=? AND status='open'").run(ts, match.id)
      return { match: rowToMatch(getMatch(db, match.id), getBets(db, match.id)) }
    }))
  })

  app.post('/api/v1/matches/:id/reveal', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const match = getMatch(db, Number(req.params.id))
      const result = side(req.body?.result ?? req.body?.proposed, 'result')
      if (match.status === 'consensus') {
        const consensus = readJson(match.consensus, {})
        consensus.proposed = result
        consensus.proposer_id = req.user.id
        consensus.votes = {}
        consensus.status = 'voting'
        db.prepare('UPDATE matches SET consensus=?, updated_at=? WHERE id=?').run(JSON.stringify(consensus), ts, match.id)
        return { match: rowToMatch(getMatch(db, match.id), getBets(db, match.id)) }
      }
      if (match.mode === 'match' && match.status !== 'matched') throw apiError('MATCH_NOT_OPEN')
      if (match.mode !== 'match' && !['open', 'matched'].includes(match.status)) throw apiError('MATCH_NOT_OPEN')
      if (req.user.id !== match.owner_id) assertParticipant(db, match, req.user.id)
      const status = settleMatchRow(db, match, result, ts, key)
      return { match: rowToMatch(getMatch(db, match.id), getBets(db, match.id)), status }
    }))
  })

  app.post('/api/v1/matches/:id/dispute', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const match = getMatch(db, Number(req.params.id))
      if (!['open', 'matched'].includes(match.status)) throw apiError('MATCH_NOT_OPEN')
      assertParticipant(db, match, req.user.id)
      const voters = getParticipantIds(db, match)
      const consensus = {
        proposed: side(req.body?.proposed || match.result || 'A', 'proposed'),
        proposer_id: req.user.id,
        rule: match.mode === 'match' ? 'unanimous' : 'twothirds',
        voters,
        votes: {},
        status: 'voting',
      }
      db.prepare("UPDATE matches SET status='consensus', consensus=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(consensus), ts, match.id)
      return { match: rowToMatch(getMatch(db, match.id), getBets(db, match.id)) }
    }))
  })

  app.post('/api/v1/matches/:id/vote', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const match = getMatch(db, Number(req.params.id))
      if (match.status !== 'consensus') throw apiError('MATCH_NOT_OPEN')
      const consensus = readJson(match.consensus, null)
      if (!consensus || !consensus.voters?.includes(req.user.id)) throw apiError('FORBIDDEN')
      const vote = String(req.body?.vote || '').toLowerCase()
      if (vote !== 'agree' && vote !== 'reject') throw apiError('VALIDATION', 'vote 必须是 agree 或 reject')
      consensus.votes[String(req.user.id)] = vote
      const tally = tallyConsensus(consensus)
      consensus.status = tally.passed ? 'passed' : (tally.deadlocked ? 'deadlocked' : 'voting')
      db.prepare('UPDATE matches SET consensus=?, updated_at=? WHERE id=?').run(JSON.stringify(consensus), ts, match.id)
      if (tally.passed) settleMatchRow(db, getMatch(db, match.id), consensus.proposed, ts, key)
      return { match: rowToMatch(getMatch(db, match.id), getBets(db, match.id)), tally }
    }))
  })

  app.post('/api/v1/matches/:id/arbiter', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const match = getMatch(db, Number(req.params.id))
      if (match.status !== 'consensus') throw apiError('MATCH_NOT_OPEN')
      assertParticipant(db, match, req.user.id)
      const arbiterId = positiveInt(req.body?.arbiterId ?? req.body?.arbiter_id, 'arbiterId')
      if (!db.prepare('SELECT id FROM users WHERE id=? AND status=?').get(arbiterId, 'approved')) throw apiError('NOT_FOUND')
      const consensus = readJson(match.consensus, {})
      consensus.status = 'arbitration'
      consensus.arbiter_id = arbiterId
      db.prepare('UPDATE matches SET consensus=?, updated_at=? WHERE id=?').run(JSON.stringify(consensus), ts, match.id)
      return { match: rowToMatch(getMatch(db, match.id), getBets(db, match.id)) }
    }))
  })

  app.post('/api/v1/matches/:id/verdict', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const match = getMatch(db, Number(req.params.id))
      if (match.status !== 'consensus') throw apiError('MATCH_NOT_OPEN')
      const consensus = readJson(match.consensus, {})
      if (consensus.arbiter_id && consensus.arbiter_id !== req.user.id && !req.user.is_admin) throw apiError('FORBIDDEN')
      const result = side(req.body?.result, 'result')
      settleMatchRow(db, match, result, ts, key)
      return { match: rowToMatch(getMatch(db, match.id), getBets(db, match.id)) }
    }))
  })

  app.post('/api/v1/matches/:id/cancel', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const match = getMatch(db, Number(req.params.id))
      if (match.owner_id !== req.user.id) throw apiError('FORBIDDEN')
      if (match.status !== 'open') throw apiError('MATCH_NOT_OPEN')
      voidMatch(db, match, ts, 'cancel', key)
      return { match: rowToMatch(getMatch(db, match.id), getBets(db, match.id)) }
    }))
  })

  app.post('/api/v1/appeals', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const matchIdValue = positiveInt(req.body?.matchId ?? req.body?.match_id, 'matchId')
      const match = getMatch(db, matchIdValue)
      if (match.status !== 'settled') throw apiError('CONFLICT', '只有已结算局可申诉')
      if (match.mode !== 'match') throw apiError('VALIDATION', '暂只支持 1v1 对赌局申诉，坐庄/彩池局请联系管理员改判')
      assertParticipant(db, match, req.user.id)
      const checked = validateAppeal({ stake: req.body?.stake, balance: balanceAfter(db, req.user.id) })
      if (!checked.ok) throw apiError('VALIDATION', checked.error)
      db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(checked.stake, req.user.id)
      insertLedger(db, {
        userId: req.user.id,
        type: 'appeal_stake',
        kind: 'system',
        amount: -checked.stake,
        ref: matchRef(match.id),
        ts,
        requestId: key,
      })
      const info = db.prepare(`
        INSERT INTO appeals (match_id, user_id, reason, stake, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(match.id, req.user.id, String(req.body?.reason || '').trim(), checked.stake, ts)
      const appeal = db.prepare('SELECT * FROM appeals WHERE id=?').get(Number(info.lastInsertRowid))
      feed(db, 'appeal', req.user.id, `${match.title} 发起申诉`, matchRef(match.id), ts)
      return { appeal }
    }))
  })

  app.post('/api/v1/admin/appeals/:id/resolve', { preHandler: requireAdmin }, async (req) => {
    const ts = now()
    const key = idempotencyKey(req)
    return ok(runIdempotent(db, req.user.id, key, ts, () => {
      const appeal = db.prepare('SELECT * FROM appeals WHERE id=?').get(Number(req.params.id))
      if (!appeal) throw apiError('NOT_FOUND')
      if (appeal.status !== 'pending') throw apiError('CONFLICT', '申诉已处理')
      const verdict = String(req.body?.verdict || '').toLowerCase()
      if (verdict !== 'uphold' && verdict !== 'overturn') throw apiError('VALIDATION', 'verdict 必须是 uphold 或 overturn')
      resolveAppeal(db, appeal, verdict, req.body?.newResult ?? req.body?.new_result, req.user.id, ts, key)
      return { appeal: db.prepare('SELECT * FROM appeals WHERE id=?').get(appeal.id), match: rowToMatch(getMatch(db, appeal.match_id), getBets(db, appeal.match_id)) }
    }))
  })
}
