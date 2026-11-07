/**
 * 「已处理 XX 秒」结果折叠（对齐 ADP 智能工作台 smart-webim 的 _getResultCollapseItems）：
 * 回复结束后，把「最后一个执行过程折叠组」及之前的所有内容（含中间穿插的过程性回复）收进一级折叠，
 * 只把最后一次工具调用之后的最终回复直接展示。没有执行过程时不折叠。
 * 进行中的回复不折叠，保持逐步展示。
 *
 * 由 vite 插件注入到官方 ChatItem.vue 的 renderItems 计算结果上（见 vite.config.ts），不修改官方源码。
 */
import type { Message, Record as ChatRecord } from '@adp/model/chat-v2'

export interface ResultItem {
  kind: 'result'
  items: any[]
  durationMs: number
  stopped: boolean
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 运行时长：优先记录上的 Elapsed，其次用各消息的开始 / 结束时间推算 */
export function runDurationMs(record: ChatRecord | undefined): number {
  const extra = (record?.ExtraInfo || {}) as Record<string, unknown>
  const elapsed = num(extra.Elapsed)
  if (elapsed > 0) return elapsed
  let start = 0
  let end = 0
  for (const m of (record?.Messages || []) as Message[]) {
    const ei = (m.ExtraInfo || {}) as Record<string, unknown>
    const s = num(ei.StartTime)
    const e = Math.max(num(ei.EndTime), s)
    if (s && (!start || s < start)) start = s
    if (e > end) end = e
  }
  return start && end > start ? end - start : 0
}

export function wrapResult(items: any[], record: ChatRecord | undefined, streaming: boolean): any[] {
  if (streaming || !record || record.Status === 'processing') return items
  let last = -1
  items.forEach((it, i) => { if (it?.kind === 'collapse') last = i })
  if (last < 0) return items
  const fold: ResultItem = {
    kind: 'result',
    items: items.slice(0, last + 1),
    durationMs: runDurationMs(record),
    stopped: record.Status === 'stop' || record.Status === 'stopped',
  }
  return [fold, ...items.slice(last + 1)]
}

/** 时长格式：与工作台一致，524000 → 8m44s，5000 → 5s */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (!total) return ''
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h${m}m${s}s`
  if (m) return `${m}m${s}s`
  return `${s}s`
}
