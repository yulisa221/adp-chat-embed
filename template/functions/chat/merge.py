"""把 ADP chat/v2 的流式事件合并成完整的 Record（与前端 applySseEventToRecord 同一套规则）。

后端在转发流式回复的同时用它累积结果，回复结束后把用户消息和助手回复各存一条记录，
历史接口直接返回这两条 Record，前端用同一个 ChatItem 渲染，和实时回复的样子一致。
"""
from __future__ import annotations

import copy
from typing import Any

Record = dict[str, Any]


def apply_event(event: dict, current: Record | None) -> Record | None:
    t = event.get("Type")
    if t == "request_ack":
        return _merge(current, event.get("RequestAck") or {}, True)
    if t in ("response.created", "response.processing", "response.completed"):
        return _merge(current, event.get("Response") or {}, t == "response.completed")
    if t in ("message.added", "message.processing", "message.done"):
        return _upsert_message(current, event.get("Message") or {})
    if t == "content.added":
        return _add_content(current, event.get("MessageId", ""), event.get("ContentIndex", 0), event.get("Content") or {})
    if t == "reference.added":
        return _add_reference(current, event.get("MessageId", ""), event.get("ContentIndex", 0), event.get("Reference") or {})
    if t == "text.delta":
        return _append_text(current, event.get("MessageId", ""), event.get("ContentIndex", 0), event.get("Text", ""))
    return current


def _merge(current: Record | None, incoming: Record, replace_messages: bool) -> Record:
    merged = {**(current or incoming), **incoming}
    if current:
        for key in ("Messages", "Procedures", "StatInfo", "ExtraInfo"):
            if incoming.get(key) is None and current.get(key) is not None:
                merged[key] = current[key]
    if replace_messages and incoming.get("Messages") is not None:
        merged["Messages"] = incoming["Messages"]
    return merged


def _upsert_message(current: Record | None, incoming: dict) -> Record | None:
    if current is None:
        return None
    messages = list(current.get("Messages") or [])
    for i, msg in enumerate(messages):
        if msg.get("MessageId") == incoming.get("MessageId"):
            merged = {**msg, **incoming}
            if incoming.get("Contents") is None:
                merged["Contents"] = msg.get("Contents")
            if incoming.get("ExtraInfo"):
                merged["ExtraInfo"] = {**(msg.get("ExtraInfo") or {}), **incoming["ExtraInfo"]}
            else:
                merged["ExtraInfo"] = msg.get("ExtraInfo")
            messages[i] = merged
            break
    else:
        messages.append(incoming)
    return {**current, "Messages": messages}


def _ensure_message(current: Record, message_id: str):
    messages = list(current.get("Messages") or [])
    for i, msg in enumerate(messages):
        if msg.get("MessageId") == message_id:
            return messages, i
    messages.append({"MessageId": message_id, "Type": "notice", "Name": "", "Title": "",
                     "Status": "processing", "StatusDesc": "", "Contents": []})
    return messages, len(messages) - 1


def _set_content(current: Record, message_id: str, index: int, fn) -> Record:
    messages, mi = _ensure_message(current, message_id)
    msg = dict(messages[mi])
    contents = list(msg.get("Contents") or [])
    while len(contents) <= index:
        contents.append(None)
    contents[index] = fn(contents[index])
    msg["Contents"] = contents
    messages[mi] = msg
    return {**current, "Messages": messages}


def _add_content(current, message_id, index, content):
    if current is None:
        return None
    return _set_content(current, message_id, index, lambda old: {**old, **content} if old else content)


def _append_text(current, message_id, index, text):
    if current is None:
        return None

    def fn(old):
        base = old or {"Type": "text", "Text": ""}
        return {**base, "Text": (base.get("Text") or "") + (text or "")}

    return _set_content(current, message_id, index, fn)


def _ref_key(ref: dict) -> str:
    doc, qa = ref.get("DocRefer") or {}, ref.get("QaRefer") or {}
    return str(ref.get("Id") or ref.get("ReferBizId") or doc.get("ReferenceId") or doc.get("ReferBizId")
               or qa.get("ReferBizId") or ref.get("Url") or doc.get("Url")
               or f"{ref.get('Index', '')}:{ref.get('Name', '')}")


def _add_reference(current, message_id, index, ref):
    if current is None:
        return None

    def fn(old):
        base = old or {"Type": "text", "Text": ""}
        refs = list(base.get("References") or [])
        key = _ref_key(ref)
        for i, r in enumerate(refs):
            if _ref_key(r) == key:
                refs[i] = {**r, **ref}
                break
        else:
            refs.append(ref)
        return {**base, "References": refs}

    return _set_content(current, message_id, index, fn)


def finalize(record: Record | None, status: str | None = None, started_ms: int | None = None) -> Record | None:
    """回复中断（用户停止、上游断开）时，把仍是「处理中」的状态收尾，避免历史里一直转圈。
    started_ms：本轮开始时间（毫秒），写入 ExtraInfo.StartTime / Elapsed，供回复时间与「已处理 XX 秒」展示。"""
    if record is None:
        return None
    rec = copy.deepcopy(record)
    if started_ms:
        import time as _time
        extra = dict(rec.get("ExtraInfo") or {})
        extra.setdefault("StartTime", str(started_ms))
        extra.setdefault("Elapsed", str(int(_time.time() * 1000) - started_ms))
        rec["ExtraInfo"] = extra
    if status:
        rec["Status"] = status
    elif rec.get("Status") == "processing":
        rec["Status"] = "success"
    for msg in rec.get("Messages") or []:
        msg["Contents"] = [c for c in (msg.get("Contents") or []) if c is not None]
        if msg.get("Status") == "processing":
            msg["Status"] = "success"
    return rec
