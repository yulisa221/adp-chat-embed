"""腾讯云 API 3.0 调用（TC3-HMAC-SHA256 签名），只在「WebSocket 直连」方案里使用。

密钥从环境变量 TC_SECRET_ID / TC_SECRET_KEY 读取，只在云函数里使用，不会下发到浏览器。
建议使用只授权了 ADP 相关接口的子账号密钥。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time

import httpx


class TcApiError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sign_headers(action: str, payload: str, *, service: str, host: str, version: str, region: str,
                 secret_id: str, secret_key: str, ts: int | None = None) -> dict[str, str]:
    ts = ts or int(time.time())
    date = time.strftime("%Y-%m-%d", time.gmtime(ts))
    canonical = ("POST\n/\n\n"
                 f"content-type:application/json\nhost:{host}\nx-tc-action:{action.lower()}\n\n"
                 "content-type;host;x-tc-action\n"
                 f"{hashlib.sha256(payload.encode()).hexdigest()}")
    scope = f"{date}/{service}/tc3_request"
    to_sign = f"TC3-HMAC-SHA256\n{ts}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
    key = _hmac(_hmac(_hmac(("TC3" + secret_key).encode(), date), service), "tc3_request")
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return {
        "Content-Type": "application/json",
        "Host": host,
        "X-TC-Action": action,
        "X-TC-Version": version,
        "X-TC-Region": region,
        "X-TC-Timestamp": str(ts),
        "Authorization": (f"TC3-HMAC-SHA256 Credential={secret_id}/{scope}, "
                          f"SignedHeaders=content-type;host;x-tc-action, Signature={signature}"),
    }


def configured() -> bool:
    return bool(os.environ.get("TC_SECRET_ID") and os.environ.get("TC_SECRET_KEY"))


async def call(client: httpx.AsyncClient, action: str, params: dict, *, service: str = "adp",
               host: str = "adp.tencentcloudapi.com", version: str = "2026-05-20") -> dict:
    payload = json.dumps(params, separators=(",", ":"))
    headers = sign_headers(action, payload, service=service, host=host, version=version,
                           region=os.environ.get("TC_REGION", "ap-guangzhou"),
                           secret_id=os.environ["TC_SECRET_ID"], secret_key=os.environ["TC_SECRET_KEY"])
    res = await client.post(f"https://{host}", content=payload, headers=headers, timeout=15)
    body = res.json().get("Response", {})
    if "Error" in body:
        err = body["Error"]
        raise TcApiError(err.get("Code", ""), err.get("Message", ""))
    return body


async def create_ws_token(client: httpx.AsyncClient, app_key: str, user_id: str) -> str:
    """换取 WebSocket 连接令牌（一次性、短期有效，每次建连前重新获取）。"""
    res = await call(client, "CreateWebSocketToken", {"Type": 5, "AppKey": app_key, "UserId": user_id[:64]})
    token = res.get("Token", "")
    if not token:
        raise TcApiError("EmptyToken", "未获取到对话令牌")
    return token
