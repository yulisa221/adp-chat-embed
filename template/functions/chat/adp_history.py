"""WebSocket 直连方式下的会话列表与历史消息：直接查 ADP，不在站点数据库存副本。

用到的 ADP 云 API（adp.tencentcloudapi.com，Version 2026-05-20，Type=5 API 接入）：
- DescribeConversationList        按 UserId（访客）列出会话，ADP 侧已按访客隔离
- DescribeConversationMessageList 查会话消息。注意：该接口不校验 UserId 与会话的归属，
                                  所以读历史 / 删除前，必须先确认会话在该访客的会话列表里
- DeleteConversation              删除会话（同样不带 UserId，先校验归属）
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime

import httpx

import tc_api

CONV_PAGE = 50          # DescribeConversationList 每页条数
CONV_MAX_PAGES = 10     # 列表最多翻 10 页（500 个会话）
MSG_PAGE = 50           # DescribeConversationMessageList 每页轮数（按「一问一答」计，最大 50）
MSG_MAX_PAGES = 20      # 单个会话最多翻 20 页（1000 轮）
DROP_KEYS = ("ContentList",)  # 与 Contents 重复的字段，去掉以减小响应体积


def _base(app_key: str, user_id: str) -> dict:
    return {"Type": 5, "AppKey": app_key, "UserId": user_id[:64]}


def _ts(value) -> int:
    """ADP 时间（RFC3339 字符串或毫秒时间戳字符串）→ 秒级时间戳。"""
    if not value:
        return 0
    s = str(value)
    if s.isdigit():
        n = int(s)
        return n // 1000 if n > 10**12 else n
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


def to_conversation(c: dict) -> dict:
    """转换成前端 HistoryList 使用的 ChatConversation 结构。"""
    created = _ts(c.get("CreateTime"))
    active = max(_ts(c.get("LastMessageTime")), _ts(c.get("UpdateTime")), created)
    return {"Id": c.get("ConversationId", ""), "AccountId": "", "Title": c.get("Title") or "新对话",
            "CreatedAt": created, "LastActiveAt": active, "ApplicationId": ""}


def new_conversation(conv_id: str, title: str) -> dict:
    now = int(time.time())
    return {"Id": conv_id, "AccountId": "", "Title": title or "新对话", "CreatedAt": now,
            "LastActiveAt": now, "ApplicationId": ""}


async def _list(http: httpx.AsyncClient, base: dict) -> list[dict]:
    out: list[dict] = []
    for page in range(CONV_MAX_PAGES):
        res = await tc_api.call(http, "DescribeConversationList",
                                {**base, "Offset": page * CONV_PAGE, "Limit": CONV_PAGE})
        items = res.get("Conversations") or res.get("ConversationList") or []
        out.extend(items)
        if len(items) < CONV_PAGE or len(out) >= int(res.get("TotalCount") or 0):
            break
    return out


async def list_conversations(http: httpx.AsyncClient, app_key: str, user_id: str, agent_id: str = "") -> list[dict]:
    """访客的会话：应用 Agent 上的会话 + 访客用户态 Agent（agent_id）上的会话（ADP 需带 AgentId 才查得到）。"""
    base = _base(app_key, user_id)
    if not agent_id:
        return await _list(http, base)
    a, b = await asyncio.gather(_list(http, base), _list(http, {**base, "AgentId": agent_id}))
    seen: dict[str, dict] = {}
    for c in a + b:
        seen.setdefault(c.get("ConversationId", ""), c)
    return sorted(seen.values(), key=lambda c: to_conversation(c)["LastActiveAt"], reverse=True)


async def owns(http: httpx.AsyncClient, app_key: str, user_id: str, conv_id: str, agent_id: str = "") -> bool:
    return any(c.get("ConversationId") == conv_id
               for c in await list_conversations(http, app_key, user_id, agent_id))


async def has_messages(http: httpx.AsyncClient, app_key: str, user_id: str, conv_id: str) -> bool:
    res = await tc_api.call(http, "DescribeConversationMessageList",
                            {**_base(app_key, user_id), "ConversationId": conv_id, "Limit": 1})
    return bool(res.get("Messages") or res.get("MessageList"))


def _blank_reply(m: dict) -> bool:
    """ADP 每条回复后会多存一条空的 reply 消息（流式结束标记），渲染出来是一段空白，过滤掉。"""
    if m.get("Type") != "reply":
        return False
    contents = m.get("Contents") or []
    return all(c.get("Type") == "text" and not (c.get("Text") or "").strip() for c in contents)


def _group(messages: list[dict], summaries: dict[str, dict]) -> list[dict]:
    """ADP 返回的是平铺的消息，按 RecordId 合并成前端使用的 Record（一条用户提问 / 一条助手回复）。"""
    records: list[dict] = []
    index: dict[str, dict] = {}
    for m in messages:
        rid = m.get("RecordId") or ""
        msg = {k: v for k, v in m.items() if k not in DROP_KEYS}
        rec = index.get(rid)
        if rec is None:
            summary = summaries.get(rid) or {}
            status = summary.get("Status") or m.get("Status") or "success"
            rec = {"Role": m.get("Role", "assistant"), "RecordId": rid, "ConversationId": m.get("ConversationId", ""),
                   "Status": status, "StatusDesc": m.get("StatusDesc", ""), "Messages": [],
                   "ExtraInfo": {"RelatedRecordId": (m.get("ExtraInfo") or {}).get("RelatedRecordId", ""),
                                 "StartTime": (m.get("ExtraInfo") or {}).get("StartTime", ""),
                                 "Elapsed": ((summary.get("TimeUsage") or {}).get("Elapsed") or "")},
                   "Timestamp": (m.get("ExtraInfo") or {}).get("StartTime", "")}
            index[rid] = rec
            records.append(rec)
        # 空 reply 只用来建记录（保留「处理中」状态），不作为消息展示
        if not _blank_reply(m):
            rec["Messages"].append(msg)
    return records


async def list_records(http: httpx.AsyncClient, app_key: str, user_id: str, conv_id: str) -> list[dict]:
    pages: list[list[dict]] = []
    summaries: dict[str, dict] = {}
    anchor = ""
    for _ in range(MSG_MAX_PAGES):
        params = {**_base(app_key, user_id), "ConversationId": conv_id, "Limit": MSG_PAGE}
        if anchor:
            params.update({"RecordId": anchor, "RecordQueryDirection": 1})  # 从锚点向前查更早的
        res = await tc_api.call(http, "DescribeConversationMessageList", params)
        msgs = res.get("Messages") or res.get("MessageList") or []
        pages.append(msgs)
        for s in res.get("RecordSummaryList") or []:
            if s.get("RecordId"):
                summaries[s["RecordId"]] = s
        if not res.get("HasMoreBefore") or not res.get("FirstRecordId") or not msgs:
            break
        anchor = res["FirstRecordId"]
    seen: set[str] = set()
    flat: list[dict] = []
    for msgs in reversed(pages):  # 早的页在前
        for m in msgs:
            key = m.get("MessageId") or id(m)
            if key not in seen:
                seen.add(key)
                flat.append(m)
    return _group(flat, summaries)


async def delete(http: httpx.AsyncClient, app_key: str, conv_id: str) -> None:
    await tc_api.call(http, "DeleteConversation", {"Type": 5, "AppKey": app_key, "ConversationId": conv_id})


# ---------------------------------------------------------------- 应用信息（名称 / 头像 / 欢迎语 / 示例问题）

_APP_CACHE: dict = {"at": 0.0, "data": None, "app_id": "", "space_id": ""}
APP_CACHE_SECONDS = 300


async def resolve_app_id(http: httpx.AsyncClient, app_key: str) -> str:
    """AppKey → AppId：CreateWebSocketToken 的返回值里带 AppId（进程内缓存）。"""
    if not _APP_CACHE["app_id"]:
        res = await tc_api.call(http, "CreateWebSocketToken", {"Type": 5, "AppKey": app_key, "UserId": "app-info"})
        _APP_CACHE["app_id"] = str(res.get("AppId") or "")
    return _APP_CACHE["app_id"]


async def resolve_space_id(http: httpx.AsyncClient, app_key: str) -> str:
    """应用所在空间（技能广场、连接器 / 工具市场都按空间查询；传错会报「当前空间下没有该用户信息」）。"""
    if not _APP_CACHE["space_id"]:
        app_id = await resolve_app_id(http, app_key)
        for domain in (2, 1):
            try:
                app = (await tc_api.call(http, "DescribeApp", {"AppId": app_id, "Domain": domain})).get("App") or {}
            except tc_api.TcApiError:
                app = {}
            sid = app.get("SpaceId") or (app.get("Metadata") or {}).get("SpaceId") or ""
            if sid:
                _APP_CACHE["space_id"] = sid
                break
    return _APP_CACHE["space_id"]


async def app_info(http: httpx.AsyncClient, app_key: str) -> dict | None:
    """查 ADP 发布域的应用配置。AppId 由 CreateWebSocketToken 的返回值得到（只有 AppKey 也能拿到），结果缓存 5 分钟。"""
    now = time.time()
    if _APP_CACHE["data"] is not None and now - _APP_CACHE["at"] < APP_CACHE_SECONDS:
        return _APP_CACHE["data"]
    app_id = await resolve_app_id(http, app_key)
    if not app_id:
        return None
    app = None
    for domain in (2, 1):  # 先发布域，未发布时回退开发域
        try:
            app = (await tc_api.call(http, "DescribeApp", {"AppId": app_id, "Domain": domain})).get("App")
        except tc_api.TcApiError:
            app = None
        if app:
            break
    if not app:
        return None
    _APP_CACHE["space_id"] = _APP_CACHE["space_id"] or app.get("SpaceId") or ""
    meta = app.get("Metadata") or {}
    greeting = ((app.get("Config") or {}).get("Greeting") or {})
    data = {
        "name": meta.get("Name") or "",
        "avatar": meta.get("Avatar") or "",
        "greeting": greeting.get("Greeting") or "",
        "questions": [q for q in (greeting.get("OpeningQuestionList") or []) if isinstance(q, str) and q.strip()][:6],
    }
    _APP_CACHE.update(at=now, data=data)
    return data
