# adp-chat-embed

把腾讯云 ADP 应用（Agent）做成一个对话云服务：一个可直接打开的对话页，外加两行代码把对话框嵌入任意网站。
界面直接复用 ADP 官方开源客户端 [adp-chat-client](https://github.com/TencentCloudADP/adp-chat-client) 的对话组件，在 Shadow DOM 里渲染，和宿主网站样式互不影响，不用 iframe。

本仓库是 WorkBuddy `adp-sites` 技能「ADP 对话接入」场景的模板与 SDK 源码。技能使用时直接下载 [Releases](../../releases) 里预构建好的模板包，不需要在本地构建。

## 两种对话方式

| | 方式一：云函数转发 | 方式二：浏览器直连 WebSocket（推荐） |
| --- | --- | --- |
| 需要的密钥 | 应用 AppKey | AppKey + 腾讯云 API 密钥（SecretId、SecretKey） |
| 对话链路 | 浏览器 → 云函数 `/chat` → ADP chat/v2（SSE） | 云函数只换一次性令牌，浏览器直连 ADP WebSocket |
| 单次回复时长 | 受云函数超时限制（默认 5 分钟），到点截断 | 不受限制 |
| 会话列表 / 历史 | 存站点数据库 | 直接查 ADP，与控制台同一份 |
| 刷新后接着看进行中的回复 | 不支持 | 支持 |
| 每个访客一份 Agent（选模型、Skills、连接器、工具、知识库） | 不支持 | 支持（应用需为 Claw 模式并开启「允许在对话中动态修改配置」） |

两种方式都没有常驻容器（后端是 HTTP 云函数），密钥只在云函数里，浏览器拿不到。部署时配置了 API 密钥就自动使用方式二。

## 目录

```text
sdk/                       嵌入 SDK 源码（Vue 3 + Vite，放进 adp-chat-client 的 workspace 构建）
  src/loader.ts            入口 adp-chat.js（约 3KB）：创建 Shadow DOM、内嵌 / 气泡、按需加载 core
  src/core/ChatApp.vue     对话界面：官方 Chat / HistoryList 组件 + 按会话独立的流状态 + 文件预览 + Widget 交互
  src/core/api.ts          与站点后端 /api/chat 通信
  src/core/wsTransport.ts  方式二：手写 Socket.IO v4，把 WebSocket 事件转成官方 fetchSSE 能消费的流
  src/core/overrides/      「已处理 XX 秒」结果折叠
  vite.config.ts           构建期补丁：TDesign 弹层 / Teleport 挂到 Shadow DOM 内、ChatItem 结果折叠
template/                  adp-sites 项目模板（下载后整目录拷贝，只改配置）
  adp-sites.json           声明默认存储桶（对话附件）
  frontend/                整页对话 index.html、接入说明页 embed.html
  migrations/              会话 / 消息表、访客 Agent 绑定表
  functions/chat/          HTTP 云函数（FastAPI），挂在 /api/chat
scripts/build.sh           从源码构建 dist/adp-chat-template.tar.gz
UPSTREAM_REF               构建所用的 adp-chat-client 提交
```

模板包 = `template/` + `functions/chat/sdk/`（预构建 SDK）。

## 构建

```bash
sh scripts/build.sh                    # 使用 UPSTREAM_REF 固定的上游提交
UPSTREAM_REF=main sh scripts/build.sh  # 试用上游最新代码
```

需要 git 和 Node.js 20.19+ / 22.12+。脚本会把 adp-chat-client 克隆到 `.upstream/`，按其锁文件安装依赖，把 `sdk/` 放进它的 `client/packages/` 构建，产物打包到 `dist/`。

构建期补丁找不到注入点时会直接报错（例如上游改了 `ChatItem.vue`），不会静默失效；升级上游后先本地构建验证，再更新 `UPSTREAM_REF`。

## 发布

推送 `v*` 标签后，GitHub Actions 构建并把 `adp-chat-template.tar.gz` 与 `.sha256` 上传到同名 Release。发布新版本后，在 `adp-sites` 技能的 `scripts/adp_chat_template.py` 里更新版本号与校验值。

## 实现要点

- **样式隔离**：界面在 Shadow DOM 里渲染；`core.css` 由 `scripts/postcss-shadow.mjs` 把 `:root` / `html` / `body` 选择器改写为 `:host`。官方组件里挂到 `document.body` 的弹层（TDesign 弹层、`<Teleport to="body">`）在构建时改挂到 Shadow DOM 内的弹层根节点。
- **缓存**：资源地址的版本号每次构建唯一，避免旧 `core.css` 与新 `core.js` 的作用域 ID 对不上。
- **方式二的访客 Agent**：云函数首次为访客 `CopyAgentFromApp(Kind=1)` 复制用户态 Agent 并绑定（先写入者为准）；新会话 `CreateConversation(Type=5, AgentId)`；官方组件的 `/adp/<Action>` 请求白名单转发，强制改写 AppId / AgentId / SpaceId，`ModifyAgent` 只允许改 Model / SkillList / ToolList / PluginList。
- **历史归属**：ADP 的消息查询与删除接口不校验访客，云函数先用会话列表确认归属再放行。会话列表需按带 / 不带 AgentId 各查一次再合并。

## 许可

SDK 运行时打包了 adp-chat-client 的组件代码，遵循其[开源许可](https://github.com/TencentCloudADP/adp-chat-client/blob/main/LICENSE)。
