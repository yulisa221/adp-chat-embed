"""本地联调用：模拟站点网关——/api/<服务名>/* 交给对话后端，其余路径读 frontend/ 静态文件。

    LOCAL_DEV=1 ADP_APP_KEY=... uvicorn dev_server:app --port 8790

线上不使用此文件（网关负责转发并去掉路由前缀）。
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import app as chat_app

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
# 服务名即目录名（默认 chat），与线上网关路由一致
app.mount("/api/" + Path(__file__).resolve().parent.name, chat_app)
app.mount("/", StaticFiles(directory=Path(__file__).resolve().parents[2] / "frontend", html=True), name="frontend")
