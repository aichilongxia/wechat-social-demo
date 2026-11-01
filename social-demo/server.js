const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { isIP } = require('node:net')
const { randomBytes } = require('node:crypto')
const { WebSocketServer } = require('ws')
const { SocialStore } = require('./store')

const MAX_JSON_BYTES = 3 * 1024 * 1024
const IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp']
])

function sendJson(response, status, body) {
  const content = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'x-content-type-options': 'nosniff'
  })
  response.end(content)
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
        reject(new Error('请求内容过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch { reject(new Error('JSON格式无效')) }
    })
    request.on('error', reject)
  })
}

function bearerToken(request) {
  const header = request.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

function mimeType(filename) {
  const extension = path.extname(filename).toLowerCase()
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  }[extension] || 'application/octet-stream'
}

function isValidImageBuffer(type, buffer) {
  if (type === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (type === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (type === 'image/gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
  if (type === 'image/webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  return false
}

function createSocialServer(options = {}) {
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, 'public'))
  const uploadDir = path.resolve(options.uploadDir || path.join(__dirname, 'data', 'uploads'))
  const dbPath = options.dbPath || path.join(__dirname, 'data', 'social.db')
  fs.mkdirSync(path.dirname(dbPath === ':memory:' ? path.join(__dirname, 'data', 'memory.db') : dbPath), { recursive: true })
  fs.mkdirSync(uploadDir, { recursive: true })
  const store = new SocialStore(dbPath)
  const clients = new Map()
  const limits = {
    authMax: 20,
    authWindowMs: 10 * 60 * 1000,
    apiMax: 300,
    apiWindowMs: 60 * 1000,
    imageMax: 30,
    imageWindowMs: 60 * 60 * 1000,
    ...(options.rateLimits || {})
  }
  const rateBuckets = new Map()

  function allowRequest(request, url) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map(value => value.trim()).filter(value => isIP(value))
    const socketAddress = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '')
    const address = forwarded.at(-1) || (isIP(socketAddress) ? socketAddress : 'unknown')
    const authRoute = ['/api/login', '/api/register'].includes(url.pathname)
    const imageRoute = url.pathname === '/api/images' && request.method === 'POST'
    const category = authRoute ? 'auth' : imageRoute ? 'image' : 'api'
    const max = limits[`${category}Max`]
    const windowMs = limits[`${category}WindowMs`]
    const key = `${address}:${category}`
    const now = Date.now()
    if (rateBuckets.size > 5000) {
      for (const [bucketKey, value] of rateBuckets) {
        if (now >= value.expiresAt) rateBuckets.delete(bucketKey)
      }
      while (rateBuckets.size > 10000) rateBuckets.delete(rateBuckets.keys().next().value)
    }
    let bucket = rateBuckets.get(key)
    if (!bucket || now >= bucket.expiresAt) bucket = { expiresAt: now + windowMs, count: 0 }
    bucket.count++
    rateBuckets.set(key, bucket)
    return bucket.count <= max
  }

  function authenticated(request) {
    return store.userForToken(bearerToken(request))
  }

  function broadcast(userId, message) {
    const socket = clients.get(Number(userId))
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }

  function broadcastMessage(message) {
    const event = { event: 'message:new', message }
    broadcast(message.senderId, event)
    if (message.recipientId !== message.senderId) broadcast(message.recipientId, event)
  }

  async function handleApi(request, response, url) {
    try {
      if (request.method === 'POST' && url.pathname === '/api/register') {
        const body = await readJson(request)
        return sendJson(response, 201, { user: store.register(body.username, body.password) })
      }
      if (request.method === 'POST' && url.pathname === '/api/login') {
        const body = await readJson(request)
        return sendJson(response, 200, store.login(body.username, body.password))
      }

      const user = authenticated(request)
      if (!user) return sendJson(response, 401, { error: '请先登录' })

      if (request.method === 'POST' && url.pathname === '/api/logout') {
        store.revokeToken(bearerToken(request))
        const socket = clients.get(user.id)
        if (socket) socket.close(4002, '已退出登录')
        return sendJson(response, 200, { ok: true })
      }

      const protectedImageMatch = url.pathname.match(/^\/api\/images\/(\d+)$/)
      if (protectedImageMatch && request.method === 'GET') {
        const message = store.imageMessageForUser(Number(protectedImageMatch[1]), user.id)
        if (!message) return sendJson(response, 404, { error: '图片不存在' })
        const filename = path.basename(message.content)
        const fullPath = path.join(uploadDir, filename)
        if (!fs.existsSync(fullPath)) return sendJson(response, 404, { error: '图片文件不存在' })
        response.writeHead(200, {
          'content-type': mimeType(filename),
          'content-length': fs.statSync(fullPath).size,
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff'
        })
        return fs.createReadStream(fullPath).pipe(response)
      }

      if (request.method === 'GET' && url.pathname === '/api/me') return sendJson(response, 200, { user })
      if (request.method === 'GET' && url.pathname === '/api/users/search') {
        return sendJson(response, 200, { users: store.searchUsers(url.searchParams.get('q'), user.id) })
      }
      if (request.method === 'GET' && url.pathname === '/api/friends') {
        return sendJson(response, 200, { friends: store.friendsFor(user.id) })
      }
      if (url.pathname === '/api/friend-requests' && request.method === 'GET') {
        return sendJson(response, 200, { requests: store.friendRequestsFor(user.id) })
      }
      if (url.pathname === '/api/friend-requests' && request.method === 'POST') {
        const body = await readJson(request)
        const result = store.sendFriendRequest(user.id, Number(body.targetUserId))
        broadcast(Number(body.targetUserId), { event: 'friends:changed' })
        return sendJson(response, 201, { request: result })
      }
      const acceptMatch = url.pathname.match(/^\/api\/friend-requests\/(\d+)\/accept$/)
      if (acceptMatch && request.method === 'POST') {
        const requestRow = store.friendRequestsFor(user.id).find(item => item.id === Number(acceptMatch[1]))
        const result = store.acceptFriendRequest(user.id, Number(acceptMatch[1]))
        broadcast(user.id, { event: 'friends:changed' })
        if (requestRow) broadcast(requestRow.fromUserId, { event: 'friends:changed' })
        return sendJson(response, 200, { request: result })
      }
      if (url.pathname === '/api/messages' && request.method === 'POST') {
        const body = await readJson(request)
        const message = store.sendMessage(user.id, Number(body.friendId), 'text', body.text)
        broadcastMessage(message)
        return sendJson(response, 201, { message })
      }
      const messageMatch = url.pathname.match(/^\/api\/messages\/(\d+)$/)
      if (messageMatch && request.method === 'GET') {
        const messages = store.messagesBetween(user.id, Number(messageMatch[1]), Number(url.searchParams.get('after') || 0))
        return sendJson(response, 200, { messages })
      }
      if (url.pathname === '/api/images' && request.method === 'POST') {
        const body = await readJson(request)
        const friendId = Number(body.friendId)
        if (!store.areFriends(user.id, friendId)) throw new Error('还不是好友')
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''))
        if (!match || !IMAGE_TYPES.has(match[1])) throw new Error('图片格式不支持')
        const buffer = Buffer.from(match[2], 'base64')
        if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw new Error('图片不能超过2MB')
        if (!isValidImageBuffer(match[1], buffer)) throw new Error('图片内容无效')
        const filename = `${Date.now()}-${randomBytes(8).toString('hex')}.${IMAGE_TYPES.get(match[1])}`
        fs.writeFileSync(path.join(uploadDir, filename), buffer, { flag: 'wx' })
        const message = store.sendMessage(user.id, friendId, 'image', filename)
        broadcastMessage(message)
        return sendJson(response, 201, { message })
      }
      return sendJson(response, 404, { error: '接口不存在' })
    } catch (error) {
      return sendJson(response, 400, { error: error.message || '请求失败' })
    }
  }

  function serveFile(response, root, relativePath) {
    const normalized = relativePath.replace(/^\/+/, '')
    const filename = path.resolve(root, normalized)
    if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) return sendJson(response, 403, { error: '禁止访问' })
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return sendJson(response, 404, { error: '文件不存在' })
    response.writeHead(200, {
      'content-type': mimeType(filename),
      'content-length': fs.statSync(filename).size,
      'cache-control': filename.endsWith('.html') ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff'
    })
    fs.createReadStream(filename).pipe(response)
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      if (!allowRequest(request, url)) return sendJson(response, 429, { error: '请求过于频繁，请稍后再试' })
      return void handleApi(request, response, url)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: '方法不允许' })
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    return serveFile(response, publicDir, relative)
  })

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname !== '/ws') return socket.destroy()
    const user = store.userForToken(url.searchParams.get('token') || '')
    if (!user) return socket.destroy()
    websocketServer.handleUpgrade(request, socket, head, client => websocketServer.emit('connection', client, user))
  })

  websocketServer.on('connection', (socket, user) => {
    const previous = clients.get(user.id)
    if (previous && previous !== socket) previous.close(4001, '其他页面已登录')
    clients.set(user.id, socket)
    socket.send(JSON.stringify({ event: 'ready', user }))
    socket.on('message', raw => {
      try {
        const message = JSON.parse(String(raw))
        const targetUserId = Number(message.targetUserId)
        const allowedKinds = new Set(['call-offer', 'call-answer', 'ice-candidate', 'call-end'])
        if (message.event !== 'signal' || !allowedKinds.has(message.kind)) return
        if (!store.areFriends(user.id, targetUserId)) return
        broadcast(targetUserId, { event: 'signal', fromUserId: user.id, kind: message.kind, payload: message.payload || null })
      } catch {
        socket.close(1003, '消息格式无效')
      }
    })
    socket.on('close', () => {
      if (clients.get(user.id) === socket) clients.delete(user.id)
    })
  })

  return { server, store, clients, websocketServer }
}

if (require.main === module) {
  const app = createSocialServer()
  const port = Number(process.env.PORT || 8787)
  const host = process.env.HOST || '127.0.0.1'
  app.server.listen(port, host, () => {
    console.log(`Social demo running at http://${host}:${port}`)
  })
}

module.exports = { createSocialServer }
