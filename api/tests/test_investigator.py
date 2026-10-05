import json
from dataclasses import replace

from conftest import FakeGateway, text

from app.gemini import GeminiUnavailable
from app.investigator import investigate, normalise_mime

CLIP = b"\x00fake-video-bytes"


def verdict_json(**overrides) -> str:
    base = {
        "verdict": "SCAN_AVOIDANCE",
        "confidence": 0.9,
        "items_seen": 4,
        "items_scanned": 3,
        "seen_items": [
            {"t": "00:01.0", "description": "milk carton", "scanned": True, "box_2d": [1, 2, 3, 4],
             "receipt_line": 1, "location": "over_scanner"},
            {"t": "00:03.0", "description": "bread loaf", "scanned": True, "receipt_line": 2,
             "location": "over_scanner"},
            {"t": "00:06.4", "description": "red wine bottle", "scanned": False, "box_2d": [300, 600, 640, 700],
             "receipt_line": None, "location": "beside_scanner"},
            {"t": "00:08.0", "description": "chips packet", "scanned": True, "receipt_line": 3,
             "location": "over_scanner"},
        ],
        "timeline": [{"t": "00:06.4", "event": "wine bottle moved beside the scanner"}],
        "reason": "The wine bottle went around the scanner.",
    }
    base.update(overrides)
    return json.dumps(base)


def camera(repo, camera_id):
    return next(c for c in repo.cameras() if c.id == camera_id)


def run(repo, gateway, settings, camera_id="cam-sco-2", transaction=None, **kwargs):
    cam = camera(repo, camera_id)
    return list(investigate(CLIP, "video/webm", cam, transaction, repo, gateway, settings, **kwargs))


def steps(events):
    return [e["step"] for e in events if e["type"] == "progress"]


# ---------- single-pass flow ----------
def test_checkout_scan_avoidance_in_one_gemini_call(repo, settings):
    gateway = FakeGateway([text(verdict_json())])

    events = run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"))

    assert len(gateway.calls) == 1, "the video must be sent to Gemini once"
    assert steps(events) == ["tool", "watching"]
    incident = events[-1]["incident"]
    assert events[-1]["cached"] is False
    assert incident["status"] == "NEEDS_REVIEW"
    assert incident["transaction_id"] == "TXN-L2-2041"
    assert [u["matched_sku"] for u in incident["unscanned_items"]] == ["SKU-0005"]
    assert incident["est_loss_inr"] == 1850
    assert incident["tool_calls"][0]["name"] == "get_pos_transaction"
    assert set(incident["timings"]) >= {"lookup_ms", "upload_ms", "watch_ms", "total_ms"}


def test_receipt_count_and_lines_are_in_the_prompt_up_front(repo, settings):
    gateway = FakeGateway([text(verdict_json())])

    run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"))

    briefing = gateway.calls[0][1][0].parts[-1].text
    assert "1. Toned milk 1L" in briefing
    assert "The receipt has 3 lines, so at least 3 items were handled" in briefing
    config = gateway.calls[0][2]
    assert config.response_schema is not None and config.tools is None


def test_same_clip_is_served_from_cache_without_calling_gemini(repo, settings):
    txn = repo.get_transaction("TXN-L2-2041")
    first = run(repo, FakeGateway([text(verdict_json())]), settings, transaction=txn)
    second_gateway = FakeGateway([])

    second = run(repo, second_gateway, settings, transaction=txn)

    assert second[-1]["cached"] is True
    assert second[-1]["incident"]["id"] == first[-1]["incident"]["id"]
    assert second_gateway.calls == []


def test_latest_lane_receipt_is_used_when_none_is_attached(repo, settings):
    all_matched = [
        {"t": f"00:0{i}.0", "description": name, "scanned": True, "receipt_line": i, "location": "over_scanner"}
        for i, name in enumerate(["soft drink bottle", "noodles pack", "biscuits pack", "oil bottle"], start=1)
    ]
    gateway = FakeGateway([text(verdict_json(verdict="BENIGN", items_scanned=4, seen_items=all_matched))])

    events = run(repo, gateway, settings)

    incident = events[-1]["incident"]
    assert incident["status"] == "REJECTED"
    assert incident["transaction_id"] == "TXN-L2-2043"
    assert incident["unscanned_items"] == [] and incident["est_loss_inr"] == 0


def test_invalid_json_is_re_asked_once(repo, settings):
    gateway = FakeGateway([text("{not json"), text(verdict_json())])

    events = run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"))

    assert events[-1]["incident"]["verdict"]["verdict"] == "SCAN_AVOIDANCE"
    assert len(gateway.calls) == 2
    assert "recheck" in steps(events)


def test_invalid_json_twice_becomes_inconclusive_not_an_error(repo, settings):
    gateway = FakeGateway([text("nope"), text("still nope")])

    events = run(repo, gateway, settings)

    incident = events[-1]["incident"]
    assert incident["verdict"]["verdict"] == "INCONCLUSIVE"
    assert incident["status"] == "NEEDS_REVIEW"


def test_floor_camera_gets_zone_policy_and_prices_the_hidden_item(repo, settings):
    concealment = verdict_json(
        verdict="CONCEALMENT", items_seen=1, items_scanned=0,
        seen_items=[{"t": "00:03.4", "description": "whisky bottle", "scanned": False}],
    )
    gateway = FakeGateway([text(concealment)])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4")

    incident = events[-1]["incident"]
    assert incident["camera_kind"] == "floor" and incident["receipt"] == []
    assert incident["tool_calls"] == [{"name": "get_zone_policy", "args": {"zone_id": "z-spirits"}}]
    assert "Zone policy" in gateway.calls[0][1][0].parts[-1].text
    assert incident["est_loss_inr"] == 2400


# ---------- reliability: backup models, budget, metadata ----------
def test_overloaded_model_falls_back_to_the_backup(repo, settings):
    gateway = FakeGateway([GeminiUnavailable("overloaded", 503), text(verdict_json())])
    with_backup = replace(settings, fallback_models=("backup-model",))

    events = run(repo, gateway, with_backup, transaction=repo.get_transaction("TXN-L2-2041"))

    assert [c[0] for c in gateway.calls] == ["test-model", "backup-model"]
    assert "fallback" in steps(events)
    assert events[-1]["incident"]["model"] == "backup-model"


def test_all_models_busy_is_a_clear_error(repo, settings):
    gateway = FakeGateway([GeminiUnavailable("quota reached", 429), GeminiUnavailable("overloaded", 503)])

    events = run(repo, gateway, replace(settings, fallback_models=("backup-model",)))

    error = events[-1]
    assert error["type"] == "error" and error["message"].startswith("overloaded (while watching the clip")
    assert error["stage"] == "watching the clip" and error["code"] == 503


def test_non_retryable_error_does_not_fall_back(repo, settings):
    gateway = FakeGateway([GeminiUnavailable("bad key", 403)])

    events = run(repo, gateway, replace(settings, fallback_models=("backup-model",)))

    assert events[-1]["type"] == "error" and len(gateway.calls) == 1


def test_metadata_rejection_retries_the_plain_clip(repo, settings):
    gateway = FakeGateway([GeminiUnavailable("bad video metadata", 400), text(verdict_json())])

    events = run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"))

    assert events[-1]["type"] == "result"
    _, contents, config = gateway.calls[-1]
    videos = [p for p in contents[0].parts if p.inline_data and p.inline_data.mime_type == "video/webm"]
    assert videos and all(p.video_metadata is None for p in videos)
    assert config.media_resolution is None and config.thinking_config is None


def test_no_recheck_when_the_budget_is_spent_first_answer_is_kept(repo, settings):
    wrong = verdict_json(seen_items=[{"t": "00:01", "description": "a", "scanned": False}])
    gateway = FakeGateway([text(wrong)])

    events = run(repo, gateway, replace(settings, agent_deadline_s=5), transaction=repo.get_transaction("TXN-L2-2041"))

    assert len(gateway.calls) == 1
    assert events[-1]["incident"]["verdict"]["verdict"] == "INCONCLUSIVE"


def test_gemini_3_gets_low_thinking_and_older_models_keep_defaults(repo, settings):
    for model, expect in (("gemini-3.5-flash-lite", "LOW"), ("gemini-2.5-flash-lite", None)):
        gateway = FakeGateway([text(verdict_json())])
        run(repo, gateway, replace(settings, investigator_model=model), transaction=repo.get_transaction("TXN-L2-2041"))
        thinking = gateway.calls[0][2].thinking_config
        assert (thinking.thinking_level.name if thinking else None) == expect


# ---------- inputs: hints, stills, close-ups, big clips ----------
def test_tier1_hints_reach_the_prompt(repo, settings):
    gateway = FakeGateway([text(verdict_json(verdict="BENIGN", seen_items=[], items_seen=0, items_scanned=0))])

    events = run(repo, gateway, settings, camera_id="cam-aisle-2", tier1_events=[{
        "t": "00:01.2", "kind": "CONCEALMENT", "score": 0.7, "detail": "wrist to pocket",
        "camera_id": "cam-aisle-2", "trigger": "hot_score", "confidence": 0.66, "box": [120, 80, 900, 420],
    }])

    prompt = str(gateway.calls[0][1])
    assert events[-1]["type"] == "result"
    for expected in ("wrist to pocket", "trigger hot_score", "confidence 0.66", "camera cam-aisle-2",
                     "box [120, 80, 900, 420]"):
        assert expected in prompt


def test_stills_and_close_ups_are_sent_ahead_of_the_clip(repo, settings):
    gateway = FakeGateway([text(verdict_json())])
    jpeg = b"\xff\xd8\xff\xd9"
    labels = ["before", "reach", "hold", "after", "pickup_start", "bagging_end"]

    events = run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"),
                 stills=[(label, jpeg) for label in labels])

    assert events[-1]["type"] == "result"
    parts = gateway.calls[0][1][0].parts
    texts = [p.text for p in parts if p.text]
    image_positions = [i for i, p in enumerate(parts) if p.inline_data and p.inline_data.mime_type == "image/jpeg"]
    video_position = next(i for i, p in enumerate(parts) if p.inline_data and p.inline_data.mime_type == "video/webm")
    assert len(image_positions) == 6
    assert "Still: before" in texts
    assert any(t.startswith("Close-up: the item pile at the start") for t in texts)
    assert video_position > max(image_positions)


def test_starting_inventory_larger_than_items_listed_triggers_one_recheck(repo, settings):
    pile = [{"description": d} for d in ("milk", "bread", "wine", "chips", "flat cloth flower")]
    short = verdict_json(inventory=pile)
    gateway = FakeGateway([text(short), text(verdict_json(inventory=pile[:4]))])

    events = run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"))

    assert len(gateway.calls) == 2
    assert "5 items in the item pile" in gateway.calls[1][1][-1].parts[0].text
    inventory = events[-1]["incident"]["verdict"]["inventory"]
    assert [i["description"] for i in inventory] == ["milk", "bread", "wine", "chips"]


def test_large_clip_goes_through_files_api_and_is_deleted(repo, settings):
    gateway = FakeGateway([text(verdict_json())])

    events = run(repo, gateway, replace(settings, inline_clip_bytes=4), transaction=repo.get_transaction("TXN-L2-2041"))

    assert events[-1]["type"] == "result"
    assert "upload" in steps(events)
    video = gateway.calls[0][1][0].parts[0]
    assert video.file_data.file_uri == "https://files.test/1" and video.inline_data is None
    assert gateway.uploads == [(len(CLIP), "video/webm")]
    assert gateway.deleted == ["files/test-1"]


def test_uploaded_clip_is_deleted_even_when_gemini_fails(repo, settings):
    gateway = FakeGateway([GeminiUnavailable("quota reached", 429)])

    events = run(repo, gateway, replace(settings, inline_clip_bytes=4))

    assert events[-1]["type"] == "error"
    assert gateway.deleted == ["files/test-1"]


def test_normalise_mime():
    assert normalise_mime("video/webm;codecs=vp9") == "video/webm"
    assert normalise_mime("video/quicktime") == "video/mov"
    assert normalise_mime("image/png") is None


def test_unmatched_receipt_line_is_named_in_the_recheck(repo, settings):
    missing_chips = verdict_json(items_seen=3, items_scanned=2, seen_items=json.loads(verdict_json())["seen_items"][:3])
    gateway = FakeGateway([text(missing_chips), text(verdict_json())])

    run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"))

    recheck = gateway.calls[1][1][-1].parts[0].text
    assert "Receipt line 3 'Potato chips 150g packet' was not matched" in recheck
    assert "flat, thin, soft" in recheck


def test_close_ups_get_high_detail_and_video_low(repo, settings):
    gateway = FakeGateway([text(verdict_json())])
    jpeg = b"\xff\xd8\xff\xd9"

    run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"),
        stills=[("before", jpeg), ("pickup_start", jpeg)])

    parts = gateway.calls[0][1][0].parts
    images = [p for p in parts if p.inline_data and p.inline_data.mime_type == "image/jpeg"]
    video = next(p for p in parts if p.inline_data and p.inline_data.mime_type == "video/webm")
    assert [p.media_resolution.level.name for p in images] == ["MEDIA_RESOLUTION_LOW", "MEDIA_RESOLUTION_HIGH"]
    assert video.media_resolution.level.name == "MEDIA_RESOLUTION_LOW"
    assert gateway.calls[0][2].media_resolution is None, "no request-wide resolution that would shrink the close-ups"


def test_long_clips_are_sampled_at_3_fps(repo, settings):
    for seconds, fps in ((8, 5), (13, 3)):
        gateway = FakeGateway([text(verdict_json())])
        run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"), clip_seconds=seconds)
        video = next(p for p in gateway.calls[0][1][0].parts if p.video_metadata)
        assert video.video_metadata.fps == fps


def test_slow_model_is_not_abandoned_for_a_backup_without_time(repo, settings):
    gateway = FakeGateway([GeminiUnavailable("Gemini took too long to answer (over 48 s).", 408)])

    events = run(repo, gateway, replace(settings, fallback_models=("backup-model",)),
                 transaction=repo.get_transaction("TXN-L2-2041"))

    assert len(gateway.calls) == 1, "a timeout means the budget is spent: no doomed backup call"
    assert events[-1]["type"] == "error" and "took too long" in events[-1]["message"]


def test_main_call_gets_the_whole_remaining_budget(repo, settings):
    calls = []

    class Recording(FakeGateway):
        def generate(self, model, contents, config, deadline=None, retries=None, timeout_ms=None):
            calls.append(timeout_ms)
            return super().generate(model, contents, config, deadline, retries, timeout_ms)

    run(repo, Recording([text(verdict_json())]), settings, transaction=repo.get_transaction("TXN-L2-2041"))

    assert calls == [None], "no fixed cap on the main call; the gateway uses the time left"


def test_close_ups_split_detail_between_pile_scanner_and_stills(repo, settings):
    gateway = FakeGateway([text(verdict_json())])
    jpeg = b"\xff\xd8\xff\xd9"

    run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"),
        stills=[("before", jpeg), ("pickup_start", jpeg), ("scanner_mid", jpeg), ("bagging_end", jpeg)])

    levels = [p.media_resolution.level.name for p in gateway.calls[0][1][0].parts
              if p.inline_data and p.inline_data.mime_type == "image/jpeg"]
    assert levels == ["MEDIA_RESOLUTION_LOW", "MEDIA_RESOLUTION_HIGH", "MEDIA_RESOLUTION_MEDIUM",
                      "MEDIA_RESOLUTION_MEDIUM"]


def test_flat_and_stacked_item_rules_are_in_the_prompt():
    from app.investigator import SYSTEM_PROMPT

    assert "cloth or paper flowers" in SYSTEM_PROMPT
    assert "resting on, inside, or carried together" in SYSTEM_PROMPT
