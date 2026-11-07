// 把 core-raw.css 处理成两份：
//   core.css  —— 注入 Shadow DOM：:root → :host，主题变量才能生效
//   fonts.css —— 只含 @font-face，挂到宿主文档（Shadow DOM 内声明的字体不生效）
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const postcss = require('postcss')
const dir = process.argv[2]
const raw = fs.readFileSync(path.join(dir, 'core-raw.css'), 'utf8')
const root = postcss.parse(raw)
const fonts = postcss.root()

// 库模式会把字体内联成 base64；这里拆回独立的 woff2 文件（只保留 woff2），按需下载
fs.mkdirSync(path.join(dir, 'assets/fonts'), { recursive: true })
root.walkAtRules('font-face', (rule) => {
  const clone = rule.clone()
  clone.walkDecls('src', (decl) => {
    const m = decl.value.match(/url\(["']?data:font\/woff2;base64,([^)"']+)["']?\)/)
    if (!m) return
    const get = (p) => (clone.nodes.find((n) => n.prop === p)?.value || '').replace(/["'\s]/g, '')
    const name = `${get('font-family') || 'font'}-${get('font-weight') || '400'}-${get('font-style') || 'normal'}.woff2`
    fs.writeFileSync(path.join(dir, 'assets/fonts', name), Buffer.from(m[1], 'base64'))
    decl.value = `url(assets/fonts/${name}) format("woff2")`
  })
  fonts.append(clone)
  rule.remove()
})
root.walkRules((rule) => {
  rule.selectors = rule.selectors.map((s) =>
    s
      .replace(/:root\[([^\]]+)\]/g, ':host([$1])')
      .replace(/:root/g, ':host')
      .replace(/^(html|body)(?=$|[\s.:,>[])/, ':host'),
  )
})
fs.writeFileSync(path.join(dir, 'core.css'), root.toString())
fs.writeFileSync(path.join(dir, 'fonts.css'), fonts.toString())
fs.rmSync(path.join(dir, 'core-raw.css'))
console.log('core.css', fs.statSync(path.join(dir, 'core.css')).size, 'fonts.css', fs.statSync(path.join(dir, 'fonts.css')).size)
