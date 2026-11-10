/**
 * ADP Chat 嵌入 SDK 入口（adp-chat.js）：只有几 KB，不含 Vue / 组件库。
 *
 *   <script src="https://<站点域名>/api/chat/sdk/adp-chat.js"></script>
 *   <script>
 *     ADPChat.mount('#chat')   // 嵌入到指定容器
 *     ADPChat.mount()          // 右下角悬浮气泡
 *   </script>
 *
 * - 对话界面（core.js）在需要时才加载：内嵌模式立即加载，气泡模式在空闲时预取、点开时挂载。
 * - 界面渲染在 Shadow DOM 里，样式与宿主页面互不影响；可通过配置项、CSS 变量、customCss 定制外观。
 */

export interface ThemeOptions {
  /** 主色，如 '#E60012' */
  primaryColor?: string
  /** 亮色 / 暗色 */
  mode?: 'light' | 'dark'
  /** 外框圆角，如 '12px' */
  radius?: string
  fontFamily?: string
}

export interface MountOptions {
  /** 对话接口地址，默认由脚本地址推出（脚本在 <接口>/sdk/adp-chat.js），一般不用填 */
  apiBase?: string
  title?: string
  avatar?: string
  greeting?: string
  questions?: string[]
  /** 是否显示历史会话，默认 true */
  history?: boolean
  /** 打开时直接进入最近一次会话，默认 true */
  resume?: boolean
  language?: string
  theme?: ThemeOptions
  /** 注入到对话框内部的额外 CSS（兜底定制，内部 class 不保证跨版本兼容） */
  customCss?: string
  /** 实名用户：返回宿主后端签发的用户凭证；不传则按匿名访客隔离 */
  userToken?: string | (() => string | Promise<string>)
  /** 气泡模式：位置、尺寸、按钮图标、是否默认展开 */
  position?: 'right' | 'left'
  width?: number
  height?: number
  bubbleIcon?: string
  open?: boolean
}

export interface ChatInstance {
  open(): void
  close(): void
  toggle(): void
  newChat(): void
  send(text: string): void
  destroy(): void
}

type Core = typeof import('./core/index')

const script = document.currentScript as HTMLScriptElement | null
const SDK_BASE = script?.src ? new URL('./', script.src).href : new URL('./', location.href).href
declare const __ADP_CHAT_VERSION__: string
const VERSION = __ADP_CHAT_VERSION__

let corePromise: Promise<Core> | null = null
function loadCore(): Promise<Core> {
  if (!corePromise) {
    corePromise = import(/* @vite-ignore */ SDK_BASE + 'core.js?v=' + VERSION) as Promise<Core>
    corePromise.catch(() => { corePromise = null })
  }
  return corePromise
}

let fontsInjected = false
function injectFonts() {
  // @font-face 在 Shadow DOM 内不生效，只把字体声明放到宿主文档（不含任何选择器样式）
  if (fontsInjected) return
  fontsInjected = true
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = SDK_BASE + 'fonts.css?v=' + VERSION
  document.head.appendChild(link)
}

function visitorId(): string {
  const KEY = 'adp_chat_visitor'
  try {
    let id = localStorage.getItem(KEY)
    if (!id) {
      id = crypto.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })
      localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return crypto.randomUUID?.() || String(Date.now())
  }
}

function themeVars(t: ThemeOptions = {}): string {
  const v: string[] = []
  if (t.primaryColor) {
    const c = t.primaryColor
    v.push(`--td-brand-color:${c}`, `--td-brand-color-6:${c}`,
      `--td-brand-color-hover:color-mix(in srgb,${c} 82%,#fff)`, `--td-brand-color-5:color-mix(in srgb,${c} 82%,#fff)`,
      `--td-brand-color-active:color-mix(in srgb,${c} 85%,#000)`, `--td-brand-color-7:color-mix(in srgb,${c} 85%,#000)`,
      `--td-brand-color-light:color-mix(in srgb,${c} 8%,#fff)`, `--td-brand-color-1:color-mix(in srgb,${c} 8%,#fff)`,
      `--td-brand-color-focus:color-mix(in srgb,${c} 18%,#fff)`, `--td-brand-color-2:color-mix(in srgb,${c} 18%,#fff)`,
      `--td-brand-color-disabled:color-mix(in srgb,${c} 35%,#fff)`, `--td-brand-color-3:color-mix(in srgb,${c} 35%,#fff)`,
      `--td-text-color-brand:${c}`, `--td-text-color-link:${c}`, `--adp-primary:${c}`)
  }
  if (t.radius) v.push(`--adp-radius:${t.radius}`)
  if (t.fontFamily) v.push(`--adp-font-family:${t.fontFamily}`)
  return v.length ? `:host{${v.join(';')}}` : ''
}

const LOADER_CSS = `
:host{all:initial;display:block}
:host([data-mode=inline]){width:100%;height:100%;contain:content}
.adp-shell{width:100%;height:100%;box-sizing:border-box}
.adp-popup-root{position:relative;z-index:2147483001;font-family:var(--adp-font-family,-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue','Microsoft YaHei',sans-serif);font-size:14px;color:var(--td-text-color-primary)}
.adp-launcher{position:fixed;bottom:24px;z-index:2147483000;width:56px;height:56px;padding:0;border:none;border-radius:50%;cursor:pointer;
  background:var(--adp-primary,#4a70ff);color:#fff;box-shadow:0 8px 24px rgba(30,50,120,.28);display:flex;align-items:center;justify-content:center;transition:transform .15s}
.adp-launcher:hover{transform:scale(1.06)}
.adp-launcher img{width:100%;height:100%;border-radius:50%;object-fit:cover}
.adp-panel{position:fixed;bottom:92px;z-index:2147483000;max-height:calc(100vh - 116px);border-radius:16px;overflow:hidden;
  background:#fff;box-shadow:0 16px 48px rgba(15,30,60,.2);border:1px solid rgba(0,0,0,.06);display:none}
.adp-panel.is-open{display:block;animation:adp-in .18s ease-out}
.adp-loading{display:flex;align-items:center;justify-content:center;height:100%;color:#8a919f;font:13px -apple-system,'PingFang SC',sans-serif}
@keyframes adp-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (max-width:520px){.adp-panel{left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;max-height:none;border-radius:0}
  .adp-panel.is-open~.adp-launcher{display:none}}
.adp-launcher svg{flex:none}
`
const CHAT_ICON = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5v-8Z" fill="currentColor"/><circle cx="8.5" cy="9.5" r="1.2" fill="#fff"/><circle cx="12" cy="9.5" r="1.2" fill="#fff"/><circle cx="15.5" cy="9.5" r="1.2" fill="#fff"/></svg>'
const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>'

function mount(target?: string | HTMLElement | MountOptions | null, maybe?: MountOptions): ChatInstance {
  const isBubble = !target || (typeof target === 'object' && !(target instanceof HTMLElement))
  const opts: MountOptions = (isBubble ? (target as MountOptions) : maybe) || {}
  const apiBase = (opts.apiBase || new URL('../', SDK_BASE).href).replace(/\/+$/, '')

  // 宿主节点 + Shadow DOM
  let hostEl: HTMLElement
  if (isBubble) {
    hostEl = document.createElement('div')
    document.body.appendChild(hostEl)
  } else {
    const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : (target as HTMLElement)
    if (!el) throw new Error(`[ADPChat] 找不到容器：${String(target)}`)
    hostEl = document.createElement('div')
    el.appendChild(hostEl)
  }
  hostEl.setAttribute('data-adp-chat', '')
  hostEl.setAttribute('data-mode', isBubble ? 'bubble' : 'inline')
  if (opts.theme?.mode === 'dark') hostEl.setAttribute('theme-mode', 'dark')
  const shadow = hostEl.attachShadow({ mode: 'open' })

  const coreCss = document.createElement('link')
  coreCss.rel = 'stylesheet'
  coreCss.href = SDK_BASE + 'core.css?v=' + VERSION
  const style = document.createElement('style')
  style.textContent = LOADER_CSS + themeVars(opts.theme) + (opts.customCss || '')
  shadow.append(coreCss, style)

  const shell = document.createElement('div')
  shell.className = 'adp-shell'
  const popupRoot = document.createElement('div')
  popupRoot.className = 'adp-popup-root'

  let panel: HTMLElement | null = null
  let launcher: HTMLButtonElement | null = null
  let mounted: ReturnType<Core['mountCore']> | null = null
  let mounting: Promise<void> | null = null
  let isOpen = false

  const userToken = typeof opts.userToken === 'function' ? opts.userToken
    : opts.userToken ? () => opts.userToken as string : undefined

  function ensureMounted() {
    if (!mounting) {
      injectFonts()
      shell.innerHTML = '<div class="adp-loading">正在加载…</div>'
      mounting = Promise.all([loadCore(), new Promise((r) => {
        if (coreCss.sheet) r(null); else { coreCss.onload = coreCss.onerror = () => r(null) }
      })]).then(([core]) => {
        shell.innerHTML = ''
        const container = document.createElement('div')
        container.style.cssText = 'width:100%;height:100%'
        shell.appendChild(container)
        mounted = core.mountCore(container, hostEl, popupRoot, {
          apiBase, visitorId: visitorId(), mode: isBubble ? 'bubble' : 'inline', getUserToken: userToken,
          title: opts.title, avatar: opts.avatar, greeting: opts.greeting, questions: opts.questions,
          theme: opts.theme?.mode === 'dark' ? 'dark' : 'light', language: opts.language, history: opts.history, resume: opts.resume,
          onClose: () => instance.close(),
        })
      }).catch((err) => {
        mounting = null
        shell.innerHTML = '<div class="adp-loading">加载失败，请检查网络后重试</div>'
        console.error('[ADPChat] 加载失败', err)
      })
    }
    return mounting
  }

  if (isBubble) {
    const side = opts.position === 'left' ? 'left' : 'right'
    panel = document.createElement('div')
    panel.className = 'adp-panel'
    panel.style.cssText = `${side}:24px;width:${opts.width || 420}px;height:${opts.height || 680}px`
    panel.appendChild(shell)
    launcher = document.createElement('button')
    launcher.className = 'adp-launcher'
    launcher.style[side] = '24px'
    launcher.setAttribute('aria-label', '打开对话')
    const setIcon = () => {
      launcher!.innerHTML = isOpen ? CLOSE_ICON : opts.bubbleIcon ? `<img src="${opts.bubbleIcon.replace(/"/g, '&quot;')}" alt="">` : CHAT_ICON
    }
    setIcon()
    launcher.onclick = () => instance.toggle()
    shadow.append(panel, launcher, popupRoot)
    ;(launcher as unknown as { _setIcon: () => void })._setIcon = setIcon
    // 空闲时预取对话界面，点开即用
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 1500))
    idle(() => { loadCore().catch(() => {}) })
  } else {
    shadow.append(shell, popupRoot)
    ensureMounted()
  }

  const instance: ChatInstance = {
    open() {
      if (!panel) return
      isOpen = true
      panel.classList.add('is-open')
      ;(launcher as unknown as { _setIcon: () => void })._setIcon()
      ensureMounted()
    },
    close() {
      if (!panel) return
      isOpen = false
      panel.classList.remove('is-open')
      ;(launcher as unknown as { _setIcon: () => void })._setIcon()
    },
    toggle() { isOpen ? instance.close() : instance.open() },
    newChat() { mounted?.newChat() },
    send(text: string) {
      if (panel) instance.open()
      ensureMounted()?.then(() => mounted?.send(text))
    },
    destroy() {
      mounted?.unmount()
      hostEl.remove()
    },
  }
  if (isBubble && opts.open) instance.open()
  return instance
}

const ADPChat = { mount, version: VERSION }
;(window as unknown as { ADPChat: typeof ADPChat }).ADPChat = ADPChat
export default ADPChat
