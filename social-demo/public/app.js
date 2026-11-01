const $ = id => document.getElementById(id)
const state = {
  token: localStorage.getItem('social-demo-token') || '',
  user: null,
  accountGeneration: 0,
  friends: [],
  currentFriend: null,
  messages: [],
  conversationGeneration: 0,
  imageObjectUrls: [],
  socket: null,
  peerConnection: null,
  localStream: null,
  remoteStream: null,
  callFriendId: null,
  pendingOffer: null,
  pendingCandidates: [],
  callGeneration: 0,
  callId: '',
  muted: false
}

const els = {
  authShell: $('authShell'), wechatApp: $('wechatApp'), loginForm: $('loginForm'), registerForm: $('registerForm'),
  showLogin: $('showLogin'), showRegister: $('showRegister'), authError: $('authError'),
  loginUsername: $('loginUsername'), loginPassword: $('loginPassword'), registerUsername: $('registerUsername'), registerPassword: $('registerPassword'),
  myAvatar: $('myAvatar'), myUsername: $('myUsername'), socketStatus: $('socketStatus'), logoutBtn: $('logoutBtn'), refreshBtn: $('refreshBtn'),
  chatNav: $('chatNav'), friendsNav: $('friendsNav'), requestsNav: $('requestsNav'), addFriendNav: $('addFriendNav'), requestBadge: $('requestBadge'),
  friendSearch: $('friendSearch'), searchFriendBtn: $('searchFriendBtn'), listTitle: $('listTitle'), friendList: $('friendList'), friendRequests: $('friendRequests'), searchResults: $('searchResults'),
  emptyChat: $('emptyChat'), activeChat: $('activeChat'), chatFriendName: $('chatFriendName'), chatOnlineStatus: $('chatOnlineStatus'),
  chatMessages: $('chatMessages'), messageInput: $('messageInput'), sendBtn: $('sendBtn'), imageInput: $('imageInput'), voiceCallBtn: $('voiceCallBtn'),
  callOverlay: $('callOverlay'), callAvatar: $('callAvatar'), callName: $('callName'), callStatus: $('callStatus'), answerCallBtn: $('answerCallBtn'),
  muteCallBtn: $('muteCallBtn'), hangupCallBtn: $('hangupCallBtn'), remoteAudio: $('remoteAudio'), toast: $('toast')
}

function showToast(message) {
  els.toast.textContent = message
  els.toast.classList.add('show')
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200)
}

async function api(pathname, options = {}) {
  const response = await fetch(pathname, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || '请求失败')
  return body
}

function avatarText(username) {
  return String(username || '友').slice(0, 1).toUpperCase()
}

function switchAuth(mode) {
  const login = mode === 'login'
  els.loginForm.hidden = !login
  els.registerForm.hidden = login
  els.showLogin.classList.toggle('active', login)
  els.showRegister.classList.toggle('active', !login)
  els.authError.textContent = ''
}

function showApp() {
  els.authShell.hidden = true
  els.wechatApp.hidden = false
  els.myUsername.textContent = state.user.username
  els.myAvatar.textContent = avatarText(state.user.username)
}

function resetAccountState() {
  state.conversationGeneration++
  state.friends = []
  state.currentFriend = null
  state.messages = []
  state.imageObjectUrls.forEach(url => URL.revokeObjectURL(url))
  state.imageObjectUrls = []
  state.user = null
  els.friendList.replaceChildren()
  els.friendRequests.replaceChildren()
  els.searchResults.replaceChildren()
  els.chatMessages.replaceChildren()
  els.friendSearch.value = ''
  els.messageInput.value = ''
  els.imageInput.value = ''
  els.loginUsername.value = ''
  els.loginPassword.value = ''
  els.registerUsername.value = ''
  els.registerPassword.value = ''
  els.authError.textContent = ''
  els.requestBadge.hidden = true
  els.activeChat.hidden = true
  els.emptyChat.hidden = false
  document.querySelector('.chat-pane').classList.remove('mobile-open')
}

async function logout() {
  state.accountGeneration++
  hangUpCall(false)
  try {
    if (state.token) await api('/api/logout', { method: 'POST', body: '{}' })
  } catch {}
  state.token = ''
  localStorage.removeItem('social-demo-token')
  if (state.socket) state.socket.close()
  state.socket = null
  resetAccountState()
  els.wechatApp.hidden = true
  els.authShell.hidden = false
  switchAuth('login')
}

async function login(username, password) {
  const generation = ++state.accountGeneration
  const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) })
  if (generation !== state.accountGeneration) return
  state.token = result.token
  state.user = result.user
  localStorage.setItem('social-demo-token', state.token)
  showApp()
  connectSocket()
  await refreshSocialData()
}

async function restoreSession() {
  if (!state.token) return
  const generation = state.accountGeneration
  try {
    const result = await api('/api/me')
    if (generation !== state.accountGeneration) return
    state.user = result.user
    showApp()
    connectSocket()
    await refreshSocialData()
  } catch {
    if (generation === state.accountGeneration) await logout()
  }
}

function applyMessage(message) {
  if (!state.currentFriend) return
  const belongs = message.senderId === state.currentFriend.id || message.recipientId === state.currentFriend.id
  if (!belongs || state.messages.some(item => item.id === message.id)) return
  state.messages.push(message)
  renderMessages()
}

function connectSocket() {
  if (state.socket) state.socket.close()
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(state.token)}`)
  state.socket = socket
  els.socketStatus.textContent = '正在连接…'
  socket.addEventListener('open', () => { els.socketStatus.textContent = '已连接' })
  socket.addEventListener('close', () => {
    if (state.socket !== socket || !state.token) return
    els.socketStatus.textContent = '连接断开，正在重连…'
    setTimeout(connectSocket, 1500)
  })
  socket.addEventListener('message', async event => {
    if (state.socket !== socket || !state.user) return
    const message = JSON.parse(event.data)
    if (message.event === 'message:new') {
      applyMessage(message.message)
      return
    }
    if (message.event === 'friends:changed') {
      await refreshSocialData()
      return
    }
    if (message.event === 'signal') await handleSignal(message)
  })
}

function contactItem(friend) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `contact-item${state.currentFriend && state.currentFriend.id === friend.id ? ' active' : ''}`
  const avatar = document.createElement('span')
  avatar.className = 'contact-avatar'
  avatar.textContent = avatarText(friend.username)
  const copy = document.createElement('span')
  copy.className = 'contact-copy'
  const name = document.createElement('strong')
  name.textContent = friend.username
  const hint = document.createElement('small')
  hint.textContent = '点击开始聊天'
  copy.append(name, hint)
  button.append(avatar, copy)
  button.addEventListener('click', () => selectFriend(friend))
  return button
}

function renderFriends() {
  els.friendList.replaceChildren()
  if (!state.friends.length) {
    const empty = document.createElement('div')
    empty.className = 'system-note'
    empty.textContent = '还没有好友，点击左侧“＋”添加'
    els.friendList.appendChild(empty)
    return
  }
  state.friends.forEach(friend => els.friendList.appendChild(contactItem(friend)))
}

async function loadFriends() {
  const generation = state.accountGeneration
  const result = await api('/api/friends')
  if (generation !== state.accountGeneration || !state.user) return
  state.friends = result.friends
  renderFriends()
}

async function loadFriendRequests() {
  const generation = state.accountGeneration
  const result = await api('/api/friend-requests')
  if (generation !== state.accountGeneration || !state.user) return
  els.requestBadge.hidden = !result.requests.length
  els.friendRequests.replaceChildren()
  result.requests.forEach(request => {
    const row = document.createElement('div')
    row.className = 'request-item'
    const avatar = document.createElement('span')
    avatar.className = 'contact-avatar'
    avatar.textContent = avatarText(request.fromUsername)
    const copy = document.createElement('span')
    copy.className = 'contact-copy'
    const name = document.createElement('strong')
    name.textContent = request.fromUsername
    const hint = document.createElement('small')
    hint.textContent = '请求添加你为好友'
    copy.append(name, hint)
    const accept = document.createElement('button')
    accept.className = 'mini-action'
    accept.textContent = '接受'
    accept.addEventListener('click', async () => {
      try {
        await api(`/api/friend-requests/${request.id}/accept`, { method: 'POST', body: '{}' })
        showToast('已添加好友')
        await refreshSocialData()
      } catch (error) { showToast(error.message) }
    })
    row.append(avatar, copy, accept)
    els.friendRequests.appendChild(row)
  })
  if (!result.requests.length) {
    const empty = document.createElement('div')
    empty.className = 'system-note'
    empty.textContent = '暂无新的好友申请'
    els.friendRequests.appendChild(empty)
  }
}

async function refreshSocialData() {
  await Promise.all([loadFriends(), loadFriendRequests()])
}

function showList(mode) {
  els.friendList.hidden = mode !== 'friends'
  els.friendRequests.hidden = mode !== 'requests'
  els.searchResults.hidden = mode !== 'search'
  els.listTitle.textContent = mode === 'friends' ? '好友' : mode === 'requests' ? '好友申请' : '搜索结果'
  for (const button of [els.chatNav, els.friendsNav, els.requestsNav, els.addFriendNav]) button.classList.remove('active')
  if (mode === 'friends') els.friendsNav.classList.add('active')
  if (mode === 'requests') els.requestsNav.classList.add('active')
  if (mode === 'search') els.addFriendNav.classList.add('active')
}

async function searchUsers() {
  const query = els.friendSearch.value.trim()
  if (!query) return showToast('请输入用户名')
  const generation = state.accountGeneration
  try {
    const result = await api(`/api/users/search?q=${encodeURIComponent(query)}`)
    if (generation !== state.accountGeneration || !state.user) return
    els.searchResults.replaceChildren()
    result.users.forEach(user => {
      const row = document.createElement('div')
      row.className = 'search-item'
      const avatar = document.createElement('span')
      avatar.className = 'contact-avatar'
      avatar.textContent = avatarText(user.username)
      const copy = document.createElement('span')
      copy.className = 'contact-copy'
      const name = document.createElement('strong')
      name.textContent = user.username
      copy.appendChild(name)
      const add = document.createElement('button')
      add.className = 'mini-action'
      add.textContent = state.friends.some(friend => friend.id === user.id) ? '已是好友' : '添加'
      add.disabled = state.friends.some(friend => friend.id === user.id)
      add.addEventListener('click', async () => {
        try {
          await api('/api/friend-requests', { method: 'POST', body: JSON.stringify({ targetUserId: user.id }) })
          add.disabled = true
          add.textContent = '已发送'
          showToast('好友申请已发送')
        } catch (error) { showToast(error.message) }
      })
      row.append(avatar, copy, add)
      els.searchResults.appendChild(row)
    })
    if (!result.users.length) {
      const empty = document.createElement('div')
      empty.className = 'system-note'
      empty.textContent = '没有找到用户'
      els.searchResults.appendChild(empty)
    }
    showList('search')
  } catch (error) { showToast(error.message) }
}

async function selectFriend(friend) {
  const friendId = friend.id
  const generation = ++state.conversationGeneration
  state.currentFriend = friend
  els.emptyChat.hidden = true
  els.activeChat.hidden = false
  els.chatFriendName.textContent = friend.username
  els.chatOnlineStatus.textContent = '好友聊天'
  document.querySelector('.chat-pane').classList.add('mobile-open')
  renderFriends()
  try {
    const result = await api(`/api/messages/${friendId}`)
    if (generation !== state.conversationGeneration || !state.currentFriend || state.currentFriend.id !== friendId) return
    state.messages = result.messages
    renderMessages()
  } catch (error) {
    if (generation === state.conversationGeneration) showToast(error.message)
  }
}

async function loadProtectedImage(image, messageId, generation) {
  try {
    const response = await fetch(`/api/images/${messageId}`, { headers: { authorization: `Bearer ${state.token}` } })
    if (!response.ok) throw new Error('图片加载失败')
    const blob = await response.blob()
    if (generation !== state.conversationGeneration || !image.isConnected) return
    const objectUrl = URL.createObjectURL(blob)
    state.imageObjectUrls.push(objectUrl)
    image.src = objectUrl
  } catch {
    if (generation === state.conversationGeneration) image.alt = '图片加载失败'
  }
}

function renderMessages() {
  state.imageObjectUrls.forEach(url => URL.revokeObjectURL(url))
  state.imageObjectUrls = []
  const generation = state.conversationGeneration
  els.chatMessages.replaceChildren()
  for (const message of state.messages) {
    const row = document.createElement('div')
    const mine = message.senderId === state.user.id
    row.className = `message-row${mine ? ' me' : ''}`
    const avatar = document.createElement('div')
    avatar.className = 'message-avatar'
    avatar.textContent = mine ? avatarText(state.user.username) : avatarText(state.currentFriend.username)
    const bubble = document.createElement('div')
    bubble.className = `message-bubble${message.type === 'image' ? ' image' : ''}`
    if (message.type === 'image') {
      const image = document.createElement('img')
      image.alt = '聊天图片'
      image.loading = 'lazy'
      bubble.appendChild(image)
      loadProtectedImage(image, message.id, generation)
    } else bubble.textContent = message.content
    row.append(avatar, bubble)
    els.chatMessages.appendChild(row)
  }
  requestAnimationFrame(() => { els.chatMessages.scrollTop = els.chatMessages.scrollHeight })
}

async function sendTextMessage() {
  if (!state.currentFriend) return
  const text = els.messageInput.value.trim()
  if (!text) return
  try {
    const result = await api('/api/messages', { method: 'POST', body: JSON.stringify({ friendId: state.currentFriend.id, text }) })
    applyMessage(result.message)
    els.messageInput.value = ''
  } catch (error) { showToast(error.message) }
}

async function sendImage(file) {
  if (!state.currentFriend || !file) return
  const friendId = state.currentFriend.id
  if (file.size > 2 * 1024 * 1024) return showToast('图片不能超过2MB')
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
  try {
    const result = await api('/api/images', { method: 'POST', body: JSON.stringify({ friendId, dataUrl }) })
    applyMessage(result.message)
  } catch (error) { showToast(error.message) }
}

function sendSignal(kind, payload, targetUserId = state.callFriendId) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !targetUserId) return
  state.socket.send(JSON.stringify({ event: 'signal', targetUserId, kind, payload }))
}

function createCallId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isCurrentCall(generation, callId) {
  return state.callGeneration === generation && state.callId === callId
}

function createPeerConnection(friendId, generation, callId) {
  if (state.peerConnection) state.peerConnection.close()
  const connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  state.peerConnection = connection
  state.callFriendId = friendId
  connection.onicecandidate = event => {
    if (!isCurrentCall(generation, callId) || state.peerConnection !== connection) return
    if (event.candidate) sendSignal('ice-candidate', { callId, candidate: event.candidate })
  }
  connection.ontrack = event => {
    if (!isCurrentCall(generation, callId) || state.peerConnection !== connection) return
    state.remoteStream = event.streams[0]
    els.remoteAudio.srcObject = state.remoteStream
    els.callStatus.textContent = '通话中'
  }
  connection.onconnectionstatechange = () => {
    if (!isCurrentCall(generation, callId) || state.peerConnection !== connection) return
    if (['failed', 'disconnected', 'closed'].includes(connection.connectionState)) hangUpCall(false)
  }
  return connection
}

async function getMicrophone(generation) {
  if (state.localStream && state.localStream.active && state.callGeneration === generation) return state.localStream
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
  if (state.callGeneration !== generation) {
    stream.getTracks().forEach(track => track.stop())
    const error = new Error('call cancelled')
    error.name = 'AbortError'
    throw error
  }
  state.localStream = stream
  return stream
}

function showCall(friend, status) {
  els.callName.textContent = friend ? friend.username : '好友'
  els.callAvatar.textContent = avatarText(friend && friend.username)
  els.callStatus.textContent = status
  els.callOverlay.hidden = false
}

async function startVoiceCall() {
  if (!state.currentFriend || !els.callOverlay.hidden) return
  const friend = state.currentFriend
  const generation = ++state.callGeneration
  const callId = createCallId()
  state.callId = callId
  state.callFriendId = friend.id
  state.pendingCandidates = []
  state.pendingOffer = null
  try {
    showCall(friend, '正在呼叫…')
    els.answerCallBtn.hidden = true
    const stream = await getMicrophone(generation)
    if (!isCurrentCall(generation, callId)) return
    const connection = createPeerConnection(friend.id, generation, callId)
    stream.getTracks().forEach(track => connection.addTrack(track, stream))
    const offer = await connection.createOffer()
    if (!isCurrentCall(generation, callId)) return
    await connection.setLocalDescription(offer)
    if (!isCurrentCall(generation, callId)) return
    sendSignal('call-offer', { callId, description: offer })
  } catch (error) {
    if (!isCurrentCall(generation, callId)) return
    if (error.name !== 'AbortError') showToast(error.name === 'NotAllowedError' ? '请允许麦克风权限' : '无法发起通话')
    hangUpCall(false)
  }
}

async function answerIncomingCall() {
  if (!state.pendingOffer || !state.callFriendId || !state.callId) return
  const generation = state.callGeneration
  const callId = state.callId
  const friendId = state.callFriendId
  const offer = state.pendingOffer
  try {
    const friend = state.friends.find(item => item.id === friendId)
    showCall(friend, '正在接通…')
    els.answerCallBtn.hidden = true
    const stream = await getMicrophone(generation)
    if (!isCurrentCall(generation, callId)) return
    const connection = createPeerConnection(friendId, generation, callId)
    stream.getTracks().forEach(track => connection.addTrack(track, stream))
    await connection.setRemoteDescription(offer)
    if (!isCurrentCall(generation, callId)) return
    const queuedCandidates = state.pendingCandidates.splice(0)
    for (const candidate of queuedCandidates) await connection.addIceCandidate(candidate).catch(() => {})
    const answer = await connection.createAnswer()
    if (!isCurrentCall(generation, callId)) return
    await connection.setLocalDescription(answer)
    if (!isCurrentCall(generation, callId)) return
    sendSignal('call-answer', { callId, description: answer })
    state.pendingOffer = null
  } catch (error) {
    if (!isCurrentCall(generation, callId)) return
    if (error.name !== 'AbortError') showToast('接听失败')
    hangUpCall(true)
  }
}

async function handleSignal(message) {
  const friend = state.friends.find(item => item.id === message.fromUserId)
  if (!friend || !message.payload || typeof message.payload.callId !== 'string') return
  const callId = message.payload.callId
  if (message.kind === 'call-offer') {
    if (!els.callOverlay.hidden) return sendSignal('call-end', { callId }, message.fromUserId)
    state.callGeneration++
    state.callId = callId
    state.callFriendId = message.fromUserId
    state.pendingOffer = message.payload.description
    state.pendingCandidates = []
    showCall(friend, '邀请你语音通话')
    els.answerCallBtn.hidden = false
    return
  }
  if (message.fromUserId !== state.callFriendId || callId !== state.callId) return
  const generation = state.callGeneration
  if (message.kind === 'call-answer' && state.peerConnection) {
    await state.peerConnection.setRemoteDescription(message.payload.description)
    if (!isCurrentCall(generation, callId)) return
    const queuedCandidates = state.pendingCandidates.splice(0)
    for (const candidate of queuedCandidates) await state.peerConnection.addIceCandidate(candidate).catch(() => {})
    return
  }
  if (message.kind === 'ice-candidate') {
    const candidate = message.payload.candidate
    if (state.peerConnection && state.peerConnection.remoteDescription) await state.peerConnection.addIceCandidate(candidate).catch(() => {})
    else state.pendingCandidates.push(candidate)
    return
  }
  if (message.kind === 'call-end') hangUpCall(false)
}

function toggleMute() {
  if (!state.localStream) return
  state.muted = !state.muted
  state.localStream.getAudioTracks().forEach(track => { track.enabled = !state.muted })
  els.muteCallBtn.textContent = state.muted ? '取消静音' : '静音'
}

function hangUpCall(notify = true) {
  const targetUserId = state.callFriendId
  const callId = state.callId
  if (notify && targetUserId && callId) sendSignal('call-end', { callId }, targetUserId)
  state.callGeneration++
  const connection = state.peerConnection
  const localStream = state.localStream
  state.peerConnection = null
  state.localStream = null
  state.remoteStream = null
  state.pendingOffer = null
  state.pendingCandidates = []
  state.callFriendId = null
  state.callId = ''
  state.muted = false
  if (connection) connection.close()
  if (localStream) localStream.getTracks().forEach(track => track.stop())
  els.muteCallBtn.textContent = '静音'
  els.remoteAudio.srcObject = null
  els.callOverlay.hidden = true
  els.answerCallBtn.hidden = true
}

els.showLogin.addEventListener('click', () => switchAuth('login'))
els.showRegister.addEventListener('click', () => switchAuth('register'))
els.loginForm.addEventListener('submit', async event => {
  event.preventDefault()
  try { await login(els.loginUsername.value, els.loginPassword.value) }
  catch (error) { els.authError.textContent = error.message }
})
els.registerForm.addEventListener('submit', async event => {
  event.preventDefault()
  try {
    await api('/api/register', { method: 'POST', body: JSON.stringify({ username: els.registerUsername.value, password: els.registerPassword.value }) })
    els.loginUsername.value = els.registerUsername.value
    els.loginPassword.value = ''
    switchAuth('login')
    els.authError.textContent = '注册成功，请登录'
  } catch (error) { els.authError.textContent = error.message }
})
els.logoutBtn.addEventListener('click', logout)
els.refreshBtn.addEventListener('click', refreshSocialData)
els.chatNav.addEventListener('click', () => showList('friends'))
els.friendsNav.addEventListener('click', () => showList('friends'))
els.requestsNav.addEventListener('click', () => showList('requests'))
els.addFriendNav.addEventListener('click', () => { showList('search'); els.friendSearch.focus() })
els.searchFriendBtn.addEventListener('click', searchUsers)
els.friendSearch.addEventListener('keydown', event => { if (event.key === 'Enter') searchUsers() })
els.sendBtn.addEventListener('click', sendTextMessage)
els.messageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendTextMessage() }
})
els.imageInput.addEventListener('change', () => {
  const file = els.imageInput.files[0]
  els.imageInput.value = ''
  sendImage(file)
})
els.voiceCallBtn.addEventListener('click', startVoiceCall)
els.answerCallBtn.addEventListener('click', answerIncomingCall)
els.muteCallBtn.addEventListener('click', toggleMute)
els.hangupCallBtn.addEventListener('click', () => hangUpCall(true))
document.querySelector('.chat-header').addEventListener('click', event => {
  if (window.innerWidth <= 720 && event.clientX < 70) document.querySelector('.chat-pane').classList.remove('mobile-open')
})
window.addEventListener('beforeunload', () => hangUpCall(false))

restoreSession()
