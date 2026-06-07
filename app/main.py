"""FastAPIアプリのエントリポイント。"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.models import init_db
from app.api import router
from app.scheduler import start_background_scheduler
from app.auth import BasicAuthMiddleware

WEB_DIR = Path(__file__).parent.parent / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    start_background_scheduler()
    yield


app = FastAPI(
    title="体調の隠れ相関発見ノート",
    version="0.1.0",
    description="1日10秒の記録から不調の隠れた関連を発見するツール",
    lifespan=lifespan,
)

app.add_middleware(BasicAuthMiddleware)
app.include_router(router)

# Service Worker と manifest はルートスコープで提供する必要がある
if WEB_DIR.exists():
    @app.get("/manifest.json", include_in_schema=False)
    async def manifest():
        return FileResponse(str(WEB_DIR / "manifest.json"),
                            media_type="application/manifest+json")

    @app.get("/sw.js", include_in_schema=False)
    async def service_worker():
        return FileResponse(str(WEB_DIR / "sw.js"),
                            media_type="application/javascript")

    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        return FileResponse(str(WEB_DIR / "index.html"))


def start() -> None:
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == "__main__":
    start()
