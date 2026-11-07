<!-- 一级「已处理 XX 秒」折叠：展开后按原样渲染执行过程折叠组与过程性回复 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import CollapsibleMessageGroup from '@adp/components/Chat/CollapsibleMessageGroup.vue'
import MdContent from '@adp/components/Common/MdContent.vue'
import CustomizedIcon from '@adp/components/CustomizedIcon.vue'
import type { Message } from '@adp/model/chat-v2'
import { formatDuration, type ResultItem } from './resultFold'

const props = defineProps<{
  fold: ResultItem
  theme?: string
  language?: string
  i18n?: any
  mode?: any
  recordId?: string
  isMobile?: boolean
}>()

const expanded = ref(false)
const en = computed(() => (props.language || '').startsWith('en'))
const title = computed(() => {
  const d = formatDuration(props.fold.durationMs)
  if (props.fold.stopped) return d ? (en.value ? `Stopped after ${d}` : `运行 ${d} 后停止`) : (en.value ? 'Stopped' : '已停止')
  return d ? `${en.value ? 'Processed' : '已处理'} ${d}` : (en.value ? 'Processed' : '已处理')
})
function text(msg?: Message) {
  return (msg?.Contents || []).map((c: any) => c?.Text || '').filter(Boolean).join('\n')
}
</script>

<template>
  <div class="adp-result" :class="{ 'is-open': expanded }">
    <div class="adp-result__header" @click="expanded = !expanded">
      <span class="adp-result__title">{{ title }}</span>
      <span class="adp-result__arrow">
        <CustomizedIcon remote name="arrow_up_small_line" :showHoverBg="false" size="xs" :theme="theme as any" />
      </span>
    </div>
    <div v-show="expanded" class="adp-result__content">
      <template v-for="(it, i) in fold.items" :key="'rf-' + i">
        <CollapsibleMessageGroup
          v-if="it.kind === 'collapse'"
          :kind="it.collapseKind || 'mixed'"
          :messages="it.messages || []"
          :theme="theme as any"
          :language="language"
          :i18n="i18n"
        />
        <MdContent
          v-else-if="it.kind === 'reply'"
          :content="text(it.message)"
          role="assistant"
          :theme="theme as any"
          :mode="mode"
          :language="language"
          :recordId="recordId"
          :disable="true"
          :enableScale="isMobile"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.adp-result { width: 100%; margin-bottom: 4px; }
.adp-result__header { display: inline-flex; align-items: center; gap: 4px; padding: 4px 0; cursor: pointer; user-select: none; }
.adp-result__title { font-size: 14px; line-height: 20px; color: var(--td-text-color-placeholder); }
.adp-result__arrow { display: inline-flex; color: var(--td-text-color-placeholder); transform: rotate(90deg); transition: transform .2s; }
.adp-result.is-open .adp-result__arrow { transform: rotate(180deg); }
.adp-result__header:hover .adp-result__title, .adp-result__header:hover .adp-result__arrow { color: var(--td-text-color-secondary); }
.adp-result__content { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
</style>
