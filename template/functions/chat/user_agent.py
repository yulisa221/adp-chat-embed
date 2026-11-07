"""方式二（WebSocket 直连）：每个访客 / 用户一份 ADP 用户态 Agent，对齐官方 chat-client 的 Claw 模式。

- 首次使用时 CopyAgentFromApp(Kind=1) 从应用复制一份 Agent，绑定到访客（站点数据库 adp_chat_user_agents）。
- 新会话用 CreateConversation(Type=5, AgentId) 创建，对话就按这份 Agent 的模型 / 技能 / 工具运行。
- 对话界面里的模型选择、技能、工具、连接器、知识库，官方组件通过 POST /adp/<Action> 调云 API，
  这里做白名单转发：AppId / AppBizId / AgentId 一律改写成本站应用和该访客自己的 Agent，
  ModifyAgent 只允许改模型、技能、工具、插件，不能改人设（Instructions）等应用配置。

前提：应用是 Claw 模式，且开启了「允许在对话中动态修改配置」。
"""
from __future__ import annotations

import asyncio
import json
import os

import httpx

import adp_history
import tc_api

# Action → (service, version)；与官方 chat-client 的 action_version/ChinaTencentCloud.json 一致
ADP = ("adp", "2026-05-20")
LKE = ("lke", "2025-11-12")
ACTIONS: dict[str, tuple[str, str]] = {
    # Agent 配置
    "DescribeAgentDetail": ADP,
    "ModifyAgent": ADP,
    # 模型
    "ListModel": LKE,
    # 技能
    "DescribeSkillCategoryList": ADP,
    "DescribeSkillSummaryList": ADP,
    # 工具 / 连接器
    "DescribePluginSummaryList": ADP,
    "DescribePluginCategoryList": ADP,
    "DescribePlugin": ADP,
    "ModifyAgentToolList": LKE,
    "BindAgentTool": LKE,
    "UnbindAgentTool": LKE,
    # 知识库
    "ListReferShareKnowledge": ("lke", "2023-11-30"),
    "GetKBDefaultConfig": ("lke", "2023-11-30"),
}
HOSTS = {"adp": "adp.tencentcloudapi.com", "lke": "lke.tencentcloudapi.com"}
SPACE_ACTIONS = {"DescribeSkillSummaryList", "DescribePluginSummaryList"}
# 作用在某个 Agent 上的操作：强制改写成该访客自己的 Agent
AGENT_ACTIONS = {"DescribeAgentDetail", "ModifyAgent", "ModifyAgentToolList", "BindAgentTool", "UnbindAgentTool"}

# ModifyAgent 允许的字段（大小写、下划线不敏感）
MODIFY_PATHS = {"model", "skilllist", "toollist", "pluginlist"}

_locks: dict[str, asyncio.Lock] = {}


class Forbidden(Exception):
    pass


async def ensure_agent(http: httpx.AsyncClient, store, app_key: str, owner: str) -> str:
    """返回该访客的用户态 Agent，没有就复制一份并绑定（同一访客并发请求只复制一次）。"""
    agent_id = await store.get_user_agent(owner)
    if agent_id:
        return agent_id
    lock = _locks.setdefault(owner, asyncio.Lock())
    async with lock:
        agent_id = await store.get_user_agent(owner)
        if agent_id:
            return agent_id
        app_id = await adp_history.resolve_app_id(http, app_key)
        res = await tc_api.call(http, "CopyAgentFromApp", {"AppId": app_id, "Kind": 1})
        agent_id = str(res.get("ParentAgentId") or "")
        if not agent_id:
            raise tc_api.TcApiError("EmptyAgent", "复制用户 Agent 失败")
        await store.set_user_agent(owner, agent_id)
        # 并发时以数据库里先写入的那份为准（多出来的那份 Agent 闲置，不影响使用）
        agent_id = await store.get_user_agent(owner) or agent_id
    _locks.pop(owner, None)
    return agent_id


async def create_conversation(http: httpx.AsyncClient, app_key: str, owner: str, agent_id: str) -> str:
    app_id = await adp_history.resolve_app_id(http, app_key)
    res = await tc_api.call(http, "CreateConversation", {
        "Type": 5, "AppId": app_id, "AppKey": app_key, "UserId": owner[:64], "AgentId": agent_id})
    conv_id = str(res.get("ConversationId") or "")
    if not conv_id:
        raise tc_api.TcApiError("EmptyConversation", "创建会话失败")
    return conv_id


def _norm(path: str) -> str:
    return path.replace("_", "").replace(".", "").lower()


async def forward(http: httpx.AsyncClient, store, app_key: str, owner: str, action: str, payload: dict) -> dict:
    """白名单转发官方组件的 /adp/<Action> 请求，返回云 API 的 Response（含 Error 时原样返回）。"""
    if action not in ACTIONS:
        raise Forbidden(f"不支持的操作：{action}")
    payload = dict(payload or {})
    app_id = await adp_history.resolve_app_id(http, app_key)
    agent_id = await ensure_agent(http, store, app_key, owner)

    # 归属改写：只能操作本站应用和自己的 Agent
    if action in AGENT_ACTIONS:
        payload["AppId"] = app_id
        payload["AgentId"] = agent_id
    for k in ("AppId", "AppBizId"):
        if k in payload:
            payload[k] = app_id
    # 技能 / 连接器 / 工具市场按空间查询：统一用应用所在空间（组件默认传 default_space 会查不到）
    if "SpaceId" in payload or action in SPACE_ACTIONS:
        payload["SpaceId"] = await adp_history.resolve_space_id(http, app_key)
    if action == "ListReferShareKnowledge":
        payload = {"AppBizId": app_id}
    if action == "ModifyAgent":
        paths = ((payload.get("UpdateMask") or {}).get("Paths") or [])
        if not paths or any(_norm(str(p)) not in MODIFY_PATHS for p in paths):
            raise Forbidden("只允许修改模型、技能、工具")

    service, version = ACTIONS[action]
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    host = HOSTS[service]
    headers = tc_api.sign_headers(action, body, service=service, host=host, version=version,
                                  region=os.environ.get("TC_REGION", "ap-guangzhou"),
                                  secret_id=os.environ["TC_SECRET_ID"], secret_key=os.environ["TC_SECRET_KEY"])
    res = await http.post(f"https://{host}", content=body.encode(), headers=headers, timeout=20)
    return res.json().get("Response", {})
