import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'))
// 每次构建唯一：core.js / core.css 等资源地址带上它，避免网关或浏览器缓存把新旧版本混用（样式作用域 ID 对不上会整块失效）
const VERSION = `${pkg.version}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`

/**
 * TDesign 的弹层（Message / Dialog / Tooltip / Popup）默认挂到 document.body，
 * 在 Shadow DOM 外就拿不到组件样式。SDK 自带一份 TDesign，这里把它的挂载点改为
 * 当前对话实例 shadow 内的 popup 容器（globalThis.__ADP_POPUP_ROOT__），不影响宿主页面。
 */
function popupInShadow(): Plugin {
  return {
    name: 'adp-popup-in-shadow',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('tdesign-vue-next') || !code.includes('var getAttach = function getAttach(')) return
      const before = code
      code = code.replace(
        /var getAttach = function getAttach\(node, triggerNode\) \{[\s\S]*?\n\};/,
        `var getAttach = function getAttach(node, triggerNode) {
  var root = globalThis.__ADP_POPUP_ROOT__;
  var attachNode = isFunction(node) ? node(triggerNode) : node;
  if (!attachNode || attachNode === "body") return root || document.body;
  if (isString(attachNode)) return document.querySelector(attachNode) || (root && root.getRootNode().querySelector(attachNode)) || root || document.body;
  if (attachNode instanceof HTMLElement) return attachNode;
  return root || document.body;
};`,
      )
      if (code === before) this.error('未能改写 TDesign getAttach，请检查 tdesign-vue-next 版本')
      return code
    },
  }
}

/**
 * 官方组件里 <Teleport to="body"> 的浮层（Skills 弹层、@ 提及面板）会被挂到宿主页 body，
 * 脱离 Shadow DOM 后样式全部失效。构建时改为挂到当前 SDK 实例 shadow 内的弹层根节点。
 */
function teleportInShadow(): Plugin {
  return {
    name: 'adp-teleport-in-shadow',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/adp-chat-component/src/') || !id.endsWith('.vue') || !code.includes('<Teleport to="body">')) return
      let c = code.split('<Teleport to="body">').join('<Teleport :to="__adpTeleportTo()">')
      const m = c.match(/<script setup[^>]*>/)
      if (!m) this.error(`Teleport 补丁失败（没有 <script setup>）：${id}`)
      c = c.replace(m![0], `${m![0]}\nconst __adpTeleportTo = () => (globalThis as any).__ADP_POPUP_ROOT__ || 'body';`)
      return c
    },
  }
}

/**
 * 在构建时给官方 ChatItem.vue 打补丁（不改官方源码）：
 * 回复结束后把执行过程收进一级「已处理 XX 秒」折叠，对齐 ADP 智能工作台。
 * 补丁点找不到时直接报错，避免官方组件升级后静默失效。
 */
function resultFoldPatch(): Plugin {
  const dir = path.resolve(__dirname, 'src/core/overrides')
  const must = (code: string, from: string | RegExp, to: string, what: string, ctx: any) => {
    const next = code.replace(from as any, to)
    if (next === code) ctx.error(`ChatItem 补丁失败：${what}`)
    return next
  }
  return {
    name: 'adp-result-fold',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/components/Chat/ChatItem.vue')) return
      let c = code
      c = must(c, "import CollapsibleMessageGroup from './CollapsibleMessageGroup.vue';",
        `import CollapsibleMessageGroup from './CollapsibleMessageGroup.vue';\nimport AdpResultFold from '${dir}/ResultFold.vue';\nimport { wrapResult as __adpWrapResult } from '${dir}/resultFold';`,
        'import', this)
      c = must(c, /(\/\/ 最后一组折叠消息\s*\n\s*flushCollapse\(\);\s*\n\s*)return items;/,
        '$1return __adpWrapResult(items, record.value as any, !!(props.isStreamLoad && props.isLastMsg));',
        'renderItems', this)
      c = must(c, /<CollapsibleMessageGroup\s*\n(\s*)v-if="renderItem\.kind === 'collapse'"/,
        `<AdpResultFold\n$1v-if="renderItem.kind === 'result'"\n$1:fold="renderItem"\n$1:theme="theme"\n$1:language="language"\n$1:i18n="chatI18n"\n$1:mode="mode"\n$1:recordId="item.RecordId"\n$1:isMobile="isMobile"\n$1/>\n$1<CollapsibleMessageGroup\n$1v-else-if="renderItem.kind === 'collapse'"`,
        'template', this)
      return c
    },
  }
}

export default defineConfig(({ mode }) => {
  const common = {
    plugins: [popupInShadow(), teleportInShadow(), resultFoldPatch(), vue(), vueJsx()],
    define: {
      'process.env.NODE_ENV': '"production"',
      __ADP_CHAT_VERSION__: JSON.stringify(VERSION),
    },
    resolve: {
      alias: [
        { find: '@adp', replacement: path.resolve(__dirname, '../adp-chat-component/src') },
        // 与官方 app 一致：wangeditor 运行时用自建 bundle
        { find: /^@wangeditor\/editor$/, replacement: path.resolve(__dirname, '../app/public/wangeditor.esm.js') },
        // 代码高亮只打包常用语言（~35 种），完整版 highlight.js 有 190+ 种语言、gzip 后 370KB
        { find: /^highlight\.js$/, replacement: 'highlight.js/lib/common' },
      ],
      dedupe: ['vue', 'tdesign-vue-next'],
    },
  }

  if (mode === 'loader') {
    return {
      ...common,
      plugins: [],
      build: {
        outDir: 'dist/sdk',
        emptyOutDir: false,
        minify: true,
        lib: {
          entry: path.resolve(__dirname, 'src/loader.ts'),
          name: 'ADPChat',
          formats: ['iife'],
          fileName: () => 'adp-chat.js',
        },
      },
    }
  }

  // core：ES 模块 + 代码分割（公式、图表 widget、编辑器等按需加载）
  return {
    ...common,
    build: {
      outDir: 'dist/sdk',
      emptyOutDir: true,
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 4000,
      lib: {
        entry: path.resolve(__dirname, 'src/core/index.ts'),
        formats: ['es'],
        fileName: () => 'core.js',
        cssFileName: 'core-raw',
      },
      rollupOptions: {
        output: {
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: (info) =>
            (info.names?.[0] || '').endsWith('.css') ? 'core-raw.css' : 'assets/[name]-[hash][extname]',
        },
      },
    },
  }
})
