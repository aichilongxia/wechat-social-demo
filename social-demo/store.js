const { DatabaseSync } = require('node:sqlite')
const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto')

class SocialStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS friend_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request
        ON friend_requests(from_user_id, to_user_id) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS friendships (
        user1_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user2_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user1_id, user2_id),
        CHECK (user1_id < user2_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('text', 'image')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_pair ON messages(sender_id, recipient_id, id);
    `)
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all().map(column => column.name)
    if (!sessionColumns.includes('expires_at')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN expires_at INTEGER')
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE expires_at IS NULL').run(Date.now() + 7 * 24 * 60 * 60 * 1000)
    }
  }

  publicUser(row) {
    return row ? { id: row.id, username: row.username } : null
  }

  register(username, password) {
    const normalized = String(username || '').trim()
    if (!/^[\p{L}\p{N}_-]{2,20}$/u.test(normalized)) throw new Error('用户名需为2到20个字符')
    if (typeof password !== 'string' || password.length < 8) throw new Error('密码至少8位')
    const salt = randomBytes(16).toString('hex')
    const passwordHash = scryptSync(password, salt, 64).toString('hex')
    try {
      const result = this.db.prepare('INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)').run(normalized, passwordHash, salt, Date.now())
      return { id: Number(result.lastInsertRowid), username: normalized }
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new Error('用户名已存在')
      throw error
    }
  }

  login(username, password) {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim())
    if (!row || typeof password !== 'string') throw new Error('用户名或密码错误')
    const actual = scryptSync(password, row.salt, 64)
    const expected = Buffer.from(row.password_hash, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('用户名或密码错误')
    const token = randomBytes(32).toString('hex')
    const now = Date.now()
    this.db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, row.id, now, now + 7 * 24 * 60 * 60 * 1000)
    return { token, user: this.publicUser(row) }
  }

  userForToken(token) {
    const row = this.db.prepare(`
      SELECT users.id, users.username FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ? AND sessions.expires_at > ?
    `).get(token, Date.now())
    return this.publicUser(row)
  }

  revokeToken(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
  }

  userById(id) {
    return this.publicUser(this.db.prepare('SELECT id, username FROM users WHERE id = ?').get(id))
  }

  searchUsers(query, excludeUserId) {
    const term = `%${String(query || '').trim().slice(0, 40)}%`
    return this.db.prepare('SELECT id, username FROM users WHERE id != ? AND username LIKE ? COLLATE NOCASE ORDER BY username LIMIT 20').all(excludeUserId, term).map(row => this.publicUser(row))
  }

  areFriends(firstId, secondId) {
    const user1 = Math.min(firstId, secondId)
    const user2 = Math.max(firstId, secondId)
    return Boolean(this.db.prepare('SELECT 1 FROM friendships WHERE user1_id = ? AND user2_id = ?').get(user1, user2))
  }

  sendFriendRequest(fromUserId, toUserId) {
    if (fromUserId === toUserId) throw new Error('不能添加自己')
    if (!this.userById(toUserId)) throw new Error('用户不存在')
    if (this.areFriends(fromUserId, toUserId)) throw new Error('已经是好友')
    const reverse = this.db.prepare("SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'").get(toUserId, fromUserId)
    if (reverse) return this.acceptFriendRequest(fromUserId, reverse.id)
    try {
      const result = this.db.prepare("INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at) VALUES (?, ?, 'pending', ?)").run(fromUserId, toUserId, Date.now())
      return { id: Number(result.lastInsertRowid), fromUserId, toUserId, status: 'pending' }
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new Error('好友申请已发送')
      throw error
    }
  }

  friendRequestsFor(userId) {
    return this.db.prepare(`
      SELECT friend_requests.id, friend_requests.from_user_id AS fromUserId,
             users.username AS fromUsername, friend_requests.created_at AS createdAt
      FROM friend_requests JOIN users ON users.id = friend_requests.from_user_id
      WHERE friend_requests.to_user_id = ? AND friend_requests.status = 'pending'
      ORDER BY friend_requests.id DESC
    `).all(userId)
  }

  acceptFriendRequest(userId, requestId) {
    const request = this.db.prepare("SELECT * FROM friend_requests WHERE id = ? AND to_user_id = ? AND status = 'pending'").get(requestId, userId)
    if (!request) throw new Error('好友申请不存在')
    const user1 = Math.min(request.from_user_id, request.to_user_id)
    const user2 = Math.max(request.from_user_id, request.to_user_id)
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT OR IGNORE INTO friendships (user1_id, user2_id, created_at) VALUES (?, ?, ?)').run(user1, user2, Date.now())
      this.db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(requestId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { id: requestId, status: 'accepted' }
  }

  friendsFor(userId) {
    return this.db.prepare(`
      SELECT users.id, users.username FROM friendships
      JOIN users ON users.id = CASE WHEN friendships.user1_id = ? THEN friendships.user2_id ELSE friendships.user1_id END
      WHERE friendships.user1_id = ? OR friendships.user2_id = ?
      ORDER BY users.username COLLATE NOCASE
    `).all(userId, userId, userId).map(row => this.publicUser(row))
  }

  sendMessage(senderId, recipientId, type, content) {
    if (!this.areFriends(senderId, recipientId)) throw new Error('还不是好友')
    if (!['text', 'image'].includes(type)) throw new Error('消息类型无效')
    const value = String(content || '').trim()
    if (!value || value.length > 5000) throw new Error('消息内容无效')
    const createdAt = Date.now()
    const result = this.db.prepare('INSERT INTO messages (sender_id, recipient_id, type, content, created_at) VALUES (?, ?, ?, ?, ?)').run(senderId, recipientId, type, value, createdAt)
    return { id: Number(result.lastInsertRowid), senderId, recipientId, type, content: value, createdAt }
  }

  messagesBetween(userId, friendId, afterId = 0) {
    if (!this.areFriends(userId, friendId)) throw new Error('还不是好友')
    if (afterId > 0) return this.db.prepare(`
      SELECT id, sender_id AS senderId, recipient_id AS recipientId, type, content, created_at AS createdAt
      FROM messages
      WHERE id > ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
      ORDER BY id ASC LIMIT 500
    `).all(afterId, userId, friendId, friendId, userId)
    return this.db.prepare(`
      SELECT id, sender_id AS senderId, recipient_id AS recipientId, type, content, created_at AS createdAt
      FROM messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
      ORDER BY id DESC LIMIT 500
    `).all(userId, friendId, friendId, userId).reverse()
  }

  imageMessageForUser(messageId, userId) {
    return this.db.prepare(`
      SELECT id, sender_id AS senderId, recipient_id AS recipientId, type, content, created_at AS createdAt
      FROM messages
      WHERE id = ? AND type = 'image' AND (sender_id = ? OR recipient_id = ?)
    `).get(messageId, userId, userId) || null
  }

  close() {
    this.db.close()
  }
}

module.exports = { SocialStore }
