"""会话与消息记录的存取。

线上：通过站点数据库的 PostgREST HTTP 接口读写（CLOUDBASE_* 由平台自动注入，不走 TCP）。
本地开发：设置 LOCAL_DEV=1 时用进程内存替身，仅用于本机调试，不能用于线上。
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from urllib.parse import quote

import httpx

CONV = "adp_chat_conversations"
REC = "adp_chat_records"
AGENTS = "adp_chat_user_agents"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts(value) -> int:
    if not value:
        return int(time.time())
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return int(time.time())


def to_conversation(row: dict) -> dict:
    """转换成前端 HistoryList 使用的 ChatConversation 结构。"""
    return {"Id": row["id"], "AccountId": "", "Title": row.get("title") or "新对话",
            "CreatedAt": _ts(row.get("created_at")), "LastActiveAt": _ts(row.get("updated_at")),
            "ApplicationId": ""}


class StoreError(Exception):
    pass


class PostgrestStore:
    def __init__(self) -> None:
        env = os.environ["CLOUDBASE_ENV_ID"]
        region = os.environ.get("CLOUDBASE_REGION", "ap-shanghai")
        host = "api.intl.tcloudbasegateway.com" if not region.startswith(
            ("ap-shanghai", "ap-guangzhou", "ap-beijing", "ap-nanjing", "ap-chengdu", "ap-chongqing", "ap-shenzhen")
        ) else "api.tcloudbasegateway.com"
        self.base = f"https://{env}.{host}/v1/rdb/rest"
        self.headers = {"Authorization": f"Bearer {os.environ['CLOUDBASE_APIKEY']}",
                        "Content-Type": "application/json"}
        self.client = httpx.AsyncClient(timeout=15)

    async def _req(self, method: str, table: str, query: str = "", json=None, prefer: str = ""):
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        res = await self.client.request(method, f"{self.base}/{table}{'?' + query if query else ''}",
                                        headers=headers, json=json)
        if res.status_code >= 300:
            raise StoreError(f"数据库请求失败（HTTP {res.status_code}）：{res.text[:200]}")
        return res.json() if res.content else None

    @staticmethod
    def _eq(v: str) -> str:
        return "eq." + quote(v, safe="")

    async def list_conversations(self, owner: str) -> list[dict]:
        rows = await self._req("GET", CONV, f"select=id,title,created_at,updated_at&owner={self._eq(owner)}"
                                            "&order=updated_at.desc&limit=200")
        return [to_conversation(r) for r in rows or []]

    async def get_conversation(self, conv_id: str) -> dict | None:
        rows = await self._req("GET", CONV, f"select=*&id={self._eq(conv_id)}&limit=1")
        return rows[0] if rows else None

    async def create_conversation(self, conv_id: str, owner: str, title: str) -> dict:
        now = _now()
        rows = await self._req("POST", CONV, json={"id": conv_id, "owner": owner, "title": title,
                                                   "created_at": now, "updated_at": now},
                               prefer="return=representation")
        return rows[0]

    async def touch_conversation(self, conv_id: str) -> None:
        await self._req("PATCH", CONV, f"id={self._eq(conv_id)}", json={"updated_at": _now()})

    async def delete_conversation(self, conv_id: str) -> None:
        await self._req("DELETE", REC, f"conversation_id={self._eq(conv_id)}")
        await self._req("DELETE", CONV, f"id={self._eq(conv_id)}")

    async def list_records(self, conv_id: str) -> list[dict]:
        rows = await self._req("GET", REC, f"select=data&conversation_id={self._eq(conv_id)}&order=id.asc&limit=1000")
        return [r["data"] for r in rows or []]

    async def add_records(self, conv_id: str, owner: str, records: list[dict]) -> None:
        if records:
            await self._req("POST", REC, json=[{"conversation_id": conv_id, "owner": owner,
                                                "role": r.get("Role", ""), "data": r} for r in records])

    async def get_user_agent(self, owner: str) -> str:
        rows = await self._req("GET", AGENTS, f"select=agent_id&owner={self._eq(owner)}&limit=1")
        return rows[0]["agent_id"] if rows else ""

    async def set_user_agent(self, owner: str, agent_id: str) -> None:
        # 先写入者为准：多个云函数实例并发复制时，不覆盖已有绑定
        await self._req("POST", AGENTS, "on_conflict=owner", json={"owner": owner, "agent_id": agent_id},
                        prefer="resolution=ignore-duplicates")


class MemoryStore:
    """本地开发替身：进程内存，重启即丢。"""

    def __init__(self) -> None:
        self.convs: dict[str, dict] = {}
        self.records: dict[str, list[dict]] = {}
        self.agents: dict[str, str] = {}

    async def list_conversations(self, owner):
        rows = sorted((c for c in self.convs.values() if c["owner"] == owner),
                      key=lambda c: c["updated_at"], reverse=True)
        return [to_conversation(r) for r in rows]

    async def get_conversation(self, conv_id):
        return self.convs.get(conv_id)

    async def create_conversation(self, conv_id, owner, title):
        now = _now()
        self.convs[conv_id] = {"id": conv_id, "owner": owner, "title": title, "created_at": now, "updated_at": now}
        return self.convs[conv_id]

    async def touch_conversation(self, conv_id):
        if conv_id in self.convs:
            self.convs[conv_id]["updated_at"] = _now()

    async def delete_conversation(self, conv_id):
        self.convs.pop(conv_id, None)
        self.records.pop(conv_id, None)

    async def list_records(self, conv_id):
        return list(self.records.get(conv_id, []))

    async def add_records(self, conv_id, owner, records):
        self.records.setdefault(conv_id, []).extend(records)

    async def get_user_agent(self, owner):
        return self.agents.get(owner, "")

    async def set_user_agent(self, owner, agent_id):
        self.agents.setdefault(owner, agent_id)


def create_store():
    if os.environ.get("CLOUDBASE_ENV_ID") and os.environ.get("CLOUDBASE_APIKEY"):
        return PostgrestStore()
    if os.environ.get("LOCAL_DEV") == "1":
        return MemoryStore()
    raise RuntimeError("站点数据库运行时配置未就绪（缺少 CLOUDBASE_ENV_ID / CLOUDBASE_APIKEY）")
