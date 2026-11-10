"""ADP 对话接入后端（HTTP 云函数 functions/chat，网关挂载路径为 /api/<服务名>，转发时去掉该前缀）。

两种对话方式，按环境变量自动选择（也可用 CHAT_TRANSPORT=sse|ws 强制指定）：
- sse（只配置 ADP_APP_KEY）：浏览器 → 云函数 /chat → ADP chat/v2。单次回复时长受云函数超时限制，
  到达 CHAT_MAX_SECONDS 时主动截断并保存已收到的内容。
- ws（再配置 TC_SECRET_ID / TC_SECRET_KEY）：云函数只负责换一次性令牌（/ws/token），浏览器直连
  ADP WebSocket，回复时长不受云函数超时限制；会话列表、历史消息、删除会话直接查 ADP（adp_history.py），
  站点数据库不存对话。

- POST /chat                     [sse] 转发 ADP chat/v2 流式对话（服务端注入 AppKey），同时把问答存进数据库
- POST /ws/token                 [ws] 校验访客与会话归属，换取 WebSocket 令牌
- POST /conversations/{id}/turn  [ws] 兼容旧版 SDK，直接返回成功（历史以 ADP 为准）
- GET  /conversations            当前访客的会话列表
- GET  /conversations/{id}/records  某个会话的历史消息（Record 结构与实时回复一致）
- DELETE /conversations/{id}     删除会话
- POST /upload?filename=xx       上传对话附件到站点云存储，返回公开链接
- GET  /file?url=xx              文件预览中转（解决浏览器跨域，仅允许云存储域名）
- GET  /config                   应用名称、头像、欢迎语、示例问题
- GET  /suggestions              输入框上方的快捷指令（默认为空）
- GET  /sdk/*                    嵌入用 SDK（adp-chat.js 及其分块、样式、字体）
- GET  /health                   健康检查

访客身份：
- 默认匿名：SDK 在宿主页面生成随机 ID，放在 X-ADP-Visitor 请求头，会话按它隔离。
- 实名（可选）：配置 USER_TOKEN_SECRET 后，宿主后端用它给用户 ID 签名，SDK 放在 X-ADP-User-Token 请求头；
  再配置 REQUIRE_USER_TOKEN=true 则拒绝匿名访客。签名格式见 sign_user_token()。
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import re
import tempfile
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

import adp_history
import tc_api
import user_agent
from merge import apply_event, finalize
from storage_client import StorageClient, StorageError
from store import StoreError, create_store, to_conversation

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("adp-chat")

ADP_CHAT_URL = os.environ.get("ADP_CHAT_URL", "https://wss.lke.cloud.tencent.com/adp/v2/chat")
ADP_WS_URL = os.environ.get("ADP_WS_URL", "wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn/")
SSE_IDLE_TIMEOUT = float(os.environ.get("SSE_IDLE_TIMEOUT", "300"))
# sse 方式下单次回复的最长秒数，默认 895 秒（约 15 分钟）。必须比云函数超时小几秒，留出保存历史的时间：
# 部署时配 --fn-timeout 900（云函数上限）；超时调小时同步调小本值
CHAT_MAX_SECONDS = float(os.environ.get("CHAT_MAX_SECONDS", "895"))
# 上游长时间无数据时（如 Agent 在执行工具）每隔这么多秒发一次 SSE 注释心跳，防止网关按空闲断开
HEARTBEAT_SECONDS = float(os.environ.get("HEARTBEAT_SECONDS", "15"))


def transport() -> str:
    forced = os.environ.get("CHAT_TRANSPORT", "").lower()
    if forced in ("sse", "ws"):
        return forced
    return "ws" if tc_api.configured() else "sse"

LOCAL_DEV = os.environ.get("LOCAL_DEV") == "1"
SDK_DIR = Path(__file__).parent / "sdk"
# 本地联调的文件替身目录放在系统临时目录，避免被打进部署包
LOCAL_FILES = Path(os.environ.get("LOCAL_STORAGE_DIR", Path(tempfile.gettempdir()) / "adp-chat-local-storage"))

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
store = create_store()
http = httpx.AsyncClient(timeout=httpx.Timeout(15, read=SSE_IDLE_TIMEOUT), follow_redirects=False)
_background: set[asyncio.Task] = set()

origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    max_age=86400,
)


@app.middleware("http")
async def no_store(request: Request, call_next):
    response = await call_next(request)
    # 站点网关会缓存没有缓存头的 GET；接口一律不缓存，SDK 静态文件自己设置缓存头
    if "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(StorageError)
async def storage_error(_request, err: StorageError):
    return JSONResponse({"ok": False, "code": err.code, "stage": err.stage, "message": str(err),
                         "request_id": err.request_id}, status_code=err.status)


@app.exception_handler(StoreError)
async def store_error(_request, err: StoreError):
    log.error("store error: %s", err)
    return JSONResponse({"ok": False, "code": "DB_ERROR", "message": "数据库暂时不可用"}, status_code=503)


# ---------------------------------------------------------------- 身份

def sign_user_token(user_id: str, secret: str, ttl: int = 86400) -> str:
    """宿主后端可参考的签名实现：token = <user_id>.<过期时间戳>.<HMAC-SHA256 十六进制>"""
    exp = int(time.time()) + ttl
    sig = hmac.new(secret.encode(), f"{user_id}.{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{user_id}.{exp}.{sig}"


def owner_of(request: Request) -> str:
    secret = os.environ.get("USER_TOKEN_SECRET", "")
    token = request.headers.get("x-adp-user-token", "")
    if secret and token:
        try:
            user_id, exp, sig = token.rsplit(".", 2)
            expect = hmac.new(secret.encode(), f"{user_id}.{exp}".encode(), hashlib.sha256).hexdigest()
            if hmac.compare_digest(sig, expect) and int(exp) > time.time() and 0 < len(user_id) <= 64:
                return "u_" + user_id
        except ValueError:
            pass
        raise HTTPException(401, "用户凭证无效或已过期")
    if os.environ.get("REQUIRE_USER_TOKEN", "").lower() == "true":
        raise HTTPException(401, "需要登录后使用")
    visitor = request.headers.get("x-adp-visitor", "")
    if not re.fullmatch(r"[0-9a-fA-F-]{32,36}", visitor):
        raise HTTPException(400, "缺少访客标识")
    return "v_" + visitor.replace("-", "").lower()


async def own_conversation(conv_id: str, owner: str) -> dict:
    conv = await store.get_conversation(conv_id)
    if not conv or conv.get("owner") != owner:
        raise HTTPException(404, "会话不存在")
    return conv


# ---------------------------------------------------------------- 基础

@app.get("/health")
async def health():
    if not os.environ.get("ADP_APP_KEY"):
        return JSONResponse({"status": "misconfigured", "message": "ADP_APP_KEY 未配置"}, status_code=503)
    if transport() == "ws" and not tc_api.configured():
        return JSONResponse({"status": "misconfigured", "message": "ws 方式需要 TC_SECRET_ID / TC_SECRET_KEY"},
                            status_code=503)
    if transport() == "sse":
        await store.list_conversations("health-check")
    return {"status": "ok", "transport": transport(), "sdk": (SDK_DIR / "adp-chat.js").exists()}


async def _app_id_or_empty() -> str:
    try:
        return await adp_history.resolve_app_id(http, os.environ.get("ADP_APP_KEY", ""))
    except (tc_api.TcApiError, httpx.HTTPError) as e:
        log.warning("resolve app id failed: %s", e)
        return ""


async def _space_id_or_empty() -> str:
    try:
        return await adp_history.resolve_space_id(http, os.environ.get("ADP_APP_KEY", ""))
    except (tc_api.TcApiError, httpx.HTTPError) as e:
        log.warning("resolve space id failed: %s", e)
        return ""


@app.get("/config")
async def config():
    questions = [q.strip() for q in os.environ.get("APP_QUESTIONS", "").split("|") if q.strip()]
    info = {"name": os.environ.get("APP_NAME", "AI 助手"),
            "avatar": os.environ.get("APP_AVATAR", ""),
            "greeting": os.environ.get("APP_GREETING", "你好，有什么可以帮你？"),
            "questions": questions[:6]}
    if adp_mode():
        # ws 方式：名称、头像、欢迎语、示例问题以 ADP 应用配置为准；ADP 没配的项才用环境变量
        try:
            remote = await adp_history.app_info(http, os.environ.get("ADP_APP_KEY", ""))
        except (tc_api.TcApiError, httpx.HTTPError) as e:
            log.warning("load app info from ADP failed: %s", e)
            remote = None
        for k, v in (remote or {}).items():
            if v:
                info[k] = v
    return {**info,
            "transport": transport(),
            "history": "adp" if transport() == "ws" else "site",
            # 方式二：每个访客一份 Agent，界面开放模型选择、技能、工具、连接器、知识库
            "userAgent": user_agent_mode(),
            "appId": await _app_id_or_empty() if user_agent_mode() else "",
            "spaceId": await _space_id_or_empty() if user_agent_mode() else "",
            "maxSeconds": int(CHAT_MAX_SECONDS) if transport() == "sse" else 0}


@app.get("/suggestions")
def suggestions():
    # 输入框上方的快捷指令分组（结构同官方 chatclient），默认不展示
    return {"Response": {"GroupList": []}}


@app.get("/sdk/{path:path}")
def sdk(path: str):
    file = (SDK_DIR / path).resolve()
    if not str(file).startswith(str(SDK_DIR.resolve())) or not file.is_file():
        raise HTTPException(404, "not found")
    # 入口 adp-chat.js 短缓存（便于升级），带哈希的分块长缓存
    cache = "public, max-age=300" if path in ("adp-chat.js", "core.js", "core.css", "popup.css") \
        else "public, max-age=31536000, immutable"
    media = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
    if file.suffix in (".js", ".mjs"):
        media = "text/javascript"
    return FileResponse(file, media_type=media, headers={"Cache-Control": cache,
                                                         "Access-Control-Allow-Origin": "*"})


# ---------------------------------------------------------------- 会话

def user_agent_mode() -> bool:
    """方式二默认开启「每个访客一份 Agent」（可选模型 / 技能 / 工具）；USER_AGENT=0 关闭。"""
    return adp_mode() and os.environ.get("USER_AGENT", "1") != "0"


store_errors = (StoreError,)


async def agent_of(owner: str) -> str:
    """该访客已绑定的用户态 Agent（没有则为空）；查会话列表时要带上它。"""
    if not user_agent_mode():
        return ""
    try:
        return await store.get_user_agent(owner)
    except StoreError as e:
        log.warning("load user agent failed: %s", e)
        return ""


@app.post("/adp/{action}")
async def adp_forward(action: str, request: Request):
    """官方组件里模型选择、技能、工具、连接器、知识库调用的云 API，白名单转发（见 user_agent.py）。"""
    owner = owner_of(request)
    if not user_agent_mode():
        raise HTTPException(404, "未开启")
    app_key = os.environ["ADP_APP_KEY"]
    try:
        body = await request.json()
    except ValueError:
        body = {}
    payload = body.get("Payload") if isinstance(body, dict) else None
    try:
        if action == "CopyAgentFromApp":
            # 不真的每次复制：返回该访客已绑定的 Agent，没有才复制
            agent_id = await user_agent.ensure_agent(http, store, app_key, owner)
            return {"Response": {"ParentAgentId": agent_id}}
        return {"Response": await user_agent.forward(http, store, app_key, owner, action,
                                                     payload if isinstance(payload, dict) else {})}
    except user_agent.Forbidden as e:
        raise HTTPException(403, str(e)) from None
    except tc_api.TcApiError as e:
        log.warning("user agent api failed: %s %s", e.code, e)
        return {"Response": {"Error": {"Code": e.code, "Message": str(e)}}}
    except httpx.HTTPError as e:
        log.warning("user agent api network error: %s", e)
        raise HTTPException(502, "请求失败，请重试") from None


@app.get("/agent/config")
async def get_agent_config(request: Request):
    owner = owner_of(request)
    if not user_agent_mode():
        return {"Response": {"ApplicationId": "", "AgentId": None}}
    agent_id = await store.get_user_agent(owner)
    return {"Response": {"ApplicationId": "", "AgentId": agent_id or None}}


@app.post("/agent/config")
async def save_agent_config(request: Request):
    """绑定关系只由服务端建立；这里仅确认提交的就是该访客自己的 Agent。"""
    owner = owner_of(request)
    body = await request.json()
    bound = await store.get_user_agent(owner) if user_agent_mode() else ""
    # 不接受前端指定绑定，统一返回服务端绑定的那份
    return {"Response": {"ApplicationId": body.get("ApplicationId", ""), "AgentId": bound or None}}


def adp_mode() -> bool:
    """ws 方式：会话与历史直接查 ADP。"""
    return transport() == "ws" and tc_api.configured()


async def adp_call(fn, *args):
    try:
        return await fn(http, *args)
    except tc_api.TcApiError as e:
        log.warning("ADP API failed: %s %s", e.code, e)
        raise HTTPException(502, f"查询对话记录失败：{e.code}") from None
    except httpx.HTTPError as e:
        log.warning("ADP API network error: %s", e)
        raise HTTPException(502, "查询对话记录失败，请重试") from None


async def adp_own(conv_id: str, owner: str) -> None:
    """DescribeConversationMessageList / DeleteConversation 不校验访客归属，这里先确认会话属于该访客。"""
    if not await adp_call(adp_history.owns, os.environ["ADP_APP_KEY"], owner, conv_id, await agent_of(owner)):
        raise HTTPException(404, "会话不存在")


@app.get("/conversations")
async def conversations(request: Request):
    owner = owner_of(request)
    if adp_mode():
        items = await adp_call(adp_history.list_conversations, os.environ["ADP_APP_KEY"], owner, await agent_of(owner))
        return {"conversations": [adp_history.to_conversation(c) for c in items]}
    return {"conversations": await store.list_conversations(owner)}


@app.get("/conversations/{conv_id}/records")
async def records(conv_id: str, request: Request):
    owner = owner_of(request)
    if adp_mode():
        await adp_own(conv_id, owner)
        return {"records": await adp_call(adp_history.list_records, os.environ["ADP_APP_KEY"], owner, conv_id)}
    await own_conversation(conv_id, owner)
    return {"records": await store.list_records(conv_id)}


@app.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: str, request: Request):
    owner = owner_of(request)
    if adp_mode():
        await adp_own(conv_id, owner)
        await adp_call(adp_history.delete, os.environ["ADP_APP_KEY"], conv_id)
        return {"ok": True}
    await own_conversation(conv_id, owner)
    await store.delete_conversation(conv_id)
    return {"ok": True}


def clean_contents(raw) -> list[dict]:
    out = []
    for c in raw if isinstance(raw, list) else []:
        if not isinstance(c, dict):
            continue
        if c.get("Type") == "text" and isinstance(c.get("Text"), str):
            out.append({"Type": "text", "Text": c["Text"][:20000]})
        elif c.get("Type") == "file" and isinstance(c.get("File"), dict):
            f = c["File"]
            item = {k: str(f.get(k, "") or "") for k in ("DocId", "FileName", "FileUrl", "FileType")}
            # chat/v2 要求 FileSize 为字节数（纯数字），DocId 为空时用 "0"
            item["FileSize"] = str(f.get("FileSize", "0")) if str(f.get("FileSize", "0")).isdigit() else "0"
            item["DocId"] = item["DocId"] or "0"
            out.append({"Type": "file", "File": item})
        elif c.get("Type") == "widget_action" and isinstance(c.get("WidgetAction"), dict):
            # widget 里的按钮 / 表单交互（sys.chat / sys.clarify），字段与官方 chatclient 一致
            w = dict(c["WidgetAction"])
            if not isinstance(w.get("Payload"), str):
                w["Payload"] = json.dumps(w.get("Payload") or {}, ensure_ascii=False)
            item = {k: str(w.get(k, "") or "")[:limit] for k, limit in (
                ("WidgetId", 200), ("WidgetRunId", 200), ("ActionType", 100),
                ("Payload", 20000), ("WidgetSnapshot", 200000))}
            if item["ActionType"]:
                out.append({"Type": "widget_action", "WidgetAction": item})
        elif c.get("Type") == "questionnaire" and isinstance(c.get("Questionnaire"), dict):
            # 反问澄清（AskUserQuestion）的作答：原样带回题目 + Answers，结构与官方 chatclient 一致
            q = c["Questionnaire"]
            if len(json.dumps(q, ensure_ascii=False)) <= 200000:
                out.append({"Type": "questionnaire", "Questionnaire": q})
    return out[:20]


def make_title(contents: list[dict]) -> str:
    """会话标题：取首条文字（去掉输入框插入的图片 Markdown），没有文字时用附件名。"""
    for c in contents:
        if c["Type"] == "text":
            text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", c["Text"])
            text = re.sub(r"\s+", " ", text).strip()
            if text:
                return text[:40]
    if any(c["Type"] == "widget_action" for c in contents):
        return "卡片交互"
    if any(c["Type"] == "questionnaire" for c in contents):
        return "问题澄清"
    names = [c["File"]["FileName"] for c in contents if c["Type"] == "file" and c["File"].get("FileName")]
    return ("、".join(names) or "新对话")[:40]


def sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj, ensure_ascii=False, separators=(',', ':'))}\n\n".encode()


async def save_turn(conv_id: str, owner: str, user: dict | None, bot: dict | None, status: str | None,
                    started_ms: int | None = None):
    try:
        await store.add_records(conv_id, owner, [r for r in (finalize(user), finalize(bot, status, started_ms)) if r])
        await store.touch_conversation(conv_id)
    except Exception as e:  # 存历史失败不影响已经返回给用户的回复
        log.error("save turn failed: %s", e)


@app.post("/chat")
async def chat(request: Request):
    owner = owner_of(request)
    app_key = os.environ.get("ADP_APP_KEY", "")
    if not app_key:
        raise HTTPException(503, "ADP_APP_KEY 未配置")
    if transport() != "sse":
        raise HTTPException(409, "当前为 WebSocket 直连方式，请使用 /ws/token")
    body = await request.json()
    contents = clean_contents(body.get("Contents"))
    if not contents:
        raise HTTPException(400, "消息内容为空")

    conv_id = str(body.get("ConversationId") or "")
    new_conv = None
    if conv_id:
        await own_conversation(conv_id, owner)
    else:
        conv_id = str(uuid.uuid4())
        new_conv = await store.create_conversation(conv_id, owner, make_title(contents))

    payload = {"AppKey": app_key, "ConversationId": conv_id, "VisitorId": owner, "Contents": contents,
               "Incremental": True, "Stream": "enable"}
    fallback_user = {"Role": "user", "RecordId": f"local-{uuid.uuid4().hex}", "ConversationId": conv_id,
                     "Status": "success", "StatusDesc": "",
                     "Messages": [{"Type": "question", "MessageId": f"q-{uuid.uuid4().hex}", "Name": "question",
                                   "Title": "", "Status": "success", "StatusDesc": "", "Contents": contents}]}

    started_ms = int(time.time() * 1000)

    async def stream():
        user = bot = None
        status = None
        try:
            if new_conv:
                yield sse({"Type": "adp.conversation", "Conversation": to_conversation(new_conv)})
            async with http.stream("POST", ADP_CHAT_URL, json=payload,
                                   headers={"Accept": "text/event-stream"}) as res:
                if res.status_code != 200:
                    detail = (await res.aread()).decode(errors="ignore")[:300]
                    log.warning("upstream %s: %s", res.status_code, detail)
                    status = "failed"
                    yield sse({"Type": "error", "Error": {"Code": res.status_code,
                                                         "Message": f"对话服务返回错误（HTTP {res.status_code}）"}})
                    return
                deadline = time.monotonic() + CHAT_MAX_SECONDS
                # 单独的读取任务 + 队列：Agent 执行工具时上游可能长时间不发数据，
                # 这期间要定时发心跳防止网关按空闲断开，并且到时长上限也要能及时截断
                queue: asyncio.Queue = asyncio.Queue()

                async def pump():
                    try:
                        async for ln in res.aiter_lines():
                            await queue.put(ln)
                        await queue.put(None)
                    except BaseException as exc:  # noqa: BLE001
                        await queue.put(exc)

                reader = asyncio.get_event_loop().create_task(pump())
                try:
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            # 云函数快到超时：主动截断，保证已收到的内容能存进历史，并告诉用户原因
                            status = "stop"
                            yield sse({"Type": "error", "Error": {
                                "Code": "ReplyTimeLimit",
                                "Message": f"回复超过 {int(CHAT_MAX_SECONDS)} 秒时长上限，已截断"}})
                            return
                        try:
                            line = await asyncio.wait_for(queue.get(), timeout=min(HEARTBEAT_SECONDS, remaining))
                        except asyncio.TimeoutError:
                            yield b": ping\n\n"
                            continue
                        if line is None:
                            break
                        if isinstance(line, BaseException):
                            if isinstance(line, httpx.HTTPError):
                                raise line
                            raise httpx.ReadError(str(line))
                        if not line.startswith("data:"):
                            continue
                        try:
                            event = json.loads(line[5:])
                        except ValueError:
                            continue
                        t = event.get("Type")
                        if t == "request_ack":
                            user = apply_event(event, user)
                        elif t == "error":
                            status = "failed"
                        else:
                            bot = apply_event(event, bot)
                        yield (line + "\n\n").encode()
                finally:
                    reader.cancel()
        except httpx.HTTPError as e:
            status = "failed"
            log.warning("upstream error: %s", e)
            yield sse({"Type": "error", "Error": {"Code": 502, "Message": "对话服务连接中断，请重试"}})
        finally:
            # 用户点停止或关页面时生成器会被取消，用独立任务保证已收到的内容也能存进历史；
            # 正常结束时等它存完再结束响应（云函数在响应结束后可能被冻结）
            task = asyncio.get_event_loop().create_task(
                save_turn(conv_id, owner, user or fallback_user, bot, status, started_ms))
            _background.add(task)
            task.add_done_callback(_background.discard)
            try:
                await asyncio.shield(task)
            except BaseException:  # noqa: BLE001 - 被取消时不再等待
                pass

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- WebSocket 直连（ws 方式）

@app.post("/ws/token")
async def ws_token(request: Request):
    """换取一次性 WebSocket 令牌。新会话在这里登记（用于会话列表和归属校验）。"""
    owner = owner_of(request)
    app_key = os.environ.get("ADP_APP_KEY", "")
    if not app_key:
        raise HTTPException(503, "ADP_APP_KEY 未配置")
    if transport() != "ws" or not tc_api.configured():
        raise HTTPException(409, "当前未启用 WebSocket 直连（需要配置 TC_SECRET_ID / TC_SECRET_KEY）")
    body = await request.json()
    conv_id = str(body.get("ConversationId") or "")
    new_conv = None
    if conv_id:
        # 已有会话必须属于该访客；ADP 里还没有消息的会话（首条消息发送失败）也允许继续使用
        if not await adp_call(adp_history.owns, app_key, owner, conv_id, await agent_of(owner)):
            if await adp_call(adp_history.has_messages, app_key, owner, conv_id):
                raise HTTPException(404, "会话不存在")
    else:
        conv_id = ""
        if user_agent_mode():
            # 用户态 Agent：先在 ADP 建会话并绑定该访客的 Agent，对话按访客自己的模型 / 技能 / 工具运行
            try:
                agent_id = await user_agent.ensure_agent(http, store, app_key, owner)
                conv_id = await user_agent.create_conversation(http, app_key, owner, agent_id)
            except (tc_api.TcApiError, httpx.HTTPError, store_errors) as e:
                log.warning("user agent conversation failed, fallback to app agent: %s", e)
        # 否则会话由 ADP 在收到第一条消息时创建，这里只返回给前端用于侧边栏立即显示
        conv_id = conv_id or str(uuid.uuid4())
        new_conv = adp_history.new_conversation(conv_id, make_title(clean_contents(body.get("Contents"))))
    try:
        token = await tc_api.create_ws_token(http, app_key, owner)
    except tc_api.TcApiError as e:
        log.warning("CreateWebSocketToken failed: %s %s", e.code, e)
        raise HTTPException(502, f"获取对话令牌失败：{e.code}") from None
    except httpx.HTTPError as e:
        log.warning("CreateWebSocketToken network error: %s", e)
        raise HTTPException(502, "获取对话令牌失败，请重试") from None
    return {"token": token, "url": ADP_WS_URL, "conversationId": conv_id, "visitorId": owner,
            "conversation": new_conv}


@app.post("/conversations/{conv_id}/turn")
async def save_ws_turn(conv_id: str, request: Request):
    """兼容旧版 SDK：ws 方式的历史以 ADP 为准，不再由浏览器提交存档。"""
    owner_of(request)
    return {"ok": True, "skipped": True}


# ---------------------------------------------------------------- 文件

class LocalStorage:
    """本地开发替身：写到系统临时目录，通过 /local-files/ 访问。"""

    def __init__(self, request: Request):
        self.request = request

    def upload_object(self, key: str, content: bytes, _content_type: str) -> None:
        path = LOCAL_FILES / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def confirm(self, key: str, size: int, content_type: str) -> dict:
        url = str(self.request.url_for("local_files", key=key))
        return {"key": key, "url": url, "size": size, "content_type": content_type}


def storage_for(request: Request):
    if LOCAL_DEV and not os.environ.get("CLOUDBASE_ENV_ID"):
        return LocalStorage(request)
    return StorageClient.from_env()


def safe_name(name: str) -> str:
    name = os.path.basename(name or "file").strip() or "file"
    name = re.sub(r"[^\w.\-()（）\u4e00-\u9fff ]", "_", name).strip(" .") or "file"
    stem, ext = os.path.splitext(name)
    return stem[:80] + ext[:12]


@app.post("/upload")
async def upload(request: Request, filename: str):
    owner_of(request)
    content = bytearray()
    try:
        async def read():
            async for chunk in request.stream():
                content.extend(chunk)
        await asyncio.wait_for(read(), timeout=60)
    except asyncio.TimeoutError:
        raise HTTPException(408, "接收文件超时，请检查网络") from None
    if not content:
        raise HTTPException(400, "文件内容为空")
    name = safe_name(filename)
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower() \
        or mimetypes.guess_type(name)[0] or "application/octet-stream"
    key = f"chat-files/{datetime.now():%Y%m%d}/{uuid.uuid4().hex}/{name}"
    client = storage_for(request)

    def put():
        client.upload_object(key, bytes(content), content_type)
        return client.confirm(key, len(content), content_type)

    result = await asyncio.wait_for(run_in_threadpool(put), timeout=60)
    return {"url": result["url"], "name": name, "size": len(content), "type": content_type}


FILE_HOST_SUFFIXES = (".myqcloud.com", ".tencentcos.cn", ".tencentcos.com", ".tcloudbasegateway.com",
                      ".tcb.qcloud.la", ".file.myqcloud.com") + tuple(
    h.strip() for h in os.environ.get("FILE_PROXY_HOSTS", "").split(",") if h.strip())
FILE_PROXY_MAX = int(os.environ.get("FILE_PROXY_MAX_MB", "50")) * 1024 * 1024


@app.get("/file")
async def file_proxy(url: str):
    """预览中转：浏览器直接读取云存储上的文本 / HTML 会被跨域拦截，由这里转一手。只放行云存储域名。"""
    u = urlparse(url)
    host = (u.hostname or "").lower()
    allowed = u.scheme == "https" and any(host.endswith(s) or host == s.lstrip(".") for s in FILE_HOST_SUFFIXES)
    if LOCAL_DEV and u.scheme in ("http", "https") and host in ("127.0.0.1", "localhost"):
        allowed = True
    if not allowed:
        raise HTTPException(403, "不支持预览该来源的文件")
    res = await http.send(http.build_request("GET", url), stream=True)
    if res.status_code != 200:
        await res.aclose()
        raise HTTPException(res.status_code if res.status_code in (403, 404) else 502, "文件读取失败")
    size = int(res.headers.get("content-length") or 0)
    if size > FILE_PROXY_MAX:
        await res.aclose()
        raise HTTPException(413, "文件过大，请下载后查看")

    async def body():
        sent = 0
        try:
            async for chunk in res.aiter_bytes():
                sent += len(chunk)
                if sent > FILE_PROXY_MAX:
                    break
                yield chunk
        finally:
            await res.aclose()

    return StreamingResponse(body(), media_type=res.headers.get("content-type", "application/octet-stream"),
                             headers={"Cache-Control": "private, max-age=300"})


if LOCAL_DEV:
    @app.get("/local-files/{key:path}")
    def local_files(key: str):
        path = (LOCAL_FILES / key).resolve()
        if not str(path).startswith(str(LOCAL_FILES.resolve())) or not path.is_file():
            raise HTTPException(404, "not found")
        return FileResponse(path)
