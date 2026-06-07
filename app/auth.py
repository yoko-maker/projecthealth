"""HTTP Basic Auth ミドルウェア。
AUTH_PASSWORD 環境変数が設定されている場合のみ認証を要求する。
ローカル利用時は設定不要（認証スキップ）。
"""
from __future__ import annotations

import base64
import os
import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


class BasicAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        password = os.environ.get("AUTH_PASSWORD", "")
        if not password:
            return await call_next(request)

        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Basic "):
            return Response(
                "認証が必要です",
                status_code=401,
                headers={"WWW-Authenticate": 'Basic realm="健康ノート"'},
            )

        try:
            decoded = base64.b64decode(auth_header[6:]).decode("utf-8")
            username, _, pw = decoded.partition(":")
        except Exception:
            return Response("Bad Request", status_code=400)

        expected_user = os.environ.get("AUTH_USERNAME", "admin")
        ok = secrets.compare_digest(username, expected_user) and secrets.compare_digest(pw, password)
        if not ok:
            return Response(
                "認証失敗",
                status_code=401,
                headers={"WWW-Authenticate": 'Basic realm="健康ノート"'},
            )

        return await call_next(request)
