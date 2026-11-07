import type { ChatConversation, Content, Record as ChatRecord } from '@adp/model/chat-v2'
import { wsChat, wsStop, type WsTokenResult } from './wsTransport'

export interface AppConfig {
  name: string
  avatar: string
  greeting: string
  questions: string[]
  /** sse：云函数转发（单次回复受云函数超时限制）；ws：浏览器直连 ADP WebSocket */
  transport?: 'sse' | 'ws'
  /** sse 方式下单次回复的时长上限（秒） */
  maxSeconds?: number
  /** site：历史存站点数据库；adp：会话与历史直接查 ADP（ws 方式），前端不再提交存档 */
  history?: 'site' | 'adp'
  /** 方式二：每个访客一份 ADP 用户态 Agent，可选模型 / 技能 / 工具 */
  userAgent?: boolean
  /** userAgent 开启时的应用 ID（官方组件拉取 Agent 详情、模型列表用） */
  appId?: string
  /** 应用所在空间 ID（技能、连接器、工具市场按空间查询） */
  spaceId?: string
}

export interface UploadResult {
  url: string
  name: string
  size: number
  type: string
}

/** 与站点后端 /api/chat 通信；身份放在请求头里（匿名访客 ID 或宿主签发的用户凭证） */
export class ChatApi {
  constructor(
    public readonly base: string,
    private visitorId: string,
    private getUserToken?: () => string | Promise<string> | undefined,
    private language = 'zh-CN',
  ) {}

  private configPromise: Promise<AppConfig> | null = null

  async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'X-ADP-Visitor': this.visitorId, ...extra }
    const token = await this.getUserToken?.()
    if (token) h['X-ADP-User-Token'] = token
    return h
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: await this.headers((init.headers as Record<string, string>) || {}),
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const body = await res.json()
        msg = body.detail || body.message || msg
      } catch { /* 非 JSON */ }
      throw new Error(msg)
    }
    return res.json()
  }

  config() {
    this.configPromise ||= this.json<AppConfig>('/config').catch((e) => {
      this.configPromise = null
      throw e
    })
    return this.configPromise
  }

  async conversations() {
    return (await this.json<{ conversations: ChatConversation[] }>('/conversations')).conversations
  }

  async records(id: string) {
    return (await this.json<{ records: ChatRecord[] }>(`/conversations/${encodeURIComponent(id)}/records`)).records
  }

  deleteConversation(id: string) {
    return this.json(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  upload(file: File) {
    return this.json<UploadResult>(`/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
  }

  /** 停止一条仍在后台生成的回复（仅 ws 方式可用） */
  async stopRemote(conversationId: string, recordId: string) {
    const cfg = await this.config().catch(() => null)
    if (cfg?.transport !== 'ws') return false
    await wsStop({
      getToken: (b) => this.json<WsTokenResult>('/ws/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
      }),
      language: this.language,
    }, conversationId, recordId)
    return true
  }

  async chat(body: { ConversationId?: string; Contents: Content[] }, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const cfg = await this.config().catch(() => null)
    if (cfg?.transport === 'ws') {
      return wsChat({
        getToken: (b) => this.json<WsTokenResult>('/ws/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
        }),
        saveTurn: async (id, turn) => {
          if (cfg.history === 'adp') return
          const payload = JSON.stringify(turn)
          // keepalive 让关页面时也能发出，但浏览器限制其请求体约 64KB，大记录走普通请求
          await this.json(`/conversations/${encodeURIComponent(id)}/turn`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: payload.length < 60000,
          })
        },
        language: this.language,
      }, body, signal)
    }
    const res = await fetch(this.base + '/chat', {
      method: 'POST',
      headers: await this.headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`
      try {
        const b = await res.json()
        msg = b.detail || b.message || msg
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    const reader = res.body.getReader()
    return (async function* () {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        if (value) yield value
      }
    })()
  }

  /** 预览需要读取文本内容的文件（HTML / Markdown / 代码）时，经后端中转避免跨域 */
  proxied(url: string) {
    return `${this.base}/file?url=${encodeURIComponent(url)}`
  }
}
