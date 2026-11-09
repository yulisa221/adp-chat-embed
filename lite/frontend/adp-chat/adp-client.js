/*!
 * ADP 对话客户端（无界面）—— adp-sites「ADP 对话接入·轻量版」模板自带
 *
 * 只负责和后端 / ADP 通信：配置、会话列表、历史、上传、流式对话、停止。
 * 不依赖任何框架，不渲染任何界面；界面可以用模板自带的 adp-chat-ui.js，也可以完全自己写。
 * 本文件随模板分发，可直接修改；版本跟随模板，不承诺对外接口兼容。
 *
 * 用法：
 *   const client = ADPClient.create()                 // 默认后端地址：本脚本所在站点的 /api/chat
 *   const run = client.send({ text: '你好' }, {
 *     onConversation(c) {},                           // 新会话拿到 ID
 *     onUpdate(msg) {},                               // 助手消息每收到一段就回调一次（完整快照）
 *     onDone(msg) {},                                 // 结束（完成 / 停止 / 出错都会回调）
 *   })
 *   run.stop()
 *
 * 消息结构（历史与实时一致）：
 *   { id, role: 'user'|'assistant', status: 'streaming'|'done'|'stopped'|'error',
 *     text, files: [{ name, url, size }], steps: [{ id, type, title, status, detail }], error, time }
 */
;(function (global) {
  'use strict'

  var SCRIPT = document.currentScript && document.currentScript.src
  var VISITOR_KEY = 'adp-chat-visitor'

  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID()
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, function () { return ((Math.random() * 16) | 0).toString(16) })
  }

  function visitorId() {
    try {
      var v = localStorage.getItem(VISITOR_KEY)
      if (!v) { v = uuid(); localStorage.setItem(VISITOR_KEY, v) }
      return v
    } catch (e) { return uuid() }
  }

  function defaultApiBase() {
    // 可在引入脚本前设置 window.ADP_CHAT_API_BASE 指定后端地址
    if (global.ADP_CHAT_API_BASE) return global.ADP_CHAT_API_BASE
    // adp-sites 站点的后端固定挂在 <站点域名>/api/chat，按脚本所在域名推算（脚本放在子目录也不影响）
    try { return new URL('/api/chat', SCRIPT || location.href).href } catch (e) { return '/api/chat' }
  }

  // ------------------------------------------------------------------ 流式事件 → 记录（与后端 merge.py 同一套规则）
  function assign() {
    var o = {}
    for (var i = 0; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) o[k] = s[k] }
    return o
  }

  function mergeRecord(cur, inc, replaceMessages) {
    var m = assign(cur || inc, inc)
    if (cur) ['Messages', 'ExtraInfo'].forEach(function (k) { if (inc[k] == null && cur[k] != null) m[k] = cur[k] })
    if (replaceMessages && inc.Messages != null) m.Messages = inc.Messages
    return m
  }

  function withMessage(rec, id, fn) {
    var list = (rec.Messages || []).slice()
    var i = list.findIndex(function (x) { return x.MessageId === id })
    if (i < 0) { list.push({ MessageId: id, Type: 'notice', Title: '', Status: 'processing', Contents: [] }); i = list.length - 1 }
    list[i] = fn(assign(list[i]))
    return assign(rec, { Messages: list })
  }

  function withContent(rec, id, idx, fn) {
    return withMessage(rec, id, function (msg) {
      var cs = (msg.Contents || []).slice()
      while (cs.length <= idx) cs.push(null)
      cs[idx] = fn(cs[idx])
      msg.Contents = cs
      return msg
    })
  }

  function applyEvent(ev, rec) {
    var t = ev.Type
    if (t === 'request_ack') return mergeRecord(rec, ev.RequestAck || {}, true)
    if (t === 'response.created' || t === 'response.processing' || t === 'response.completed')
      return mergeRecord(rec, ev.Response || {}, t === 'response.completed')
    if (!rec) return rec
    if (t === 'message.added' || t === 'message.processing' || t === 'message.done') {
      var inc = ev.Message || {}
      var found = false
      var list = (rec.Messages || []).map(function (m) {
        if (m.MessageId !== inc.MessageId) return m
        found = true
        var n = assign(m, inc)
        if (inc.Contents == null) n.Contents = m.Contents
        n.ExtraInfo = assign(m.ExtraInfo, inc.ExtraInfo)
        return n
      })
      if (!found) list.push(inc)
      return assign(rec, { Messages: list })
    }
    if (t === 'content.added')
      return withContent(rec, ev.MessageId, ev.ContentIndex || 0, function (old) { return old ? assign(old, ev.Content) : ev.Content })
    if (t === 'text.delta')
      return withContent(rec, ev.MessageId, ev.ContentIndex || 0, function (old) {
        var b = old || { Type: 'text', Text: '' }
        return assign(b, { Text: (b.Text || '') + (ev.Text || '') })
      })
    return rec
  }

  // ------------------------------------------------------------------ 记录 → 简化消息
  var STATUS = { processing: 'streaming', stop: 'stopped', stopped: 'stopped', failed: 'error' }

  function textOf(contents) {
    return (contents || []).filter(function (c) { return c && (c.Type === 'text' || c.Type === 'json_text') && c.Text })
      .map(function (c) { return c.Text }).join('')
  }

  function filesOf(contents) {
    var out = []
    ;(contents || []).forEach(function (c) {
      if (!c) return
      if (c.Type === 'file' && c.File) out.push({ name: c.File.FileName || '文件', url: c.File.FileUrl || '', size: Number(c.File.FileSize) || 0 })
      if (c.Type === 'image' && (c.Image || c.Url)) { var u = (c.Image && (c.Image.Url || c.Image.ImageUrl)) || c.Url; out.push({ name: '图片', url: u, image: true }) }
    })
    return out
  }

  function toMessage(rec) {
    if (!rec) return null
    var extra = rec.ExtraInfo || {}
    var msg = {
      id: rec.RecordId || '', role: rec.Role === 'user' ? 'user' : 'assistant',
      status: STATUS[rec.Status] || 'done', text: '', files: [], steps: [], error: '',
      time: Number(extra.StartTime) || 0, elapsed: Number(extra.Elapsed) || 0, raw: rec,
    }
    var texts = []
    ;(rec.Messages || []).forEach(function (m) {
      if (msg.role === 'user' || m.Type === 'reply' || m.Type === 'question') {
        var t = textOf(m.Contents)
        if (t) texts.push(t)
        msg.files = msg.files.concat(filesOf(m.Contents))
        return
      }
      if (m.Type === 'recommendation') return
      var title = m.Title || (m.ExtraInfo && m.ExtraInfo.ToolName) || m.Name || ''
      if (!title && !textOf(m.Contents)) return
      msg.steps.push({ id: m.MessageId, type: m.Type, title: title || '处理中', status: STATUS[m.Status] || 'done', detail: textOf(m.Contents) })
    })
    msg.text = texts.join('\n\n')
    if (rec.Status === 'failed' && !msg.text) msg.error = rec.StatusDesc || '回复失败'
    return msg
  }

  // ------------------------------------------------------------------ 客户端
  function create(opts) {
    opts = opts || {}
    var base = (opts.apiBase || defaultApiBase()).replace(/\/+$/, '')
    var vid = opts.visitorId || visitorId()
    var lang = opts.language || 'zh-CN'
    var cfgPromise = null

    async function headers(extra) {
      var h = assign({ 'X-ADP-Visitor': vid }, extra)
      var token = opts.getUserToken && (await opts.getUserToken())
      if (token) h['X-ADP-User-Token'] = token
      return h
    }

    async function request(path, init) {
      init = init || {}
      var res = await fetch(base + path, assign(init, { headers: await headers(init.headers) }))
      if (!res.ok) {
        var msg = 'HTTP ' + res.status
        try { var b = await res.json(); msg = b.detail || b.message || msg } catch (e) { /* 非 JSON */ }
        throw new Error(msg)
      }
      return res.json()
    }

    function postJSON(path, body) {
      return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    }

    var api = {
      apiBase: base,
      visitorId: vid,
      /** 应用名称、头像、欢迎语、示例问题，以及对话方式 transport: 'ws' | 'sse' */
      config: function () {
        cfgPromise = cfgPromise || request('/config').catch(function (e) { cfgPromise = null; throw e })
        return cfgPromise
      },
      listConversations: async function () {
        var r = await request('/conversations')
        return (r.conversations || []).map(function (c) { return { id: c.Id, title: c.Title || '新对话', updatedAt: (c.LastActiveAt || c.CreatedAt || 0) * 1000 } })
      },
      loadMessages: async function (id) {
        var r = await request('/conversations/' + encodeURIComponent(id) + '/records')
        return (r.records || []).map(toMessage).filter(Boolean)
      },
      deleteConversation: function (id) {
        return request('/conversations/' + encodeURIComponent(id), { method: 'DELETE' })
      },
      /** 上传附件，返回 { url, name, size, type }；发送时放进 files */
      upload: function (file) {
        return request('/upload?filename=' + encodeURIComponent(file.name), {
          method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
        })
      },
      send: function (input, handlers) { return send(input, handlers || {}) },
      /** 停止一条仍在后台生成的回复（刷新页面后接着看的会话；仅 WebSocket 方式） */
      stopRemote: async function (conversationId, recordId) {
        var auth = await postJSON('/ws/token', { ConversationId: conversationId, Contents: [] })
        var ws = new WebSocket(wsUrl(auth.url))
        return new Promise(function (resolve) {
          var done = function () { try { ws.close() } catch (e) { /* ignore */ } resolve() }
          var timer = setTimeout(done, 8000)
          ws.onmessage = function (e) {
            var m = String(e.data)
            if (m === '2') return ws.send('3')
            if (m[0] === '0') return ws.send('40' + JSON.stringify({ token: auth.token }))
            if (m.indexOf('40') === 0) {
              ws.send('42' + JSON.stringify(['stop_generation', { Type: 'stop_generation', StopGeneration: { RecordId: recordId } }]))
              setTimeout(function () { clearTimeout(timer); done() }, 800)
            }
          }
          ws.onerror = function () { clearTimeout(timer); done() }
        })
      },
      toMessage: toMessage,
    }

    function wsUrl(url) {
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'language=' + encodeURIComponent(lang) + '&EIO=4&transport=websocket'
    }

    function contentsOf(input) {
      var contents = []
      if (input.text) contents.push({ Type: 'text', Text: input.text })
      ;(input.files || []).forEach(function (f) {
        contents.push({ Type: 'file', File: {
          DocId: '0', FileName: f.name || '', FileUrl: f.url, FileSize: String(f.size || 0),
          FileType: (f.name || '').split('.').pop() || '',
        } })
      })
      ;(input.contents || []).forEach(function (c) { contents.push(c) })
      return contents
    }

    function send(input, h) {
      var contents = contentsOf(input)
      var bot = null
      var stopped = false
      var finished = false
      var stopFn = function () {}
      var convId = input.conversationId || ''

      function emitUpdate() { if (bot && h.onUpdate) h.onUpdate(toMessage(bot)) }
      function handle(ev) {
        if (ev.Type === 'adp.conversation' && ev.Conversation) {
          convId = ev.Conversation.Id
          if (h.onConversation) h.onConversation({ id: convId, title: ev.Conversation.Title || '新对话', updatedAt: Date.now() })
          return
        }
        if (ev.Type === 'request_ack') { if (h.onAck) h.onAck(ev.RequestAck || {}); return }
        if (ev.Type === 'error') {
          var err = (ev.Error && ev.Error.Message) || '回复失败'
          bot = assign(bot || { Role: 'assistant', RecordId: 'local-' + Date.now(), Messages: [] }, { Status: ev.Error && ev.Error.Code === 'ReplyTimeLimit' ? 'stop' : 'failed', StatusDesc: err })
          finish(err)
          return
        }
        bot = applyEvent(ev, bot)
        emitUpdate()
        if (ev.Type === 'response.completed') finish()
      }
      function finish(err) {
        if (finished) return
        finished = true
        if (!bot) bot = { Role: 'assistant', RecordId: 'local-' + Date.now(), Messages: [], Status: err ? 'failed' : 'success', StatusDesc: err || '' }
        if (stopped) bot = assign(bot, { Status: 'stop' })
        else if (bot.Status === 'processing') bot = assign(bot, { Status: 'success' })
        var msg = toMessage(bot)
        if (err && bot.Status !== 'stop') msg.error = err
        else if (err) msg.notice = err
        if (h.onDone) h.onDone(msg)
      }

      var done = (async function () {
        try {
          var cfg = await api.config().catch(function () { return {} })
          if (cfg.transport === 'ws') await viaWebSocket()
          else await viaSSE()
        } catch (e) {
          if (!stopped) finish(e && e.message ? e.message : '发送失败，请重试')
        }
        finish()
      })()

      async function viaSSE() {
        var ctl = new AbortController()
        stopFn = function () { ctl.abort() }
        var body = { Contents: contents }
        if (convId) body.ConversationId = convId
        var res
        try {
          res = await fetch(base + '/chat', {
            method: 'POST', signal: ctl.signal, body: JSON.stringify(body),
            headers: await headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
          })
        } catch (e) { if (stopped) return; throw e }
        if (!res.ok || !res.body) {
          var msg = 'HTTP ' + res.status
          try { var b = await res.json(); msg = b.detail || b.message || msg } catch (e) { /* ignore */ }
          throw new Error(msg)
        }
        var reader = res.body.getReader()
        var dec = new TextDecoder()
        var buf = ''
        try {
          while (true) {
            var r = await reader.read()
            if (r.done) break
            buf += dec.decode(r.value, { stream: true })
            var lines = buf.split('\n')
            buf = lines.pop()
            lines.forEach(function (line) {
              if (line.indexOf('data:') !== 0) return // 空行、心跳注释
              try { handle(JSON.parse(line.slice(5))) } catch (e) { /* 忽略无法解析的行 */ }
            })
          }
        } catch (e) { if (!stopped) throw e }
      }

      async function viaWebSocket() {
        var body = { Contents: contents }
        if (convId) body.ConversationId = convId
        var auth = await postJSON('/ws/token', body)
        if (stopped) return
        convId = auth.conversationId
        if (auth.conversation) handle({ Type: 'adp.conversation', Conversation: auth.conversation })
        var requestId = uuid()
        var recordId = ''
        var started = false
        await new Promise(function (resolve) {
          var ws = new WebSocket(wsUrl(auth.url))
          var alive = null
          var aliveMs = 60000
          var closed = false
          function close(delay) {
            if (closed) return
            closed = true
            clearTimeout(alive)
            setTimeout(function () { try { ws.close() } catch (e) { /* ignore */ } }, delay || 0)
            resolve()
          }
          function touch() { clearTimeout(alive); alive = setTimeout(function () { end('连接超时') }, aliveMs) }
          function end(reason) {
            if (closed) return
            if (!finished && !stopped) handle({ Type: 'error', Error: { Code: 'Disconnected', Message: started ? (reason || '连接中断') + '，已保留收到的内容' : '连接对话服务失败，请重试' } })
            close()
          }
          function emit(name, payload) { if (ws.readyState === 1) ws.send('42' + JSON.stringify([name, payload])) }
          stopFn = function () {
            if (recordId) emit('stop_generation', { Type: 'stop_generation', StopGeneration: { RecordId: recordId } })
            finish()
            close(800) // 稍等服务端收下停止事件再断开
          }
          ws.onmessage = function (e) {
            var m = String(e.data)
            touch()
            if (m === '2') return ws.send('3')
            if (m[0] === '0') {
              try { var hs = JSON.parse(m.slice(1)); aliveMs = (hs.pingInterval || 25000) + (hs.pingTimeout || 20000) + 5000 } catch (err) { /* 默认值 */ }
              return ws.send('40' + JSON.stringify({ token: auth.token }))
            }
            if (m.indexOf('40') === 0) {
              return emit('request', { Type: 'request', Request: {
                RequestId: requestId, ConversationId: convId, VisitorId: auth.visitorId, Contents: contents, Incremental: true,
              } })
            }
            if (m.indexOf('44') === 0) return end('对话鉴权失败，请刷新后重试')
            if (m.indexOf('42') !== 0) return
            var pair
            try { pair = JSON.parse(m.slice(2)) } catch (err) { return }
            var ev = assign(pair[1], { Type: (pair[1] && pair[1].Type) || pair[0] })
            if (ev.Type === 'response.created') recordId = (ev.Response && ev.Response.RecordId) || recordId
            if (ev.Type !== 'request_ack' && ev.Type !== 'error') started = true
            handle(ev)
            if (finished) close()
          }
          ws.onclose = function () { end('连接中断') }
          ws.onerror = function () { end('连接中断') }
          touch()
        })
      }

      return {
        get conversationId() { return convId },
        stop: function () { if (finished) return; stopped = true; stopFn() },
        done: done,
      }
    }

    return api
  }

  global.ADPClient = { create: create, toMessage: toMessage, applyEvent: applyEvent }
})(window)
