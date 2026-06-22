import { apiError } from './errors.js'

const COMMENT_MAX = 200
const COMMENT_COOLDOWN_MS = 1000

function positiveInt(value, field) {
  const out = Math.round(Number(value) || 0)
  if (!(out > 0)) throw apiError('VALIDATION', `${field} 必须大于 0`)
  return out
}

function cleanText(value, field = 'text', max = COMMENT_MAX) {
  const out = String(value || '').trim()
  if (!out) throw apiError('VALIDATION', `${field} 不能为空`)
  if (out.length > max) throw apiError('VALIDATION', `${field} 最多 ${max} 字`)
  return out
}

function feed(db, type, actorId, text, ref, ts, targetUserId = null) {
  db.prepare('INSERT INTO feed (type, actor_id, target_user_id, text, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(type, actorId || null, targetUserId || null, text, ref || null, ts)
}

function userBrief(row, extra = {}) {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    title: row.title,
    ...extra,
  }
}

function getUser(db, id) {
  const user = db.prepare("SELECT id, name, emoji, title, status, is_npc FROM users WHERE id=? AND status='approved'").get(id)
  if (!user) throw apiError('NOT_FOUND')
  return user
}

function friendshipRow(db, a, b) {
  return db.prepare(`
    SELECT * FROM friendships
    WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)
    LIMIT 1
  `).get(a, b, b, a)
}

function areFriends(db, a, b) {
  return friendshipRow(db, a, b)?.status === 'accepted'
}

function friendStatus(db, me, other) {
  if (me === other) return 'self'
  const row = friendshipRow(db, me, other)
  if (!row) return 'none'
  if (row.status === 'accepted') return 'friend'
  return row.user_a === me ? 'requested' : 'incoming'
}

function assertFriend(db, a, b) {
  if (!areFriends(db, a, b)) throw apiError('NOT_FRIENDS')
}

function assertCanSpeak(user, ts) {
  if (user.muted_until && user.muted_until > ts) throw apiError('MUTED')
}

function rowToComment(row) {
  return {
    id: row.id,
    scope: row.scope,
    refId: row.ref_id,
    userId: row.user_id,
    name: row.name,
    emoji: row.emoji,
    text: row.text,
    isSlap: Boolean(row.is_slap),
    replyToCommentId: row.reply_to_comment_id,
    replyToUserId: row.reply_to_user_id || null,
    replyToName: row.reply_to_name || '',
    replyToText: row.reply_to_text || '',
    createdAt: row.created_at,
  }
}

function insertComment(db, req, scope, refId, ts) {
  assertCanSpeak(req.user, ts)
  const latest = db.prepare(`
    SELECT created_at FROM comments
    WHERE user_id=? AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(req.user.id)
  if (latest && ts - latest.created_at < COMMENT_COOLDOWN_MS) throw apiError('RATE_LIMITED')
  const text = cleanText(req.body?.text)
  const replyToId = req.body?.replyToCommentId ?? req.body?.reply_to_comment_id
  let reply = null
  if (replyToId != null && replyToId !== '') {
    reply = db.prepare(`
      SELECT c.id, c.user_id AS userId, c.text, u.name
      FROM comments c JOIN users u ON u.id=c.user_id
      WHERE c.id=? AND c.scope=? AND c.ref_id=? AND c.deleted_at IS NULL
    `).get(positiveInt(replyToId, 'replyToCommentId'), scope, String(refId))
    if (!reply) throw apiError('NOT_FOUND', '要回复的评论不存在')
  }
  const info = db.prepare(`
    INSERT INTO comments (scope, ref_id, user_id, text, is_slap, reply_to_comment_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(scope, String(refId), req.user.id, text, req.body?.isSlap || req.body?.is_slap ? 1 : 0, reply?.id || null, ts)
  const row = db.prepare(`
    SELECT c.*, u.name, u.emoji,
           rc.user_id AS reply_to_user_id, ru.name AS reply_to_name, rc.text AS reply_to_text
    FROM comments c JOIN users u ON u.id=c.user_id
    LEFT JOIN comments rc ON rc.id=c.reply_to_comment_id
    LEFT JOIN users ru ON ru.id=rc.user_id
    WHERE c.id=?
  `).get(Number(info.lastInsertRowid))
  if (reply && reply.userId !== req.user.id) {
    const ref = scope === 'match' ? `match:${refId}` : `pm:${refId}`
    feed(db, 'comment_reply', req.user.id, `${req.user.name} 回复了你：${text.slice(0, 60)}`, ref, ts, reply.userId)
  }
  return row
}

function listComments(db, scope, refId) {
  return db.prepare(`
    SELECT c.*, u.name, u.emoji,
           rc.user_id AS reply_to_user_id, ru.name AS reply_to_name, rc.text AS reply_to_text
    FROM comments c JOIN users u ON u.id=c.user_id
    LEFT JOIN comments rc ON rc.id=c.reply_to_comment_id
    LEFT JOIN users ru ON ru.id=rc.user_id
    WHERE c.scope=? AND c.ref_id=? AND c.deleted_at IS NULL
    ORDER BY c.created_at ASC, c.id ASC
  `).all(scope, String(refId)).map(rowToComment)
}

function matchById(db, id) {
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(id)
  if (!match) throw apiError('NOT_FOUND')
  return match
}

function assertSidebetParticipant(db, match, userId) {
  if (match.owner_id === userId || match.taker_id === userId) return
  if (db.prepare('SELECT id FROM match_bets WHERE match_id=? AND user_id=?').get(match.id, userId)) return
  throw apiError('FORBIDDEN', '只有本局参与者可操作彩头')
}

export function registerSocialRoutes(app, { db, requireAuth, ok, now }) {
  app.get('/api/v1/friends', { preHandler: requireAuth }, async (req) => {
    const rows = db.prepare(`
      SELECT f.*, ua.name AS a_name, ua.emoji AS a_emoji, ua.title AS a_title,
             ub.name AS b_name, ub.emoji AS b_emoji, ub.title AS b_title
      FROM friendships f
      JOIN users ua ON ua.id=f.user_a
      JOIN users ub ON ub.id=f.user_b
      WHERE (f.user_a=? OR f.user_b=?)
        AND ua.status != 'deleted' AND ub.status != 'deleted'
      ORDER BY COALESCE(f.accepted_at, f.created_at) DESC
    `).all(req.user.id, req.user.id)
    const friends = []
    const incoming = []
    const outgoing = []
    for (const row of rows) {
      const otherIsB = row.user_a === req.user.id
      const other = otherIsB
        ? { id: row.user_b, name: row.b_name, emoji: row.b_emoji, title: row.b_title }
        : { id: row.user_a, name: row.a_name, emoji: row.a_emoji, title: row.a_title }
      if (row.status === 'accepted') friends.push(userBrief(other, { acceptedAt: row.accepted_at }))
      else if (row.user_b === req.user.id) incoming.push(userBrief(other, { requestedAt: row.created_at }))
      else outgoing.push(userBrief(other, { requestedAt: row.created_at }))
    }
    return ok({ friends, incoming, outgoing })
  })

  app.post('/api/v1/friends/:id/request', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const targetId = positiveInt(req.params.id, 'id')
    if (targetId === req.user.id) throw apiError('VALIDATION', '不能加自己')
    const target = getUser(db, targetId)
    if (target.is_npc) throw apiError('VALIDATION', '不能添加 NPC')
    const existing = friendshipRow(db, req.user.id, targetId)
    if (existing?.status === 'accepted') return ok({ status: 'friend' })
    if (existing?.status === 'requested') {
      if (existing.user_a === req.user.id) return ok({ status: 'requested' })
      db.prepare("UPDATE friendships SET status='accepted', accepted_at=? WHERE user_a=? AND user_b=?")
        .run(ts, targetId, req.user.id)
      feed(db, 'friend', req.user.id, `${req.user.name} 和 ${target.name} 已成为好友`, `friend:${targetId}`, ts)
      return ok({ status: 'friend' })
    }
    db.prepare('INSERT INTO friendships (user_a, user_b, status, created_at) VALUES (?, ?, ?, ?)')
      .run(req.user.id, targetId, 'requested', ts)
    return ok({ status: 'requested' })
  })

  app.post('/api/v1/friends/:id/accept', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const otherId = positiveInt(req.params.id, 'id')
    const other = getUser(db, otherId)
    const info = db.prepare(`
      UPDATE friendships SET status='accepted', accepted_at=?
      WHERE user_a=? AND user_b=? AND status='requested'
    `).run(ts, otherId, req.user.id)
    if (info.changes === 0) {
      if (areFriends(db, req.user.id, otherId)) return ok({ status: 'friend' })
      throw apiError('NOT_FOUND')
    }
    feed(db, 'friend', req.user.id, `${req.user.name} 和 ${other.name} 已成为好友`, `friend:${otherId}`, ts)
    return ok({ status: 'friend' })
  })

  app.post('/api/v1/friends/:id/decline', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const otherId = positiveInt(req.params.id, 'id')
    const other = getUser(db, otherId)
    const info = db.prepare("DELETE FROM friendships WHERE user_a=? AND user_b=? AND status='requested'")
      .run(otherId, req.user.id)
    if (info.changes === 0) throw apiError('NOT_FOUND')
    feed(db, 'friend', req.user.id, `${req.user.name} 拒绝了 ${other.name} 的好友申请`, `friend:${otherId}`, ts)
    return ok({ status: 'declined' })
  })

  app.delete('/api/v1/friends/:id', { preHandler: requireAuth }, async (req) => {
    const otherId = positiveInt(req.params.id, 'id')
    db.prepare('DELETE FROM friendships WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)')
      .run(req.user.id, otherId, otherId, req.user.id)
    return ok({ status: 'none' })
  })

  app.get('/api/v1/chats/:friendId', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const friendId = positiveInt(req.params.friendId, 'friendId')
    assertFriend(db, req.user.id, friendId)
    const since = Math.max(0, Number(req.query?.since || 0) || 0)
    const messages = db.prepare(`
      SELECT id, from_id AS fromId, to_id AS toId, text, read_at AS readAt, created_at AS createdAt
      FROM chats
      WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) AND id > ?
      ORDER BY id ASC
      LIMIT 100
    `).all(req.user.id, friendId, friendId, req.user.id, since)
    db.prepare('UPDATE chats SET read_at=? WHERE from_id=? AND to_id=? AND read_at IS NULL')
      .run(ts, friendId, req.user.id)
    return ok({ messages })
  })

  app.post('/api/v1/chats/:friendId', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const friendId = positiveInt(req.params.friendId, 'friendId')
    assertCanSpeak(req.user, ts)
    assertFriend(db, req.user.id, friendId)
    const text = cleanText(req.body?.text, 'text', 500)
    const info = db.prepare('INSERT INTO chats (from_id, to_id, text, created_at) VALUES (?, ?, ?, ?)')
      .run(req.user.id, friendId, text, ts)
    return ok({ message: { id: Number(info.lastInsertRowid), fromId: req.user.id, toId: friendId, text, createdAt: ts } })
  })

  app.get('/api/v1/matches/:id/comments', { preHandler: requireAuth }, async (req) => {
    matchById(db, Number(req.params.id))
    return ok({ comments: listComments(db, 'match', Number(req.params.id)) })
  })

  app.post('/api/v1/matches/:id/comments', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    matchById(db, Number(req.params.id))
    const comment = insertComment(db, req, 'match', Number(req.params.id), ts)
    return ok({ comment: rowToComment(comment) })
  })

  app.get('/api/v1/pm/:eventId/comments', { preHandler: requireAuth }, async (req) => {
    return ok({ comments: listComments(db, 'pm', req.params.eventId) })
  })

  app.post('/api/v1/pm/:eventId/comments', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const comment = insertComment(db, req, 'pm', req.params.eventId, ts)
    return ok({ comment: rowToComment(comment) })
  })

  app.get('/api/v1/users/search', { preHandler: requireAuth }, async (req) => {
    const q = String(req.query?.q || '').trim()
    if (!q) return ok({ users: [] })
    const phoneSearch = /^1\d{10}$/.test(q)
    const rows = phoneSearch
      ? db.prepare("SELECT id, name, emoji, title FROM users WHERE status='approved' AND is_npc=0 AND id!=? AND phone=? ORDER BY name LIMIT 20").all(req.user.id, q)
      : db.prepare("SELECT id, name, emoji, title FROM users WHERE status='approved' AND is_npc=0 AND id!=? AND name LIKE ? ORDER BY name LIMIT 20").all(req.user.id, `%${q}%`)
    return ok({ users: rows.map((row) => userBrief(row, { friendStatus: friendStatus(db, req.user.id, row.id) })) })
  })

  app.put('/api/v1/me/watchlist', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const eventId = cleanText(req.body?.eventId ?? req.body?.event_id, 'eventId', 200)
    db.prepare("INSERT OR IGNORE INTO watchlist (user_id, kind, ref_id, created_at) VALUES (?, 'pm', ?, ?)")
      .run(req.user.id, eventId, ts)
    return ok({ eventId })
  })

  app.delete('/api/v1/me/watchlist/:eventId', { preHandler: requireAuth }, async (req) => {
    db.prepare("DELETE FROM watchlist WHERE user_id=? AND kind='pm' AND ref_id=?")
      .run(req.user.id, String(req.params.eventId))
    return ok({ eventId: String(req.params.eventId) })
  })

  app.get('/api/v1/me/watchlist', { preHandler: requireAuth }, async (req) => {
    const items = db.prepare(`
      SELECT ref_id AS eventId, created_at AS createdAt
      FROM watchlist
      WHERE user_id=? AND kind='pm'
      ORDER BY created_at DESC
    `).all(req.user.id)
    return ok({ items })
  })

  app.post('/api/v1/matches/:id/sidebet/fulfill', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const match = matchById(db, Number(req.params.id))
    if (!match.side_bet_text) throw apiError('VALIDATION', '这局没有口头彩头')
    assertSidebetParticipant(db, match, req.user.id)
    db.prepare('UPDATE matches SET side_bet_fulfilled=1, side_bet_fulfilled_at=?, updated_at=? WHERE id=?')
      .run(ts, ts, match.id)
    feed(db, 'sidebet', req.user.id, `「${match.title}」的彩头「${match.side_bet_text}」已还愿`, `match:${match.id}`, ts)
    return ok({ fulfilled: true })
  })

  app.post('/api/v1/matches/:id/sidebet/nag', { preHandler: requireAuth }, async (req) => {
    const ts = now()
    const match = matchById(db, Number(req.params.id))
    if (!match.side_bet_text) throw apiError('VALIDATION', '这局没有口头彩头')
    assertSidebetParticipant(db, match, req.user.id)
    if (match.side_bet_fulfilled) return ok({ nagged: false, fulfilled: true })
    feed(db, 'sidebet', req.user.id, `催债：「${match.title}」说好的「${match.side_bet_text}」该还愿了`, `match:${match.id}`, ts)
    return ok({ nagged: true })
  })
}
