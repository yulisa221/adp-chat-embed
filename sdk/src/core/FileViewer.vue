<script setup lang="ts">
// 文件预览面板：图片 / PDF / HTML / Markdown / 代码与文本。
// 复用官方 FilePreview 下的 Image / Html / Markdown 预览；代码用 MdContent 高亮渲染（不引入 Monaco，
// 避免跨域 Worker 问题和体积）；Office 文档没有在线预览能力，提供下载。
import { computed, ref, watch } from 'vue'
import ImagePreview from '@adp/components/FilePreview/ImagePreview.vue'
import HtmlPreview from '@adp/components/FilePreview/HtmlPreview.vue'
import MarkdownPreview from '@adp/components/FilePreview/MarkdownPreview.vue'
import MdContent from '@adp/components/Common/MdContent.vue'

const props = defineProps<{ url: string; name: string; proxied: (url: string) => string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const CODE: Record<string, string> = {
  js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript', py: 'python', java: 'java', go: 'go',
  rs: 'rust', c: 'c', cpp: 'cpp', h: 'c', cs: 'csharp', php: 'php', rb: 'ruby', sh: 'bash', sql: 'sql',
  json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', css: 'css', vue: 'html', kt: 'kotlin', swift: 'swift',
  txt: '', log: '', csv: '', ini: 'ini', toml: 'ini',
}
const ext = computed(() => (props.name.split('.').pop() || '').toLowerCase())
const kind = computed(() => {
  const e = ext.value
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(e)) return 'image'
  if (e === 'pdf') return 'pdf'
  if (e === 'html' || e === 'htm') return 'html'
  if (e === 'md' || e === 'markdown') return 'markdown'
  if (e in CODE) return 'code'
  return 'other'
})

const code = ref('')
const loading = ref(false)
const failed = ref('')
watch(
  () => [props.url, kind.value],
  async () => {
    code.value = ''
    failed.value = ''
    if (kind.value !== 'code') return
    loading.value = true
    try {
      const res = await fetch(props.proxied(props.url))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      let text = await res.text()
      if (text.length > 200000) text = text.slice(0, 200000) + '\n…（内容过长，已截断，完整内容请下载查看）'
      const lang = CODE[ext.value] ?? ''
      code.value = '```' + lang + '\n' + text.replace(/```/g, '`\u200b``') + '\n```'
    } catch (e) {
      failed.value = '文件读取失败：' + (e as Error).message
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="fv">
    <header class="fv-head">
      <span class="fv-name" :title="name">{{ name }}</span>
      <a class="fv-btn" :href="url" target="_blank" rel="noopener" download>下载</a>
      <button class="fv-btn" title="关闭" @click="emit('close')">✕</button>
    </header>
    <div class="fv-body">
      <ImagePreview v-if="kind === 'image'" :url="url" :file-name="name" />
      <iframe v-else-if="kind === 'pdf'" class="fv-frame" :src="url" />
      <HtmlPreview v-else-if="kind === 'html'" :url="proxied(url)" :file-name="name" />
      <MarkdownPreview v-else-if="kind === 'markdown'" :url="proxied(url)" :file-name="name" />
      <template v-else-if="kind === 'code'">
        <div v-if="loading" class="fv-tip">正在加载…</div>
        <div v-else-if="failed" class="fv-tip">{{ failed }}</div>
        <div v-else class="fv-code"><MdContent :content="code" /></div>
      </template>
      <div v-else class="fv-tip">
        <div class="fv-icon">📄</div>
        暂不支持在线预览该格式，<a :href="url" target="_blank" rel="noopener" download>下载查看</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fv { display: flex; flex-direction: column; height: 100%; background: var(--td-bg-color-container); }
.fv-head { height: 48px; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--td-component-stroke); }
.fv-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 14px; color: var(--td-text-color-primary); }
.fv-btn { height: 28px; min-width: 28px; padding: 0 8px; display: inline-flex; align-items: center; justify-content: center; border: none; background: transparent; border-radius: 6px; cursor: pointer; color: var(--td-text-color-secondary); font-size: 13px; text-decoration: none; }
.fv-btn:hover { background: var(--td-bg-color-container-hover); }
.fv-body { flex: 1; min-height: 0; overflow: auto; position: relative; }
.fv-body > :deep(*) { height: 100%; }
.fv-frame { width: 100%; height: 100%; border: none; }
.fv-code { padding: 8px 16px; height: auto !important; }
.fv-tip { padding: 48px 24px; text-align: center; color: var(--td-text-color-secondary); font-size: 14px; height: auto !important; }
.fv-tip a { color: var(--td-brand-color); }
.fv-icon { font-size: 40px; margin-bottom: 12px; }
</style>
