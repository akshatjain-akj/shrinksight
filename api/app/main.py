import asyncio

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import selftest
from .config import get_settings

settings = get_settings()

app = FastAPI(title="ShrinkSight API", docs_url="/api/docs", openapi_url="/api/openapi.json")

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware, allow_origins=list(settings.cors_origins), allow_methods=["GET", "POST"]
    )


@app.get("/api/healthz")
def healthz() -> dict:
    """Cheap liveness probe: no external calls. Also used to wake a scaled-to-zero instance."""
    return {
        "ok": True,
        "service": "shrinksight-api",
        "version": settings.version,
        "model": settings.gemini_model,
    }


@app.get("/api/selftest")
async def run_selftest() -> dict:
    """Checks every cloud dependency in parallel and reports each one separately."""
    firestore_res, storage_res, gemini_res = await asyncio.gather(
        asyncio.to_thread(selftest.check_firestore, settings),
        asyncio.to_thread(selftest.check_storage, settings),
        asyncio.to_thread(selftest.check_gemini, settings),
    )
    checks = {"firestore": firestore_res, "storage": storage_res, "gemini": gemini_res}
    return {"ok": all(c["ok"] for c in checks.values()), "version": settings.version, "checks": checks}
