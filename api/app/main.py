import asyncio
import base64
import binascii
import json
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from . import selftest
from .config import Settings, get_settings
from .gemini import Gateway, GeminiGateway, GeminiUnavailable
from .investigator import investigate, normalise_mime
from .models import POSITIVE_VERDICTS, ReceiptLine, Rule, RuleSpec, Transaction, validate_rule_spec
from .repo import FirestoreRepo, MemoryRepo, Repo
from .rules_compiler import compile_rule
from .seed import STORE_NAME

settings = get_settings()

app = FastAPI(title="ShrinkSight API", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.state.settings = settings
app.state.repo = None
app.state.gateway = None

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["content-type", "x-shrinksight-meta"],
    )


# ---------- dependencies (overridable in tests via app.state) ----------
def get_repo() -> Repo:
    if app.state.repo is None:
        app.state.repo = MemoryRepo() if settings.repo_backend == "memory" else FirestoreRepo(settings.gcp_project)
    repo = app.state.repo
    repo.ensure_seeded()
    return repo


def get_gateway() -> Gateway:
    if app.state.gateway is None:
        try:
            app.state.gateway = GeminiGateway(
                settings.gemini_api_key, settings.gemini_timeout_ms, settings.gemini_max_retries
            )
        except GeminiUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
    return app.state.gateway


def cfg() -> Settings:
    return app.state.settings


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def enforce_limits(request: Request, repo: Repo, daily_key: str, daily_limit: int) -> None:
    now = datetime.now(UTC)
    ip = _client_ip(request).replace("/", "_")
    if repo.incr(f"ip-{ip}-{now:%Y%m%d%H%M}", ttl_s=120) > cfg().per_ip_per_minute:
        raise HTTPException(429, "Too many requests from your connection. Please wait a minute.",
                            headers={"Retry-After": "60"})
    if repo.incr(f"day-{daily_key}-{now:%Y%m%d}", ttl_s=2 * 86400) > daily_limit:
        raise HTTPException(429, "Today's free AI quota for this demo is used up. Please try again tomorrow.",
                            headers={"Retry-After": "3600"})


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- health ----------
@app.get("/api/healthz")
def healthz() -> dict:
    """Cheap liveness probe: no external calls. Also used to wake a scaled-to-zero instance."""
    return {
        "ok": True,
        "service": "shrinksight-api",
        "version": settings.version,
        "model": settings.gemini_model,
        "investigator_model": settings.investigator_model,
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


# ---------- store ----------
@app.get("/api/store")
def store() -> dict:
    repo = get_repo()
    return {
        "name": STORE_NAME,
        "currency": cfg().currency,
        "cameras": [c.model_dump() for c in repo.cameras()],
        "zones": [z.model_dump() for z in repo.zones()],
    }


@app.get("/api/transactions")
def transactions(lane_id: str | None = Query(default=None, max_length=10)) -> list[dict]:
    txns = [t for t in get_repo().transactions(lane_id) if t.source == "seed"]
    return [{**t.model_dump(), "total_inr": t.total_inr} for t in txns]


# ---------- incidents ----------
@app.get("/api/incidents")
def incidents(limit: int = Query(default=50, ge=1, le=100)) -> list[dict]:
    return [i.model_dump() for i in get_repo().incidents(limit)]


@app.get("/api/incidents/{incident_id}")
def incident(incident_id: str) -> dict:
    found = get_repo().get_incident(incident_id)
    if found is None:
        raise HTTPException(404, "Incident not found")
    return found.model_dump()


class ReviewIn(BaseModel):
    decision: Literal["confirm", "dismiss"]


@app.post("/api/incidents/{incident_id}/review")
def review(incident_id: str, body: ReviewIn) -> dict:
    repo = get_repo()
    found = repo.get_incident(incident_id)
    if found is None:
        raise HTTPException(404, "Incident not found")
    found.status = "RESOLVED_CONFIRMED" if body.decision == "confirm" else "RESOLVED_DISMISSED"
    found.reviewed_at = _now_iso()
    repo.save_incident(found)
    return found.model_dump()


@app.get("/api/stats")
def stats() -> dict:
    items = get_repo().incidents(100)
    flagged = [i for i in items if i.verdict.verdict in POSITIVE_VERDICTS and i.status != "RESOLVED_DISMISSED"]
    return {
        "investigated": len(items),
        "flagged": len(flagged),
        "false_alarms_rejected": sum(1 for i in items if i.status == "REJECTED"),
        "needs_review": sum(1 for i in items if i.status == "NEEDS_REVIEW"),
        "est_loss_caught_inr": round(sum(i.est_loss_inr for i in flagged), 2),
    }


# ---------- rules ----------
@app.get("/api/rules")
def rules() -> list[dict]:
    return [r.model_dump() for r in get_repo().rules()]


class CompileIn(BaseModel):
    text: str = Field(min_length=5, max_length=300)


@app.post("/api/rules/compile")
def rules_compile(body: CompileIn, request: Request) -> dict:
    repo = get_repo()
    enforce_limits(request, repo, "compile", cfg().daily_rule_compiles)
    try:
        result = compile_rule(body.text, repo.zones(), get_gateway(), cfg().gemini_model, repo)
    except GeminiUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    return {"spec": result.spec.model_dump(), "problems": result.problems, "cached": result.cached}


class RuleIn(BaseModel):
    source_text: str = Field(min_length=5, max_length=300)
    spec: RuleSpec


@app.post("/api/rules", status_code=201)
def rules_create(body: RuleIn) -> dict:
    repo = get_repo()
    problems = validate_rule_spec(body.spec, {z.id: z for z in repo.zones()})
    if problems:
        raise HTTPException(400, " ".join(problems))
    rule = Rule(id=f"rule-{uuid.uuid4().hex[:10]}", source_text=body.source_text, spec=body.spec,
                created_at=_now_iso())
    repo.save_rule(rule)
    return rule.model_dump()


class RulePatch(BaseModel):
    enabled: bool


@app.patch("/api/rules/{rule_id}")
def rules_patch(rule_id: str, body: RulePatch) -> dict:
    repo = get_repo()
    rule = repo.get_rule(rule_id)
    if rule is None:
        raise HTTPException(404, "Rule not found")
    rule.enabled = body.enabled
    repo.save_rule(rule)
    return rule.model_dump()


# ---------- investigate ----------
class InvestigateMeta(BaseModel):
    camera_id: str = Field(max_length=40)
    transaction_id: str | None = Field(default=None, max_length=40)
    receipt: list[ReceiptLine] | None = Field(default=None, max_length=30)


def _parse_meta(header: str | None) -> InvestigateMeta:
    if not header:
        raise HTTPException(400, "Missing x-shrinksight-meta header")
    try:
        raw = base64.urlsafe_b64decode(header + "=" * (-len(header) % 4))
        return InvestigateMeta.model_validate(json.loads(raw))
    except (binascii.Error, ValueError, ValidationError) as exc:
        raise HTTPException(400, "Invalid x-shrinksight-meta header") from exc


async def _read_clip(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(413, f"Clip too large (max {limit // (1024 * 1024)} MB)")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, f"Clip too large (max {limit // (1024 * 1024)} MB)")
        chunks.append(chunk)
    if size == 0:
        raise HTTPException(400, "Empty clip")
    return b"".join(chunks)


@app.post("/api/investigate")
async def investigate_clip(request: Request) -> StreamingResponse:
    """Body: the raw video bytes. Header x-shrinksight-meta: base64url JSON InvestigateMeta.

    Responds with Server-Sent Events: `progress` events, then one `result` or `error`.
    """
    mime = normalise_mime(request.headers.get("content-type", ""))
    if mime is None:
        raise HTTPException(415, "Unsupported video type. Use MP4, WebM or MOV.")
    meta = _parse_meta(request.headers.get("x-shrinksight-meta"))

    repo = await asyncio.to_thread(get_repo)
    camera = next((c for c in await asyncio.to_thread(repo.cameras) if c.id == meta.camera_id), None)
    if camera is None:
        raise HTTPException(400, "Unknown camera")

    transaction = None
    if camera.kind == "checkout":
        if meta.receipt:
            transaction = Transaction(id=f"TXN-LIVE-{uuid.uuid4().hex[:8]}", lane_id=camera.lane_id or "",
                                      lines=meta.receipt, started_at=_now_iso(), source="live")
        elif meta.transaction_id:
            transaction = await asyncio.to_thread(repo.get_transaction, meta.transaction_id)
            if transaction is None:
                raise HTTPException(400, "Unknown transaction")

    await asyncio.to_thread(enforce_limits, request, repo, "investigate", cfg().daily_investigations)
    clip = await _read_clip(request, cfg().max_clip_bytes)
    gateway = get_gateway()
    if transaction is not None and transaction.source == "live":
        await asyncio.to_thread(repo.save_transaction, transaction)

    def events():
        for event in investigate(clip, mime, camera, transaction, repo, gateway, cfg()):
            yield f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@app.exception_handler(GeminiUnavailable)
async def _gemini_unavailable(_: Request, exc: GeminiUnavailable) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})
