<script setup lang="ts">
// SDK 主界面：整块复用官方 Chat/Index.vue（欢迎页 + 消息渲染 + 输入框）与 HistoryList.vue，
// 这里只负责：会话/历史/上传/预览的数据流，以及内嵌 / 气泡两种外壳。
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import Chat from '@adp/components/Chat/Index.vue'
import HistoryList from '@adp/components/HistoryList.vue'
import AIWarning from '@adp/components/AIWarning.vue'
import { applySseEventToRecord } from '@adp/utils/mergeRecord-v2'
import { fetchSSE } from '@adp/model/sseRequest-reasoning'
import { handleWidgetEvent as routeWidgetEvent } from '@adp/widget'
import type { ChatConversation, Content, Record as ChatRecord, SseEvent } from '@adp/model/chat-v2'
import type { FileProps } from '@adp/model/file'
import FileViewer from './FileViewer.vue'
import { ChatApi, type AppConfig } from './api'

export interface ChatAppProps {
  api: ChatApi
  mode: 'inline' | 'bubble'
  title?: string
  avatar?: string
  greeting?: string
  questions?: string[]
  theme?: 'light' | 'dark'
  language?: string
  /** 是否显示历史会话（默认显示） */
  history?: boolean
  closable?: boolean
}
const props = withDefaults(defineProps<ChatAppProps>(), {
  theme: 'light',
  language: 'zh-CN',
  history: true,
  closable: false,
})
const emit = defineEmits<{ (e: 'close'): void }>()

const DEFAULT_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f7cff"/><stop offset="1" stop-color="#7b5cff"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M20 38c4 6 20 6 24 0" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round"/><circle cx="24" cy="27" r="3.5" fill="#fff"/><circle cx="40" cy="27" r="3.5" fill="#fff"/></svg>')

// ------------------------------------------------------------ 应用信息
const remote = ref<AppConfig | null>(null)
/** 方式二「每个访客一份 Agent」：按 chat-client 的 Claw 模式开放模型选择、技能、工具、连接器、知识库 */
const userAgentOn = computed(() => !!(remote.value?.userAgent && remote.value?.appId))
const chatMode = computed(() => (userAgentOn.value ? 'claw' : 'standard'))
const app = computed(() => ({
  name: props.title || remote.value?.name || 'AI 助手',
  avatar: props.avatar || remote.value?.avatar || DEFAULT_AVATAR,
  greeting: props.greeting || remote.value?.greeting || '你好，有什么可以帮你？',
  questions: props.questions?.length ? props.questions : remote.value?.questions || [],
}))

// ------------------------------------------------------------ 布局
const rootRef = ref<HTMLElement | null>(null)
const width = ref(1000)
const compact = computed(() => props.mode === 'bubble' || width.value < 720)
const drawer = ref(false)
let ro: ResizeObserver | null = null
let footerRo: ResizeObserver | null = null

// ------------------------------------------------------------ 会话与消息
// 每个会话一份独立状态：切换会话、新建对话都不会中断进行中的回复，切回来继续看到输出
interface Session { records: ChatRecord[]; chatting: boolean; loaded: boolean; ctl: AbortController | null; follow: ReturnType<typeof setTimeout> | null; following: boolean }
const sessions = reactive(new Map<string, Session>())
const conversations = ref<ChatConversation[]>([])
const currentKey = ref(newKey())
const uploading = ref(false)
const loadingRecords = ref(false)
const chatRef = ref<InstanceType<typeof Chat> | null>(null)

function newKey() { return `new:${Date.now()}:${Math.random().toString(36).slice(2, 6)}` }
function isNewKey(k: string) { return k.startsWith('new:') }
function sessionOf(key: string): Session {
  let s = sessions.get(key)
  if (!s) {
    sessions.set(key, { records: [], chatting: false, loaded: isNewKey(key), ctl: null, follow: null, following: false })
    s = sessions.get(key)!
  }
  return s
}
const current = computed(() => sessionOf(currentKey.value))
/** 传给官方组件的会话 ID：新对话（还没有 ID）传空 */
const currentId = computed(() => (isNewKey(currentKey.value) ? '' : currentKey.value))
const records = computed(() => current.value.records)
const chatting = computed(() => current.value.chatting)
const chattingIds = computed(() => [...sessions.entries()].filter(([k, s]) => s.chatting && !isNewKey(k)).map(([k]) => k))

async function loadConversations() {
  if (!props.history) return
  try {
    conversations.value = await props.api.conversations()
  } catch (e) {
    console.warn('[ADPChat] 获取会话列表失败', e)
  }
}

async function selectConversation(c: ChatConversation) {
  drawer.value = false
  if (c.Id === currentKey.value) return
  currentKey.value = c.Id
  const s = sessionOf(c.Id)
  // 进行中或已加载过的会话直接展示内存里的记录，不打断、不覆盖
  if (s.chatting || s.loaded) { scrollBottom(); return }
  loadingRecords.value = true
  try {
    const list = await props.api.records(c.Id)
    if (!s.chatting) { s.records.splice(0, s.records.length, ...list); s.loaded = true; follow(c.Id, s) }
  } catch (e) {
    MessagePlugin.error('加载历史消息失败：' + (e as Error).message)
  } finally {
    if (currentKey.value === c.Id) loadingRecords.value = false
    scrollBottom()
  }
}

// ------------------------------------------------------------ 刷新后接着看进行中的回复
// 关掉 / 刷新页面后 ADP 仍在后台生成（ws 方式可从 ADP 查到「处理中」的记录）：
// 打开这类会话时显示为输出中，定时拉取最新进度，直到回复结束
const FOLLOW_INTERVAL = 3000
function lastAssistant(list: ChatRecord[]) {
  const last = list[list.length - 1]
  return last && last.Role === 'assistant' ? last : undefined
}
/** 刚发出、ADP 还没开始写回复的提问：只等这么久，超过视为未开始 */
const PENDING_MS = 120000
function pending(list: ChatRecord[]) {
  const last = list[list.length - 1]
  if (!last || last.Role !== 'user') return false
  const t = Number((last as any).ExtraInfo?.StartTime || 0)
  return t > 0 && Date.now() - t < PENDING_MS
}
function inProgress(list: ChatRecord[]) {
  return lastAssistant(list)?.Status === 'processing' || pending(list)
}
/** 末尾只有提问时补一个「处理中」的回复占位，界面显示思考中 */
function withPlaceholder(list: ChatRecord[]) {
  if (!pending(list)) return list
  const last = list[list.length - 1]!
  return [...list, { Role: 'assistant', RecordId: 'pending-' + last.RecordId, ConversationId: last.ConversationId,
    Status: 'processing', StatusDesc: '', Messages: [] } as ChatRecord]
}
function follow(id: string, s: Session) {
  if (!inProgress(s.records)) return
  if (pending(s.records)) s.records.splice(0, s.records.length, ...withPlaceholder(s.records))
  s.chatting = true
  s.following = true
  const tick = async () => {
    s.follow = null
    if (sessions.get(id) !== s || s.ctl) return
    try {
      const list = await props.api.records(id)
      if (sessions.get(id) !== s || s.ctl) return
      s.records.splice(0, s.records.length, ...withPlaceholder(list))
      if (currentKey.value === id) scrollBottom()
      if (!inProgress(list)) { s.chatting = false; s.following = false; return }
    } catch (e) {
      console.warn('[ADPChat] 刷新进度失败', e)
    }
    s.follow = setTimeout(tick, FOLLOW_INTERVAL)
  }
  s.follow = setTimeout(tick, FOLLOW_INTERVAL)
}

function newChat() {
  // 当前就是空白新对话时不重复创建
  if (!(isNewKey(currentKey.value) && !current.value.records.length)) currentKey.value = newKey()
  loadingRecords.value = false
  viewer.value = null
  drawer.value = false
}

function deleteConversation(c: ChatConversation) {
  const dialog = DialogPlugin.confirm({
    header: '删除会话',
    body: `确定删除「${c.Title}」吗？删除后无法恢复。`,
    confirmBtn: { content: '删除', theme: 'danger' },
    onConfirm: async () => {
      dialog.destroy()
      try {
        const s = sessions.get(c.Id)
        s?.ctl?.abort()
        if (s?.follow) clearTimeout(s.follow)
        await props.api.deleteConversation(c.Id)
        conversations.value = conversations.value.filter((x) => x.Id !== c.Id)
        sessions.delete(c.Id)
        if (currentKey.value === c.Id) newChat()
      } catch (e) {
        MessagePlugin.error('删除失败：' + (e as Error).message)
      }
    },
  })
}

function scrollBottom() {
  nextTick(() => chatRef.value?.backToBottom?.())
}

function upsert(list: ChatRecord[], next: ChatRecord, placeholderId: string) {
  let idx = list.findIndex((r) => r.RecordId === next.RecordId)
  if (idx === -1) idx = list.findIndex((r) => r.RecordId === placeholderId)
  if (idx === -1) list.push(next)
  else list.splice(idx, 1, next)
}

async function send(query: string, fileList: FileProps[] = []) {
  query = (query || '').trim()
  const files = fileList.filter((f) => f.status === 'done' && f.url)
  const s = current.value
  if ((!query && !files.length) || s.chatting) return
  const contents: Content[] = []
  if (query) contents.push({ Type: 'text', Text: query })
  // Claw 模式下输入框已把附件写成 [文件名](地址) 拼进文本（与 chat-client 一致），不再重复附带
  for (const f of chatMode.value === 'claw' ? [] : files) {
    contents.push({
      Type: 'file',
      // chat/v2 要求 FileSize 为字节数（纯数字字符串）
      File: { DocId: f.docId || '0', FileName: f.name || '', FileUrl: f.url, FileSize: String(f.size || 0), FileType: (f.name || '').split('.').pop() || '' },
    } as Content)
  }
  return sendContents(contents)
}

/** 发送一轮内容（文字 / 附件 / widget 交互），流式接收回复 */
async function sendContents(contents: Content[]) {
  const s = current.value
  if (!contents.length || s.chatting) return

  // key 会在新会话拿到 ID 后变化，回调里统一通过 sess 引用操作，不依赖当前展示的是哪个会话
  let key = currentKey.value
  const sess = s
  const list = sess.records
  const ts = Date.now()
  list.push(
    {
      Role: 'user', RecordId: 'placeholder-user', ConversationId: currentId.value, Status: 'success', StatusDesc: '',
      Messages: [{ Type: 'question', MessageId: `pu-${ts}`, Name: 'question', Title: '', Status: 'success', StatusDesc: '', Contents: contents }],
    } as ChatRecord,
    { Role: 'assistant', RecordId: 'placeholder-agent', ConversationId: currentId.value, Status: 'processing', StatusDesc: '', Messages: [] } as ChatRecord,
  )
  sess.chatting = true
  sess.loaded = true
  scrollBottom()

  const ctl = new AbortController()
  sess.ctl = ctl
  const visible = () => currentKey.value === key
  await fetchSSE(
    () => props.api.chat({ ConversationId: isNewKey(key) ? undefined : key, Contents: contents }, ctl.signal),
    {
      success(event: SseEvent) {
        const e = event as SseEvent & { Type: string; Conversation?: ChatConversation }
        if (e.Type === 'adp.conversation' && e.Conversation) {
          const id = e.Conversation.Id
          if (isNewKey(key)) {
            // 新会话拿到 ID：把这份状态挂到真实 ID 下；用户仍停留在该会话时同步切换
            const wasVisible = visible()
            sessions.delete(key)
            sessions.set(id, sess)
            key = id
            if (wasVisible) currentKey.value = id
          }
          conversations.value = [e.Conversation, ...conversations.value.filter((c) => c.Id !== id)]
          return
        }
        if (event.Type === 'request_ack') {
          const base = list.find((r) => r.RecordId === 'placeholder-user')
          const next = applySseEventToRecord(event, base)
          if (next) upsert(list, { ...next, Messages: next.Messages?.length ? next.Messages : base?.Messages }, 'placeholder-user')
        } else {
          const last = list[list.length - 1]
          const next = applySseEventToRecord(event, last && last.Role === 'assistant' ? last : undefined)
          if (next) upsert(list, next, 'placeholder-agent')
        }
        if (visible()) scrollBottom()
      },
      fail(msg) {
        if (ctl.signal.aborted) return
        const text = typeof msg === 'string' && msg ? msg : (msg as Error)?.message || '发送失败，请重试'
        // 在助手位置直接显示错误，避免只弹一下提示、界面上留下空白回复
        const last = list[list.length - 1]
        if (last && last.Role === 'assistant' && !(last.Messages || []).some((m) => m.Type === 'reply' && m.Contents?.length)) {
          list.splice(list.length - 1, 1, {
            ...last, Status: 'failed',
            Messages: [...(last.Messages || []), { Type: 'reply', MessageId: `err-${Date.now()}`, Name: 'reply', Title: '', Status: 'failed', StatusDesc: '',
              Contents: [{ Type: 'text', Text: `⚠️ 回复失败：${text}` }] }],
          } as ChatRecord)
        } else if (visible()) {
          MessagePlugin.error(text)
        }
      },
      complete() {
        sess.chatting = false
        if (sess.ctl === ctl) sess.ctl = null
        const last = list[list.length - 1]
        if (last && last.Role === 'assistant') {
          // 补上回复时间与运行时长（操作栏时间、「已处理 XX 秒」用）
          const extra = { ...((last as any).ExtraInfo || {}) }
          if (!extra.StartTime) extra.StartTime = String(ts)
          if (!Number(extra.Elapsed)) extra.Elapsed = String(Date.now() - ts)
          const status = last.Status === 'processing' ? (ctl.signal.aborted ? 'stop' : 'success') : last.Status
          list.splice(list.length - 1, 1, { ...last, Status: status, ExtraInfo: extra } as ChatRecord)
        }
        const conv = conversations.value.find((c) => c.Id === key)
        if (conv) conv.LastActiveAt = Math.floor(Date.now() / 1000)
      },
    },
  )
}

/** 停止当前展示会话的回复（其他会话的回复不受影响） */
function stop() {
  const s = current.value
  if (!s.ctl && s.following) {
    // 刷新后接着看的回复：没有原连接，通知 ADP 停止，进度轮询会拿到最终状态
    const rec = lastAssistant(s.records)
    if (rec?.RecordId && currentId.value) {
      props.api.stopRemote(currentId.value, rec.RecordId).catch((e) => console.warn('[ADPChat] 停止失败', e))
    }
    return
  }
  s.ctl?.abort()
  s.ctl = null
  s.chatting = false
}

// ------------------------------------------------------------ Widget 交互
// 官方在 layout/Index.vue 里处理，SDK 只用了对话组件，这里按同样规则接上：
//   sys.go_to_url / sys.download：浏览器本地处理
//   sys.chat / sys.clarify：作为 widget_action 内容发给 Agent，并禁用这条回复里的 widget，防止重复提交
function disableWidgets(recordId: string) {
  // 官方 disableWidgetsByRecordId 查 document，Shadow DOM 里找不到，这里在组件根节点内查
  const root = rootRef.value
  if (!root || !recordId) return
  root.querySelectorAll(`.adp-widget-wrapper[data-record-id="${CSS.escape(recordId)}"] adp-widget`)
    .forEach((el) => el.setAttribute('disable', 'true'))
}

async function onWidgetEvent(event: CustomEvent, widgetRunId: string, widgetId: string, recordId: string) {
  const result = routeWidgetEvent(event, widgetRunId, widgetId)
  if (result.handled || !result.widgetActionRequest) {
    if (!result.handled && result.actionType) console.warn('[ADPChat] 未支持的 widget 事件', result.actionType)
    return
  }
  if (current.value.chatting) {
    MessagePlugin.warning('正在回复中，请稍后再试')
    return
  }
  disableWidgets(recordId)
  await sendContents([{ Type: 'widget_action', WidgetAction: result.widgetActionRequest } as unknown as Content])
}

// ------------------------------------------------------------ 上传
async function uploadFiles(files: File[]) {
  const sender = chatRef.value?.getSenderRef?.()
  uploading.value = true
  for (const file of files) {
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    sender?.addFile({ uid, name: file.name, url: '', size: file.size, type: file.type,
      category: file.type.startsWith('image/') ? 'image' : 'document', status: 'uploading' })
    try {
      const res = await props.api.upload(file)
      sender?.updateFile(uid, { url: res.url, status: 'done' })
    } catch (e) {
      sender?.removeFile(uid)
      MessagePlugin.error(`「${file.name}」上传失败：${(e as Error).message}`)
    }
  }
  uploading.value = false
}

// ------------------------------------------------------------ 文件预览
const viewer = ref<{ url: string; name: string } | null>(null)

function findFile(name: string) {
  for (const r of [...records.value].reverse()) {
    for (const m of r.Messages || []) {
      for (const c of (m.Contents || []) as any[]) {
        const files = [c?.File, ...(c?.Files || [])].filter(Boolean)
        const hit = files.find((f: any) => (f.FileName || '') === name && (f.FileUrl || f.Url))
        if (hit) return { url: hit.FileUrl || hit.Url, name }
      }
    }
  }
  return null
}

// Agent 回复里的文件卡片会调用 viewFile(路径)
provide('viewFile', (path: string) => {
  const name = decodeURIComponent((path || '').split('/').pop() || '')
  const hit = findFile(name)
  if (hit) viewer.value = hit
  else MessagePlugin.info('该文件在 Agent 工作区内，暂不支持预览')
})

// 用户消息里的附件卡片：官方组件只支持图片新窗口打开，这里统一改成面板预览
function onClickCapture(e: MouseEvent) {
  const card = (e.target as HTMLElement)?.closest?.('.msg-file-card')
  if (!card) return
  const name = card.querySelector('.msg-file-name')?.getAttribute('title') || ''
  const hit = name && findFile(name)
  if (hit) {
    e.stopPropagation()
    e.preventDefault()
    viewer.value = hit
  }
}

// ------------------------------------------------------------ 生命周期
onMounted(async () => {
  const root = rootRef.value!
  ro = new ResizeObserver(([entry]) => (width.value = entry.contentRect.width))
  ro.observe(root)
  // 官方组件用 document.querySelector 量输入区高度，在 Shadow DOM 里查不到，这里补上
  nextTick(() => {
    const footer = root.querySelector('.t-chat__footer') as HTMLElement | null
    if (footer) {
      footerRo = new ResizeObserver(() => root.style.setProperty('--chat-footer-height', `${footer.offsetHeight + 60}px`))
      footerRo.observe(footer)
    }
  })
  props.api.config().then((c) => (remote.value = c)).catch((e) => console.warn('[ADPChat] 获取应用信息失败', e))
  loadConversations()
})

onBeforeUnmount(() => {
  sessions.forEach((x) => { x.ctl?.abort(); if (x.follow) clearTimeout(x.follow) })
  ro?.disconnect()
  footerRo?.disconnect()
})

watch(compact, (v) => { if (!v) drawer.value = false })

defineExpose({ newChat, send: (text: string) => send(text) })
</script>

<template>
  <div ref="rootRef" class="adp-app" :class="[`is-${mode}`, { 'is-compact': compact }]" @click.capture="onClickCapture">
    <!-- 宽屏内嵌：左侧历史栏 -->
    <aside v-if="history && !compact" class="adp-side">
      <div class="adp-brand"><img :src="app.avatar" alt="" /><span>{{ app.name }}</span></div>
      <button class="adp-new" @click="newChat"><span>＋</span> 新对话</button>
      <div class="adp-side-list">
        <HistoryList :conversations="conversations" :currentConversationId="currentId" :chattingConversationIds="chattingIds" :language="language"
          @select="selectConversation" @delete="deleteConversation" />
        <div v-if="!conversations.length" class="adp-side-empty">暂无历史会话</div>
      </div>
    </aside>

    <section class="adp-main">
      <!-- 窄屏 / 气泡：顶栏 -->
      <header v-if="compact" class="adp-head">
        <button v-if="history" class="adp-icon" title="历史会话" @click="drawer = !drawer">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
        </button>
        <img :src="app.avatar" alt="" /><span class="adp-head-title">{{ app.name }}</span>
        <button class="adp-icon" title="新对话" @click="newChat">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
        </button>
        <button v-if="closable" class="adp-icon" title="关闭" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
        </button>
      </header>

      <div class="adp-chat">
        <Chat
          ref="chatRef"
          :chatId="currentId"
          :chatList="records"
          :isChatting="chatting"
          :isUploading="uploading"
          :currentApplicationAvatar="app.avatar"
          :currentApplicationName="app.name"
          :currentApplicationGreeting="app.greeting"
          :currentApplicationOpeningQuestions="app.questions"
          :enableVoiceInput="false"
          :language="language"
          :theme="theme"
          :mode="chatMode"
          :currentApplicationId="userAgentOn ? remote?.appId : ''"
          :enableModelSelector="userAgentOn"
          :enableSkills="userAgentOn"
          :enableTools="userAgentOn"
          :enableConnector="userAgentOn"
          :enableKnowledge="userAgentOn"
          :skillsSpaceId="remote?.spaceId || 'default_space'"
          suggestionApi="/suggestions"
          @send="(q: string, files: FileProps[]) => send(q, files)"
          @stop="stop"
          @uploadFile="uploadFiles"
          @widgetEvent="onWidgetEvent"
          @loadMore="() => chatRef?.notifyComplete?.()"
        />
        <div v-if="loadingRecords" class="adp-loading">正在加载历史消息…</div>
      </div>
      <AIWarning :language="language" />

      <!-- 窄屏历史抽屉 -->
      <transition name="adp-fade">
        <div v-if="compact && drawer" class="adp-mask" @click="drawer = false">
          <div class="adp-drawer" @click.stop>
            <button class="adp-new" @click="newChat"><span>＋</span> 新对话</button>
            <HistoryList :conversations="conversations" :currentConversationId="currentId" :chattingConversationIds="chattingIds" :language="language"
              @select="selectConversation" @delete="deleteConversation" />
            <div v-if="!conversations.length" class="adp-side-empty">暂无历史会话</div>
          </div>
        </div>
      </transition>
    </section>

    <!-- 文件预览：宽屏在右侧，窄屏覆盖 -->
    <aside v-if="viewer" class="adp-viewer">
      <FileViewer :url="viewer.url" :name="viewer.name" :proxied="(u: string) => api.proxied(u)" @close="viewer = null" />
    </aside>
  </div>
</template>

<style scoped>
.adp-app { position: relative; display: flex; width: 100%; height: 100%; overflow: hidden; background: var(--td-bg-color-container); color: var(--td-text-color-primary); font-family: var(--adp-font-family, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', 'Microsoft YaHei', sans-serif); font-size: 14px; border-radius: var(--adp-radius, 0); }
.adp-side { width: var(--adp-sidebar-width, 248px); flex: none; display: flex; flex-direction: column; gap: 8px; padding: 14px 10px 10px; background: var(--adp-sidebar-bg, var(--td-bg-color-secondarycontainer)); border-right: 1px solid var(--td-component-stroke); min-height: 0; }
.adp-brand { display: flex; align-items: center; gap: 8px; padding: 2px 6px 8px; font-weight: 600; font-size: 15px; }
.adp-brand img, .adp-head img { width: 26px; height: 26px; border-radius: 8px; object-fit: cover; flex: none; }
.adp-brand span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adp-new { height: 34px; flex: none; display: flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid var(--td-component-stroke); border-radius: 8px; background: var(--td-bg-color-container); cursor: pointer; font-size: 13px; color: var(--td-text-color-primary); }
.adp-new:hover { border-color: var(--td-brand-color); color: var(--td-brand-color); }
.adp-side-list { flex: 1; min-height: 0; overflow-y: auto; }
.adp-side-empty { padding: 24px 8px; text-align: center; color: var(--td-text-color-placeholder); font-size: 12px; }
.adp-main { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; padding-bottom: 4px; }
.adp-chat { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.adp-chat > :first-child { flex: 1; min-height: 0; }
.adp-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--td-bg-color-container); color: var(--td-text-color-secondary); font-size: 13px; }
.adp-head { height: 52px; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 8px; border-bottom: 1px solid var(--td-component-stroke); font-weight: 600; font-size: 15px; }
.adp-head-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: 2px; }
.adp-icon { width: 32px; height: 32px; padding: 0; flex: none; display: inline-flex; align-items: center; justify-content: center; border: none; background: transparent; border-radius: 8px; cursor: pointer; color: var(--td-text-color-secondary); }
.adp-icon svg { flex: none; width: 18px; height: 18px; }
.adp-icon:hover { background: var(--td-bg-color-container-hover); color: var(--td-text-color-primary); }
.adp-mask { position: absolute; inset: 52px 0 0 0; z-index: 20; background: rgba(0, 0, 0, .18); }
.adp-drawer { position: absolute; inset: 0 auto 0 0; width: min(280px, 80%); display: flex; flex-direction: column; gap: 8px; padding: 12px 10px; background: var(--td-bg-color-container); box-shadow: 8px 0 24px rgba(0, 0, 0, .08); overflow-y: auto; }
.adp-viewer { width: min(46%, 640px); flex: none; border-left: 1px solid var(--td-component-stroke); min-height: 0; }
.is-compact .adp-viewer { position: absolute; inset: 0; width: auto; z-index: 30; border: none; }
.adp-fade-enter-active, .adp-fade-leave-active { transition: opacity .15s; }
.adp-fade-enter-from, .adp-fade-leave-to { opacity: 0; }
:deep(.msg-file-card) { cursor: pointer; }
/* 欢迎页：欢迎语与示例问题字号与输入框、正文一致（14px） */
:deep(.greet-desc) { font-size: 14px; line-height: 22px; }
:deep(.greet-question) { font-size: 14px; line-height: 22px; padding: 9px 14px; }
:deep(.greet-questions) { gap: 8px; margin-top: 24px; }
/* 消息操作栏图标：16px 图形 + 24px 点击区 */
:deep(.actions-container .control-icon) { width: 24px !important; height: 24px !important; padding: 4px; box-sizing: border-box; }
/* 会话列表：单行紧凑高度 */
:deep(.history-item) { min-height: 32px; padding: 6px 10px; margin-bottom: 2px; font-size: 14px; line-height: 20px; box-sizing: border-box; }
:deep(.history-header) { margin-bottom: 2px; }
/* 工具调用后的「查看」按钮去掉 */
:deep(.tool-call-item__view-btn) { display: none !important; }
/* 会话列表删除按钮：官方用 TDesign 在线图标（sprite 插在 document 里，Shadow DOM 内引用不到），这里换成内置图标 */
:deep(.history-delete .t-icon) { display: none; }
:deep(.history-delete)::before { content: ''; width: 14px; height: 14px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M4%207h16%27/%3E%3Cpath%20d%3D%27M10%2011v6M14%2011v6%27/%3E%3Cpath%20d%3D%27M6%207l1%2013h10l1-13%27/%3E%3Cpath%20d%3D%27M9%207V4h6v3%27/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M4%207h16%27/%3E%3Cpath%20d%3D%27M10%2011v6M14%2011v6%27/%3E%3Cpath%20d%3D%27M6%207l1%2013h10l1-13%27/%3E%3Cpath%20d%3D%27M9%207V4h6v3%27/%3E%3C/svg%3E") center / contain no-repeat; }
/* 消息操作栏只保留：复制、AI 生成说明；分享、点赞点踩、重新生成隐藏 */
:deep(.actions-container .share-icon),
:deep(.actions-container .control-icon:has(use[href$="basic_forward_line"])),
:deep(.actions-container .control-icon:has(use[href$="basic_refresh_line"])),
:deep(.actions-container .control-icon:has(use[href*="basic_thumbsup"])),
:deep(.actions-container .control-icon:has(use[href*="basic_thumbsdown"])) { display: none !important; }

/* ================================================================
 * 执行过程展示：对齐 ADP 智能工作台（smart-webim）视觉 V2
 *   - 折叠标题 14px 浅灰，箭头在文字之后、hover / 展开时才出现，无 hover 灰底
 *   - 进行中标题流光；展开区不缩进
 *   - 工具行扁平（无底色 / 边框）：图标 + 操作名 + 对象，箭头紧跟其后
 *   - 搜索 / 抓取结果：展开后为浅灰小字正文；通用工具 / 命令：浅灰底消息盒
 * 只覆盖样式，不改官方组件
 * ================================================================ */
.adp-app { --adp-caption: var(--td-text-color-placeholder); --adp-caption-hover: var(--td-text-color-secondary); }
/* 一级折叠组 */
:deep(.collapsible-group__header) { padding: 4px 0; gap: 4px; background: transparent !important; }
:deep(.collapsible-group__title) { order: 1; font-size: 14px; line-height: 20px; color: var(--adp-caption); }
:deep(.collapsible-group__arrow) { order: 2; color: var(--adp-caption); opacity: 0; transition: opacity .15s, transform .2s; }
:deep(.collapsible-group:hover > .collapsible-group__header .collapsible-group__arrow),
:deep(.collapsible-group:not(.collapsible-group--collapsed) > .collapsible-group__header .collapsible-group__arrow) { opacity: 1; }
:deep(.collapsible-group__header:hover .collapsible-group__title),
:deep(.collapsible-group__header:hover .collapsible-group__arrow) { color: var(--adp-caption-hover); }
:deep(.collapsible-group__loading-dot) { display: none; }
:deep(.collapsible-group--streaming > .collapsible-group__header .collapsible-group__title) {
  background-image: linear-gradient(100deg, var(--adp-caption) 0%, var(--adp-caption) 35%, var(--td-text-color-primary) 50%, var(--adp-caption) 65%, var(--adp-caption) 100%);
  background-size: 220% 100%; background-position: 180% 0; -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: adp-shimmer 1.6s linear infinite;
}
:deep(.collapsible-group__content) { margin-top: 4px; padding-left: 0; gap: 8px; }
:deep(.collapsible-group__thought-header) { padding: 2px 0; gap: 4px; font-family: inherit; font-size: 14px; line-height: 20px; background: transparent !important; }
:deep(.collapsible-group__thought-content) { padding: 0 0 0 20px; }
/* 工具行 */
:deep(.tool-call-item), :deep(.tool-call-item--expanded) { border: none; background: transparent; border-radius: 0; overflow: visible; }
:deep(.tool-call-item__header),
:deep(.tool-call-item--expandable .tool-call-item__header) { justify-content: flex-start; padding: 2px 0; background: transparent !important; border-radius: 0; }
:deep(.tool-call-item__header-left) { flex: 0 1 auto; gap: 4px; }
:deep(.tool-call-item__header-right) { margin-left: 4px; gap: 4px; }
:deep(.tool-call-item__icon) { color: var(--adp-caption); }
:deep(.tool-call-item__text) { gap: 4px; font-size: 14px; line-height: 20px; color: var(--adp-caption); }
:deep(.tool-call-item:has(use[href$="basic_url_line"]) .tool-call-item__text) { font-family: inherit; }
:deep(.tool-call-item--expandable .tool-call-item__header:hover .tool-call-item__text),
:deep(.tool-call-item--expandable .tool-call-item__header:hover .tool-call-item__icon),
:deep(.tool-call-item--expandable .tool-call-item__header:hover .tool-call-item__toggle-btn) { color: var(--adp-caption-hover); }
:deep(.tool-call-item__view-btn) { font-size: 14px; line-height: 20px; }
/* 箭头：收起朝右、展开朝下，收起时 hover 才显示 */
:deep(.tool-call-item__toggle-btn) { width: 16px; height: 16px; background: transparent !important; color: var(--adp-caption); opacity: 0; transition: opacity .15s; }
:deep(.tool-call-item__header:hover .tool-call-item__toggle-btn),
:deep(.tool-call-item--expanded .tool-call-item__toggle-btn) { opacity: 1; }
/* 复制按钮挪到 hover 时出现；搜索 / 抓取不提供复制（与工作台一致） */
:deep(.tool-call-item__copy-btn) { opacity: 0; transition: opacity .15s; }
:deep(.tool-call-item:hover .tool-call-item__copy-btn) { opacity: 1; }
:deep(.tool-call-item:has(use[href$="basic_url_line"]) .tool-call-item__copy-btn) { display: none; }
/* 展开内容 */
:deep(.tool-call-item__content) { border-top: none; margin-top: 4px; }
:deep(.tool-call-item__text-area) { padding: 0; max-height: 300px; font-size: 12px; line-height: 18px; color: var(--adp-caption); }
:deep(.tool-call-item__content:has(.tool-call-item__code-wrapper)) {
  padding: 8px; background: var(--td-bg-color-secondarycontainer); border: 1px solid var(--td-component-stroke); border-radius: 6px;
  font-family: Monaco, Menlo, Consolas, monospace; font-size: 12px; line-height: 16px; color: var(--td-text-color-secondary);
}
:deep(.tool-call-item__section-label) { font-size: 12px; line-height: 16px; color: var(--adp-caption); margin-bottom: 2px; }
:deep(.tool-call-item__section-body) { font-size: 12px; line-height: 16px; margin-bottom: 8px; }
:deep(.tool-call-item__code-area) { max-height: 174px; }
@keyframes adp-shimmer { from { background-position: 180% 0; } to { background-position: -80% 0; } }
@media (prefers-reduced-motion: reduce) {
  :deep(.collapsible-group--streaming > .collapsible-group__header .collapsible-group__title) { animation: none; color: var(--adp-caption); background: none; }
}
</style>
