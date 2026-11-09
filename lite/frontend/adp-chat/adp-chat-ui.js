/*!
 * ADP 对话界面（默认界面）—— adp-sites「ADP 对话接入·轻量版」模板自带
 *
 * 纯 JS + CSS，无构建、无框架、不用 Shadow DOM。依赖同目录的 adp-client.js。
 * 开箱即用：ADPChatUI.mount('#chat') 或 ADPChatUI.mount(null, { mode: 'bubble' })
 * 想改：
 *   1. 改颜色、圆角、字体：覆盖 adp-chat-ui.css 顶部的 CSS 变量
 *   2. 改样式：直接覆盖 .adpc-* 类名，或修改 adp-chat-ui.css
 *   3. 改结构与交互：直接修改本文件（每块界面都是一个 render 函数）
 *   4. 完全自己写界面：只引入 adp-client.js（见文件头的用法）
 * 本文件随模板分发，版本跟随模板，不承诺对外接口兼容。
 */
;(function (global) {
  'use strict'

  var SCRIPT = document.currentScript && document.currentScript.src

  // ------------------------------------------------------------------ 小工具
  function h(tag, attrs, children) {
    var el = document.createElement(tag)
    if (attrs) for (var k in attrs) {
      var v = attrs[k]
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k === 'html') el.innerHTML = v
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : v)
    }
    ;[].concat(children || []).forEach(function (c) { if (c != null && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c) })
    return el
  }

  var ICONS = {
    send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    attach: '<path d="M21 11.5l-8.5 8.5a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8.5-8.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  }
  function icon(name) {
    return '<svg class="adpc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>'
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  function safeUrl(u) { return /^(https?:|mailto:|\/|\.)/i.test(u) ? u : '#' }

  function fmtSize(n) {
    if (!n) return ''
    if (n < 1024) return n + ' B'
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1048576).toFixed(1) + ' MB'
  }
  function fmtTime(ms) {
    if (!ms) return ''
    var d = new Date(ms), now = new Date()
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
    if (d.toDateString() === now.toDateString()) return hm
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm
  }
  function fmtElapsed(ms) {
    var s = Math.round(ms / 1000)
    if (!s) return ''
    return s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's'
  }

  // ------------------------------------------------------------------ Markdown（够用的安全子集：先转义再解析，不执行任何 HTML）
  function inline(s) {
    var codes = []
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000' })
    s = esc(s)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, u) { return '<img src="' + esc(safeUrl(u)) + '" alt="' + alt + '">' })
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) { return '<a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener">' + t + '</a>' })
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + esc(codes[+i]) + '</code>' })
  }

  function markdown(src) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n')
    var out = [], i = 0
    function isTableSep(l) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) }
    function cells(l) { return l.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return inline(c.trim()) }) }
    while (i < lines.length) {
      var l = lines[i]
      var fence = l.match(/^\s*(```|~~~)\s*([\w+-]*)/)
      if (fence) {
        var buf = []
        i++
        while (i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0) buf.push(lines[i++])
        i++
        out.push('<pre><code' + (fence[2] ? ' class="lang-' + esc(fence[2]) + '"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>')
        continue
      }
      if (!l.trim()) { i++; continue }
      var hd = l.match(/^(#{1,6})\s+(.*)$/)
      if (hd) { out.push('<h' + hd[1].length + '>' + inline(hd[2]) + '</h' + hd[1].length + '>'); i++; continue }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue }
      if (l.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = cells(l), rows = []
        i += 2
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) rows.push(cells(lines[i++]))
        out.push('<div class="adpc-table"><table><thead><tr>' + head.map(function (c) { return '<th>' + c + '</th>' }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>' }).join('') + '</tr>' }).join('') + '</tbody></table></div>')
        continue
      }
      if (/^\s*>/.test(l)) {
        var q = []
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
        out.push('<blockquote>' + markdown(q.join('\n')) + '</blockquote>')
        continue
      }
      var li = l.match(/^(\s*)([-*+]|\d+[.)])\s+/)
      if (li) {
        var ordered = /\d/.test(li[2]), items = []
        while (i < lines.length) {
          var m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
          if (m) { items.push(m[3]); i++ }
          else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += '\n' + lines[i].trim(); i++ }
          else break
        }
        var tag = ordered ? 'ol' : 'ul'
        out.push('<' + tag + '>' + items.map(function (t) { return '<li>' + inline(t).replace(/\n/g, '<br>') + '</li>' }).join('') + '</' + tag + '>')
        continue
      }
      var p = []
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) &&
        !(lines[i].indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1]))) p.push(lines[i++])
      out.push('<p>' + p.map(inline).join('<br>') + '</p>')
    }
    return out.join('')
  }

  // ------------------------------------------------------------------ 样式自动加载（可用 css: false 关闭，改用自己的样式表）
  function ensureCss(href) {
    if (!href || document.querySelector('link[data-adpc-css]')) return
    document.head.appendChild(h('link', { rel: 'stylesheet', href: href, 'data-adpc-css': '' }))
  }

  // ------------------------------------------------------------------ 挂载
  /**
   * mount(target, options)
   *   target   选择器或元素；mode 为 bubble 时可传 null（挂到 body）
   *   options  { apiBase, mode: 'inline'|'bubble', theme: 'light'|'dark', title, avatar, greeting, questions,
   *              history: true, placeholder, css: true | '<样式表地址>', getUserToken, client }
   * 返回 { client, open(), close(), send(text), newChat(), destroy() }
   */
  function mount(target, options) {
    var o = options || {}
    if (o.css !== false) ensureCss(typeof o.css === 'string' ? o.css : new URL('adp-chat-ui.css', SCRIPT || location.href).href)
    var client = o.client || global.ADPClient.create({ apiBase: o.apiBase, getUserToken: o.getUserToken, language: o.language })
    var bubble = o.mode === 'bubble'
    var host = typeof target === 'string' ? document.querySelector(target) : target
    if (!host) { if (!bubble) throw new Error('[ADPChatUI] 找不到挂载元素：' + target); host = document.body }

    // ---------- 状态：每个会话独立，切换会话不打断进行中的回复
    var cfg = { name: o.title || 'AI 助手', avatar: o.avatar || '', greeting: o.greeting || '', questions: o.questions || [] }
    var conversations = []
    var sessions = {}            // key -> { messages, run, follow }
    var current = newKey()
    var pending = []             // 待发送附件 { file, status, result }
    var destroyed = false
    var openSteps = new Map()

    function newKey() { return 'new:' + Date.now() + Math.random().toString(36).slice(2, 6) }
    function isNew(k) { return k.indexOf('new:') === 0 }
    function sess(k) { return sessions[k] || (sessions[k] = { messages: [], run: null, follow: null, loaded: isNew(k) }) }

    // ---------- 结构
    var root = h('div', { class: 'adpc adpc--' + (bubble ? 'bubble' : 'inline') + (o.theme === 'dark' ? ' adpc--dark' : '') })
    var titleEl = h('span', { class: 'adpc-title' })
    var avatarEl = h('span', { class: 'adpc-avatar' })
    var header = h('div', { class: 'adpc-header' }, [
      o.history === false ? null : h('button', { class: 'adpc-btn adpc-btn--icon adpc-toggle-side', title: '会话列表', html: icon('list'), onclick: function () { root.classList.toggle('adpc--side-open') } }),
      avatarEl, titleEl,
      h('span', { class: 'adpc-spacer' }),
      h('button', { class: 'adpc-btn adpc-btn--icon', title: '新对话', html: icon('plus'), onclick: function () { newChat() } }),
      bubble ? h('button', { class: 'adpc-btn adpc-btn--icon', title: '关闭', html: icon('close'), onclick: function () { close() } }) : null,
    ])
    var sideList = h('div', { class: 'adpc-side-list' })
    var side = o.history === false ? null : h('aside', { class: 'adpc-side' }, [
      h('div', { class: 'adpc-side-head' }, [h('span', { text: '会话' }), h('button', { class: 'adpc-btn adpc-btn--icon', title: '收起', html: icon('close'), onclick: function () { root.classList.remove('adpc--side-open') } })]),
      sideList,
    ])
    var list = h('div', { class: 'adpc-messages' })
    var fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: function () { addFiles(fileInput.files); fileInput.value = '' } })
    var fileBar = h('div', { class: 'adpc-files' })
    var input = h('textarea', { class: 'adpc-input', rows: 1, placeholder: o.placeholder || '输入消息，Enter 发送，Shift+Enter 换行' })
    var sendBtn = h('button', { class: 'adpc-send', title: '发送', html: icon('send'), onclick: function () { isChatting() ? stop() : submit() } })
    var composer = h('div', { class: 'adpc-composer' }, [
      fileBar, input,
      h('div', { class: 'adpc-composer-bar' }, [
        h('button', { class: 'adpc-btn adpc-btn--icon', title: '上传附件', html: icon('attach'), onclick: function () { fileInput.click() } }),
        h('span', { class: 'adpc-spacer' }), sendBtn,
      ]),
      fileInput,
    ])
    var main = h('div', { class: 'adpc-main' }, [header, list, composer])
    root.appendChild(h('div', { class: 'adpc-body' }, [side, h('div', { class: 'adpc-mask', onclick: function () { root.classList.remove('adpc--side-open') } }), main]))

    var launcher = null
    if (bubble) {
      launcher = h('button', { class: 'adpc-launcher', title: '打开对话', html: icon('chat'), onclick: function () { open() } })
      var wrap = h('div', { class: 'adpc-bubble-wrap' }, [root, launcher])
      host.appendChild(wrap)
    } else {
      host.appendChild(root)
    }

    // 宽度足够时会话列表常驻
    if (global.ResizeObserver) {
      var ro = new ResizeObserver(function () { root.classList.toggle('adpc--wide', root.clientWidth >= 860) })
      ro.observe(root)
    }

    // ---------- 输入
    var composing = false
    input.addEventListener('compositionstart', function () { composing = true })
    input.addEventListener('compositionend', function () { composing = false })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !composing && !e.isComposing) { e.preventDefault(); if (!isChatting()) submit() }
    })
    input.addEventListener('input', autosize)
    input.addEventListener('paste', function (e) {
      var files = e.clipboardData && e.clipboardData.files
      if (files && files.length) { e.preventDefault(); addFiles(files) }
    })
    function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px' }

    // ---------- 渲染
    function renderHeader() {
      titleEl.textContent = cfg.name
      avatarEl.innerHTML = cfg.avatar ? '<img src="' + esc(cfg.avatar) + '" alt="">' : ''
      avatarEl.style.display = cfg.avatar ? '' : 'none'
    }

    function renderSide() {
      if (!side) return
      sideList.innerHTML = ''
      if (!conversations.length) sideList.appendChild(h('div', { class: 'adpc-side-empty', text: '暂无会话' }))
      conversations.forEach(function (c) {
        var s = sessions[c.id]
        sideList.appendChild(h('div', {
          class: 'adpc-side-item' + (c.id === current ? ' is-active' : ''),
          onclick: function () { select(c.id) },
        }, [
          h('span', { class: 'adpc-side-title', text: c.title, title: c.title }),
          s && (s.run || s.follow) ? h('span', { class: 'adpc-dot', title: '回复中' }) : h('span', { class: 'adpc-side-time', text: fmtTime(c.updatedAt) }),
          h('button', { class: 'adpc-btn adpc-btn--icon adpc-side-del', title: '删除', html: icon('trash'), onclick: function (e) { e.stopPropagation(); remove(c) } }),
        ]))
      })
    }

    function renderWelcome() {
      return h('div', { class: 'adpc-welcome' }, [
        cfg.avatar ? h('img', { class: 'adpc-welcome-avatar', src: cfg.avatar, alt: '' }) : null,
        h('div', { class: 'adpc-welcome-name', text: cfg.name }),
        cfg.greeting ? h('div', { class: 'adpc-welcome-text', html: markdown(cfg.greeting) }) : null,
        cfg.questions.length ? h('div', { class: 'adpc-questions' }, cfg.questions.map(function (q) {
          return h('button', { class: 'adpc-question', text: q, onclick: function () { submit(q) } })
        })) : null,
      ])
    }

    function renderFiles(files) {
      if (!files.length) return null
      return h('div', { class: 'adpc-msg-files' }, files.map(function (f) {
        if (f.image) return h('a', { href: safeUrl(f.url), target: '_blank', rel: 'noopener' }, [h('img', { class: 'adpc-msg-image', src: f.url, alt: '' })])
        return h('a', { class: 'adpc-file', href: safeUrl(f.url), target: '_blank', rel: 'noopener' }, [
          h('span', { html: icon('file') }), h('span', { class: 'adpc-file-name', text: f.name }), h('span', { class: 'adpc-file-size', text: fmtSize(f.size) }),
        ])
      }))
    }

    function renderSteps(m) {
      if (!m.steps.length) return null
      var running = m.status === 'streaming'
      var label = running ? '正在处理…' : (m.status === 'stopped' ? '已停止' : '已处理') + (m.elapsed ? ' ' + fmtElapsed(m.elapsed) : '') + ' · ' + m.steps.length + ' 步'
      var det = h('details', { class: 'adpc-steps' + (running ? ' is-running' : '') }, [
        h('summary', { text: label }),
        h('ol', null, m.steps.map(function (s) {
          return h('li', { class: 'adpc-step adpc-step--' + s.status }, [
            h('span', { class: 'adpc-step-title', text: s.title }),
            s.detail && s.type === 'thought' ? h('div', { class: 'adpc-step-detail', text: s.detail }) : null,
          ])
        })),
      ])
      // 用户手动展开 / 收起后，重新渲染时保持
      if (openSteps.has(m.id)) det.open = openSteps.get(m.id)
      else if (running) det.open = true
      det.addEventListener('toggle', function () { if (m.status !== 'streaming') openSteps.set(m.id, det.open) })
      return det
    }

    function renderMessage(m) {
      if (m.role === 'user') {
        return h('div', { class: 'adpc-msg adpc-msg--user' }, [
          renderFiles(m.files),
          m.text ? h('div', { class: 'adpc-bubble', text: m.text }) : null,
        ])
      }
      var body = h('div', { class: 'adpc-md' + (m.status === 'streaming' ? ' is-streaming' : ''), html: markdown(m.text) })
      var copyBtn = h('button', { class: 'adpc-btn adpc-btn--icon', title: '复制', html: icon('copy'), onclick: function () {
        navigator.clipboard && navigator.clipboard.writeText(m.text).then(function () { copyBtn.innerHTML = icon('check'); setTimeout(function () { copyBtn.innerHTML = icon('copy') }, 1200) })
      } })
      var waiting = m.status === 'streaming' && !m.text && !m.steps.length
      return h('div', { class: 'adpc-msg adpc-msg--assistant' }, [
        renderSteps(m),
        waiting ? h('div', { class: 'adpc-typing' }, [h('i'), h('i'), h('i')]) : null,
        m.text ? body : null,
        renderFiles(m.files),
        m.error ? h('div', { class: 'adpc-error', text: '⚠ ' + m.error }) : null,
        m.notice ? h('div', { class: 'adpc-notice', text: m.notice }) : null,
        m.status !== 'streaming' && m.text ? h('div', { class: 'adpc-actions' }, [copyBtn, h('span', { class: 'adpc-time', text: fmtTime(m.time) })]) : null,
      ])
    }

    var raf = 0
    function renderMessages(stick) {
      if (raf) return
      raf = requestAnimationFrame(function () {
        raf = 0
        var nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80
        var msgs = sess(current).messages
        list.innerHTML = ''
        if (!msgs.length) list.appendChild(renderWelcome())
        msgs.forEach(function (m) { list.appendChild(renderMessage(m)) })
        if (stick || nearBottom) list.scrollTop = list.scrollHeight
      })
    }

    function renderComposer() {
      var chatting = isChatting()
      sendBtn.innerHTML = icon(chatting ? 'stop' : 'send')
      sendBtn.title = chatting ? '停止' : '发送'
      sendBtn.classList.toggle('is-stop', chatting)
      fileBar.innerHTML = ''
      pending.forEach(function (p, idx) {
        fileBar.appendChild(h('span', { class: 'adpc-file adpc-file--' + p.status }, [
          h('span', { html: icon('file') }),
          h('span', { class: 'adpc-file-name', text: p.file.name }),
          h('span', { class: 'adpc-file-size', text: p.status === 'uploading' ? '上传中' : p.status === 'error' ? '失败' : fmtSize(p.file.size) }),
          h('button', { class: 'adpc-btn adpc-btn--icon', title: '移除', html: icon('close'), onclick: function () { pending.splice(idx, 1); renderComposer() } }),
        ]))
      })
    }

    function render(stick) { renderHeader(); renderSide(); renderMessages(stick); renderComposer() }

    // ---------- 行为
    function isChatting() { var s = sess(current); return !!(s.run || s.follow) }

    function addFiles(files) {
      ;[].slice.call(files || []).forEach(function (file) {
        var p = { file: file, status: 'uploading', result: null }
        pending.push(p)
        client.upload(file).then(function (r) { p.status = 'done'; p.result = r }, function (e) { p.status = 'error'; console.warn('[ADPChatUI] 上传失败', e) })
          .then(renderComposer)
      })
      renderComposer()
    }

    function submit(text) {
      text = (text == null ? input.value : text).trim()
      if (pending.some(function (p) { return p.status === 'uploading' })) return
      var files = pending.filter(function (p) { return p.status === 'done' }).map(function (p) { return p.result })
      if (!text && !files.length) return
      var key = current
      var s = sess(key)
      if (s.run || s.follow) return
      input.value = ''
      autosize()
      pending = []
      s.messages.push({ id: 'u' + Date.now(), role: 'user', status: 'done', text: text, files: files, steps: [], time: Date.now() })
      var bot = { id: 'a' + Date.now(), role: 'assistant', status: 'streaming', text: '', files: [], steps: [], time: Date.now() }
      s.messages.push(bot)
      var started = Date.now()
      function put(m) {
        m.time = m.time || started
        if (m.status !== 'streaming' && !m.elapsed) m.elapsed = Date.now() - started
        s.messages[s.messages.indexOf(bot)] = m
        bot = m
        if (key === current) renderMessages()
      }
      s.run = client.send({ conversationId: isNew(key) ? '' : key, text: text, files: files }, {
        onConversation: function (c) {
          if (isNew(key)) {
            delete sessions[key]
            sessions[c.id] = s
            if (current === key) current = c.id
            key = c.id
          }
          conversations = [c].concat(conversations.filter(function (x) { return x.id !== c.id }))
          renderSide()
        },
        onUpdate: put,
        onDone: function (m) {
          put(m)
          s.run = null
          var c = conversations.find(function (x) { return x.id === key })
          if (c) c.updatedAt = Date.now()
          render()
        },
      })
      render(true)
    }

    function stop() {
      var s = sess(current)
      if (s.run) { s.run.stop(); return }
      if (s.follow) {
        var last = s.messages[s.messages.length - 1]
        if (last && last.id && !isNew(current)) client.stopRemote(current, last.id).catch(function (e) { console.warn('[ADPChatUI] 停止失败', e) })
      }
    }

    // 刷新页面后打开仍在生成的会话：显示为输出中，定时拉取进度（WebSocket 方式下 ADP 会继续生成）
    function follow(id, s) {
      var last = s.messages[s.messages.length - 1]
      if (!last || last.role !== 'assistant' || last.status !== 'streaming') return
      var tick = async function () {
        if (destroyed || sessions[id] !== s || s.run) { s.follow = null; return }
        try { s.messages = await client.loadMessages(id) } catch (e) { console.warn('[ADPChatUI] 刷新进度失败', e) }
        var l = s.messages[s.messages.length - 1]
        s.follow = l && l.role === 'assistant' && l.status === 'streaming' ? setTimeout(tick, 3000) : null
        if (id === current) render()
        else renderSide()
      }
      s.follow = setTimeout(tick, 3000)
    }

    async function select(id) {
      root.classList.remove('adpc--side-open')
      if (id === current) return
      current = id
      var s = sess(id)
      render(true)
      if (s.loaded || s.run) return
      list.innerHTML = '<div class="adpc-loading">加载中…</div>'
      try {
        s.messages = await client.loadMessages(id)
        s.loaded = true
        follow(id, s)
      } catch (e) {
        s.messages = [{ id: 'err', role: 'assistant', status: 'error', text: '', files: [], steps: [], error: '加载历史失败：' + e.message }]
      }
      if (current === id) render(true)
    }

    function newChat() {
      if (!(isNew(current) && !sess(current).messages.length)) current = newKey()
      root.classList.remove('adpc--side-open')
      render(true)
      input.focus()
    }

    function remove(c) {
      if (!global.confirm('确定删除「' + c.title + '」吗？删除后无法恢复。')) return
      var s = sessions[c.id]
      if (s && s.run) s.run.stop()
      if (s && s.follow) clearTimeout(s.follow)
      client.deleteConversation(c.id).then(function () {
        conversations = conversations.filter(function (x) { return x.id !== c.id })
        delete sessions[c.id]
        if (current === c.id) current = newKey()
        render(true)
      }, function (e) { global.alert('删除失败：' + e.message) })
    }

    function open() { root.parentNode.classList.add('is-open'); setTimeout(function () { input.focus() }, 50) }
    function close() { if (bubble) root.parentNode.classList.remove('is-open') }

    // ---------- 初始化
    render()
    client.config().then(function (c) {
      cfg = {
        name: o.title || c.name || cfg.name, avatar: o.avatar || c.avatar || '',
        greeting: o.greeting || c.greeting || '', questions: o.questions || c.questions || [],
      }
      render()
    }, function (e) { console.warn('[ADPChatUI] 获取应用信息失败', e) })
    if (side) client.listConversations().then(function (l) { conversations = l; renderSide() }, function (e) { console.warn('[ADPChatUI] 获取会话列表失败', e) })

    return {
      client: client,
      root: root,
      open: open,
      close: close,
      newChat: newChat,
      send: function (text) { submit(text) },
      destroy: function () {
        destroyed = true
        Object.keys(sessions).forEach(function (k) { var s = sessions[k]; if (s.run) s.run.stop(); if (s.follow) clearTimeout(s.follow) })
        var el = bubble ? root.parentNode : root
        el.parentNode && el.parentNode.removeChild(el)
      },
    }
  }

  global.ADPChatUI = { mount: mount, markdown: markdown }
})(window)
