/**
 * WebSocket 直连传输（ws 方式）：浏览器直连 ADP WebSocket，回复时长不受云函数超时限制。
 *
 * 对外与 SSE 方式完全一致：产出 `data: <事件 JSON>\n\n` 字节流，交给官方 fetchSSE 解析，
 * 渲染层（applySseEventToRecord / ChatItem）不需要知道底层换了传输方式。
 *
 * 流程：
 *   1. POST {api}/ws/token —— 云函数校验访客、登记新会话，用 SecretId/SecretKey 换一次性令牌
 *   2. 连接 ADP（Socket.IO v4 协议，手写实现，不引第三方库）：0 握手 → 40{token} 鉴权 → 40 成功
 *   3. 发送 42["request", {...}]，下行 42["<事件名>", {...}] 原样转成 SSE 行
 *   4. 收到 response.completed / error 结束；用户点停止发 stop_generation
 *   5. 结束（含停止、断线）后把本轮问答 POST {api}/conversations/{id}/turn 存档
 */
import { applySseEventToRecord } from '@adp/utils/mergeRecord-v2'
import type { Content, Record as ChatRecord, SseEvent } from '@adp/model/chat-v2'

export interface WsTokenResult {
  token: string
  url: string
  conversationId: string
  visitorId: string
  conversation: unknown | null
}

export interface WsChatDeps {
  getToken(body: { ConversationId?: string; Contents: Content[] }): Promise<WsTokenResult>
  saveTurn(conversationId: string, turn: { user?: ChatRecord; assistant?: ChatRecord; status: string }): Promise<void>
  language?: string
}

const encoder = new TextEncoder()
const sseLine = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
const abortError = () => new DOMException('The user aborted a request.', 'AbortError')

export async function* wsChat(
  deps: WsChatDeps,
  body: { ConversationId?: string; Contents: Content[] },
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const auth = await deps.getToken(body)
  if (signal.aborted) throw abortError()
  const conversationId = auth.conversationId
  if (auth.conversation) yield sseLine({ Type: 'adp.conversation', Conversation: auth.conversation })

  // ---------- 事件队列：WebSocket 回调 → 异步迭代
  const queue: Array<{ name: string; data: any } | { end: true; reason: 'done' | 'closed' | 'abort'; detail?: string }> = []
  let wake: (() => void) | null = null
  const push = (item: (typeof queue)[number]) => { queue.push(item); wake?.(); wake = null }
  const next = () => (queue.length ? Promise.resolve() : new Promise<void>((r) => (wake = r)))

  const sep = auth.url.includes('?') ? '&' : '?'
  const ws = new WebSocket(`${auth.url}${sep}language=${encodeURIComponent(deps.language || 'zh-CN')}&EIO=4&transport=websocket`)
  const requestId = uuid()
  let recordId = ''
  let finished = false
  let liveness: ReturnType<typeof setTimeout> | null = null
  let livenessMs = 60000
  const touch = () => {
    if (liveness) clearTimeout(liveness)
    liveness = setTimeout(() => { try { ws.close() } catch { /* ignore */ } }, livenessMs)
  }
  const emit = (name: string, payload: unknown) => ws.readyState === WebSocket.OPEN && ws.send('42' + JSON.stringify([name, payload]))

  ws.onmessage = (e) => {
    const m = String(e.data)
    touch()
    if (m === '2') { ws.send('3'); return }
    if (m[0] === '0') {
      try {
        const hs = JSON.parse(m.slice(1))
        livenessMs = (hs.pingInterval || 25000) + (hs.pingTimeout || 20000) + 5000
      } catch { /* 使用默认值 */ }
      ws.send('40' + JSON.stringify({ token: auth.token }))
      return
    }
    if (m.startsWith('40')) {
      emit('request', {
        Type: 'request',
        Request: { RequestId: requestId, ConversationId: conversationId, VisitorId: auth.visitorId, Contents: body.Contents, Incremental: true },
      })
      return
    }
    if (m.startsWith('44')) { push({ end: true, reason: 'closed', detail: '对话鉴权失败，请刷新后重试' }); return }
    if (m.startsWith('41')) { push({ end: true, reason: 'closed' }); return }
    if (m.startsWith('42')) {
      try {
        const [name, data] = JSON.parse(m.slice(2))
        push({ name, data })
      } catch { /* 忽略无法解析的帧 */ }
    }
  }
  ws.onclose = () => push({ end: true, reason: 'closed' })
  ws.onerror = () => push({ end: true, reason: 'closed' })
  const onAbort = () => push({ end: true, reason: 'abort' })
  signal.addEventListener('abort', onAbort)
  touch()

  // ---------- 本轮记录（用于存档）
  let user: ChatRecord | undefined = {
    Role: 'user', RecordId: `local-${requestId}`, ConversationId: conversationId, Status: 'success', StatusDesc: '',
    Messages: [{ Type: 'question', MessageId: `q-${requestId}`, Name: 'question', Title: '', Status: 'success', StatusDesc: '', Contents: body.Contents }],
  } as ChatRecord
  let bot: ChatRecord | undefined
  let status = 'success'
  let started = false

  try {
    while (true) {
      await next()
      const item = queue.shift()!
      if ('end' in item) {
        if (item.reason === 'abort') {
          status = 'stop'
          if (recordId) emit('stop_generation', { Type: 'stop_generation', StopGeneration: { RecordId: recordId } })
          throw abortError()
        }
        if (finished) return
        status = started ? 'stop' : 'failed'
        yield sseLine({
          Type: 'error',
          Error: { Code: 'Disconnected', Message: item.detail || (started ? '连接中断，已保留收到的内容' : '连接对话服务失败，请重试') },
        })
        return
      }
      const event = { ...(item.data || {}), Type: item.data?.Type || item.name } as SseEvent & { Type: string }
      if (event.Type === 'request_ack') {
        const merged = applySseEventToRecord(event, user)
        if (merged) user = { ...merged, Messages: merged.Messages?.length ? merged.Messages : user?.Messages } as ChatRecord
      } else if (event.Type !== 'error') {
        started = true
        if (event.Type === 'response.created') recordId = (event as any).Response?.RecordId || recordId
        bot = applySseEventToRecord(event, bot) || bot
      }
      yield sseLine(event)
      if (event.Type === 'error') { status = 'failed'; finished = true; return }
      if (event.Type === 'response.completed') {
        finished = true
        status = (event as any).Response?.Status === 'stop' ? 'stop' : 'success'
        return
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (liveness) clearTimeout(liveness)
    // 停止时稍等服务端收下 stop_generation 再断开
    const close = () => { try { ws.close() } catch { /* ignore */ } }
    if (status === 'stop' && recordId) setTimeout(close, 800)
    else close()
    deps.saveTurn(conversationId, { user, assistant: bot, status }).catch((e) => console.warn('[ADPChat] 保存历史失败', e))
  }
}

/**
 * 停止一条仍在后台生成的回复（刷新页面后接着看的会话，没有原来的连接）：
 * 换一个令牌建连，发送 stop_generation 后断开。
 */
export function wsStop(deps: Pick<WsChatDeps, 'getToken' | 'language'>, conversationId: string, recordId: string): Promise<void> {
  return deps.getToken({ ConversationId: conversationId, Contents: [] }).then((auth) => new Promise<void>((resolve) => {
    const sep = auth.url.includes('?') ? '&' : '?'
    const ws = new WebSocket(`${auth.url}${sep}language=${encodeURIComponent(deps.language || 'zh-CN')}&EIO=4&transport=websocket`)
    const done = () => { try { ws.close() } catch { /* ignore */ } resolve() }
    const timer = setTimeout(done, 8000)
    ws.onmessage = (e) => {
      const m = String(e.data)
      if (m === '2') { ws.send('3'); return }
      if (m[0] === '0') { ws.send('40' + JSON.stringify({ token: auth.token })); return }
      if (m.startsWith('40')) {
        ws.send('42' + JSON.stringify(['stop_generation', { Type: 'stop_generation', StopGeneration: { RecordId: recordId } }]))
        setTimeout(() => { clearTimeout(timer); done() }, 800)
      }
    }
    ws.onerror = () => { clearTimeout(timer); done() }
  }))
}
