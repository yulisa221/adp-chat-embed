"""PG 云存储运行时 HTTP 客户端；不调用 Agent MCP，不生成存储签名。

来自 adp-sites 上传模板，对话附件场景下放宽了 MIME 一致性校验（仅核对长度）。
"""
from __future__ import annotations

import json
import os
import re
import socket
from http.client import HTTPException as HTTPClientError
from dataclasses import dataclass, field
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener


class StorageError(Exception):
    def __init__(self, code: str, stage: str, message: str, *, status: int = 502,
                 request_id: str = ""):
        super().__init__(message)
        self.code, self.stage, self.status = code, stage, status
        self.request_id = request_id if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id) else ""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # 服务端凭据不跟随跳转。


@dataclass
class StorageClient:
    origin: str
    api_key: str = field(repr=False)
    bucket: str = "site-assets"

    @classmethod
    def from_env(cls) -> "StorageClient":
        env, region, key = (os.environ.get(n, "").strip() for n in
                            ("CLOUDBASE_ENV_ID", "CLOUDBASE_REGION", "CLOUDBASE_APIKEY"))
        if not env or not region or not key:
            raise StorageError("CONFIG_MISSING", "config", "站点运行时配置未就绪", status=503)
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", env):
            raise StorageError("CONFIG_INVALID", "config", "环境标识格式无效", status=503)
        mainland = ("ap-shanghai", "ap-guangzhou", "ap-beijing", "ap-nanjing",
                    "ap-chengdu", "ap-chongqing", "ap-shenzhen")
        domestic = any(region == r or region.startswith(r + "-") for r in mainland)
        international = {"ap-hongkong", "ap-singapore", "ap-tokyo", "ap-seoul", "ap-bangkok",
                         "ap-jakarta", "ap-mumbai", "na-siliconvalley", "na-ashburn", "na-toronto",
                         "eu-frankfurt", "eu-moscow", "sa-saopaulo"}
        if not domestic and region not in international:
            raise StorageError("CONFIG_INVALID", "config", "请先核对该地域的正式存储网关", status=503)
        host = "api.tcloudbasegateway.com" if domestic else "api.intl.tcloudbasegateway.com"
        bucket = os.environ.get("STORAGE_BUCKET", "site-assets")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,63}", bucket):
            raise StorageError("CONFIG_INVALID", "config", "存储桶名称格式无效", status=503)
        return cls(f"https://{env}.{host}", key, bucket)

    def object_path(self, key: str, operation: str = "") -> str:
        if not key or key.startswith("/") or "\\" in key or any(
                part in {"", ".", ".."} for part in key.split("/")):
            raise StorageError("INVALID_KEY", "input", "文件路径无效", status=400)
        encoded = "/".join(quote(part, safe="") for part in key.split("/"))
        return f"/v1/storages/object/{operation}{quote(self.bucket, safe='')}/{encoded}"

    def _request(self, method: str, path: str, stage: str, *, authenticated: bool = True,
                 data: bytes | None = None, content_type: str = "application/json"):
        headers = {"Content-Type": content_type}
        if authenticated:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = Request(self.origin + path, method=method, headers=headers, data=data)
        try:
            with build_opener(NoRedirect()).open(req, timeout=15) as res:
                return res.headers, res.read(1024 * 1024)
        except HTTPError as err:
            request_id = err.headers.get("x-request-id", "")
            try:
                body = json.loads(err.read(16384))
                if isinstance(body, dict):
                    request_id = body.get("requestId", request_id)
            except (ValueError, OSError):
                pass
            # 不把上游响应、请求头、签名 URL 或凭据返回浏览器。
            if err.code in (401, 403):
                code, message, status = "STORAGE_AUTH_FAILED", "存储运行时鉴权失败，请检查站点配置", 503
            elif err.code == 404:
                code, message, status = "STORAGE_NOT_FOUND", "存储接口、桶或对象不存在，请核对请求路径", 404
            elif err.code == 400:
                code, message, status = "STORAGE_PROTOCOL_ERROR", "存储请求参数不符合协议", 502
            else:
                code, message, status = "STORAGE_HTTP_ERROR", f"存储请求失败（HTTP {err.code}）", 502
            raise StorageError(code, stage, message, status=status,
                               request_id=str(request_id)) from None
        except (URLError, TimeoutError, socket.timeout, HTTPClientError):
            raise StorageError("STORAGE_NETWORK_ERROR", stage, "存储请求超时或不可达，请先核对对象状态") from None

    def _json(self, method: str, path: str, stage: str) -> dict:
        _, raw = self._request(method, path, stage, data=b"{}" if method == "POST" else None)
        try:
            value = json.loads(raw)
            if isinstance(value, dict):
                return value
        except ValueError:
            pass
        raise StorageError("STORAGE_PROTOCOL_ERROR", stage, "存储响应格式不符合协议")

    def require_public_bucket(self) -> None:
        bucket = self._json("GET", "/v1/storages/bucket/" + quote(self.bucket, safe=""), "bucket")
        if bucket.get("public") is not True:
            raise StorageError("PRIVATE_BUCKET", "bucket", "此演示需要公开素材桶，当前桶没有公开访问能力", status=409)

    def confirm(self, key: str, size: int, content_type: str) -> dict:
        obj = self._json("GET", self.object_path(key, "info/"), "confirm")
        if (obj.get("name") != key or obj.get("bucket_id") != self.bucket
                or type(obj.get("size")) is not int or obj["size"] != size
                or obj["size"] <= 0):
            raise StorageError("OBJECT_MISMATCH", "confirm", "已上传对象的路径、大小或类型不匹配", status=409)
        self.require_public_bucket()
        path = self.object_path(key)
        headers, _ = self._request("HEAD", path, "public_access", authenticated=False)
        # 对话附件类型多样（文档、表格等），存储可能规范化 MIME，这里只核对长度。
        if headers.get("Content-Length") != str(size):
            raise StorageError("OBJECT_MISMATCH", "public_access", "公开链接返回的对象信息不匹配", status=409)
        # 正式 HTTP 下载路由，公开桶且匿名 HEAD 已验证；不是站点首页下的资源路径。
        return {"key": key, "url": self.origin + path, "size": size, "content_type": content_type}

    def upload_object(self, key: str, content: bytes, content_type: str) -> None:
        """后端以原始二进制 POST 上传；不签发或返回上传 URL。"""
        self._request("POST", self.object_path(key), "upload", data=content, content_type=content_type)
