/**
 * SDK 核心（按需由 adp-chat.js 加载）：在 Shadow DOM 内挂载对话界面。
 * 样式由 loader 以 <link> 注入同一个 shadow root，不影响宿主页面。
 */
import 'tdesign-vue-next/es/style/index.css'
import '@tdesign-vue-next/chat/es/style/index.css'
import '@adp/style.css'
import '@adp/styles/theme.css'
import { createApp, h, ref } from 'vue'
import ChatApp from './ChatApp.vue'
// 官方图标组件把 SVG sprite 插到 document.body，Shadow DOM 里的 <use href="#id"> 引用不到，这里在 shadow 内再放一份
import spriteUrl from '@adp/assets/icons/remote/iconfont.svg?url'
import { ChatApi } from './api'
import { configureAxios, setRequestInterceptor } from '@adp/service/httpService'

let axiosIdentity = false
let currentApi: ChatApi | null = null

export interface CoreOptions {
  apiBase: string
  visitorId: string
  mode: 'inline' | 'bubble'
  getUserToken?: () => string | Promise<string> | undefined
  title?: string
  avatar?: string
  greeting?: string
  questions?: string[]
  theme?: 'light' | 'dark'
  language?: string
  history?: boolean
  resume?: boolean
  onClose?: () => void
}

/** 弹层（提示、确认框、tooltip）挂到当前交互实例的 shadow 内，见 vite 配置中对 getAttach 的处理 */
function trackPopupRoot(host: HTMLElement, popupRoot: HTMLElement) {
  const g = globalThis as unknown as { __ADP_POPUP_ROOT__?: HTMLElement }
  g.__ADP_POPUP_ROOT__ = popupRoot
  const activate = () => { g.__ADP_POPUP_ROOT__ = popupRoot }
  host.addEventListener('pointerdown', activate, true)
  host.addEventListener('focusin', activate, true)
  host.addEventListener('keydown', activate, true)
}

let spriteText: Promise<string> | null = null
function injectSprite(root: Node) {
  spriteText ||= fetch(spriteUrl).then((r) => r.text()).catch(() => '')
  spriteText.then((svg) => {
    if (!svg) return
    const box = document.createElement('div')
    box.style.display = 'none'
    box.innerHTML = svg
    ;(root as ShadowRoot).appendChild(box)
  })
}

/**
 * 官方组件用 document 上的 click 监听做「点击外部关闭」（如输入框左下角 + 菜单），
 * 但事件冒泡出 Shadow DOM 后 target 被改成宿主元素，contains 判断失败，菜单一打开就被关掉。
 * 发生在这些弹出区域内的点击不再冒泡到 document。
 */
const CLICK_INSIDE = ['.plus-menu-wrapper', '.at-mention-panel', '.mention-panel']
function keepClicksInside(container: HTMLElement) {
  container.addEventListener('click', (e) => {
    const path = e.composedPath()
    if (path.some((n) => n instanceof Element && CLICK_INSIDE.some((sel) => n.matches(sel)))) e.stopPropagation()
  })
}

export function mountCore(container: HTMLElement, host: HTMLElement, popupRoot: HTMLElement, opts: CoreOptions) {
  trackPopupRoot(host, popupRoot)
  injectSprite(container.getRootNode())
  keepClicksInside(container)
  const api = new ChatApi(opts.apiBase, opts.visitorId, opts.getUserToken, opts.language || 'zh-CN')
  // 官方组件内部少量请求走自带 axios（如输入框快捷指令）：指向站点后端、跨域不带 Cookie
  configureAxios({ baseURL: opts.apiBase, withCredentials: false })
  // 官方组件的模型 / 技能 / 工具等请求也带上访客身份，后端据此找到该访客自己的 Agent
  if (!axiosIdentity) {
    axiosIdentity = true
    setRequestInterceptor(async (config: any) => {
      const h = await currentApi?.headers()
      config.headers = { ...(config.headers || {}), ...(h || {}) }
      return config
    })
  }
  currentApi = api
  const appRef = ref<InstanceType<typeof ChatApp> | null>(null)
  const app = createApp({
    setup() {
      return () => h(ChatApp, {
        ref: appRef,
        api,
        mode: opts.mode,
        title: opts.title,
        avatar: opts.avatar,
        greeting: opts.greeting,
        questions: opts.questions,
        theme: opts.theme || 'light',
        language: opts.language || 'zh-CN',
        history: opts.history !== false,
        resume: opts.resume !== false,
        closable: opts.mode === 'bubble',
        onClose: () => opts.onClose?.(),
      })
    },
  })
  app.mount(container)
  return {
    newChat: () => appRef.value?.newChat(),
    send: (text: string) => appRef.value?.send(text),
    unmount: () => app.unmount(),
  }
}
