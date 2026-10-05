import base64
import json
from dataclasses import replace

from conftest import FakeGateway, text
from test_investigator import CLIP, camera, run, verdict_json

from app import main
from app.evaluation import ClipResult, stability, to_markdown
from app.gemini import GeminiUnavailable
from app.inventory import clean_items, iou, take_inventory
from app.models import InventoryItem, ReceiptLine, VerdictOut
from app.reconcile import reconcile

JPEG = b"\xff\xd8\xff\xd9"
PILE = [
    {"description": "green bottle", "box_2d": [100, 100, 400, 250]},
    {"description": "black biscuit packet", "box_2d": [450, 120, 600, 400]},
    {"description": "flat cloth flower", "box_2d": [420, 500, 520, 700]},
]


def inventory_json(items=PILE) -> str:
    return json.dumps({"items": items})


# ---------- helpers ----------
def test_overlapping_duplicates_are_merged_and_bad_boxes_dropped():
    items = [InventoryItem(**i) for i in PILE] + [
        InventoryItem(description="bottle again", box_2d=[105, 100, 400, 255]),   # duplicate of #1
        InventoryItem(description="", box_2d=[0, 0, 10, 10]),                     # empty
        InventoryItem(description="card", box_2d=[900, 900, 800, 950]),           # inverted box
    ]
    cleaned = clean_items(items)
    assert [i.description for i in cleaned] == ["green bottle", "black biscuit packet", "flat cloth flower", "card"]
    assert cleaned[-1].box_2d == []
    assert iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0 and iou([0, 0, 10, 10], [20, 20, 30, 30]) == 0.0


# ---------- the inventory call ----------
def test_inventory_is_one_request_with_all_views_and_is_cached(repo, settings):
    gateway = FakeGateway([text(inventory_json())])
    views = [("pile", JPEG), ("left", JPEG), ("right", JPEG)]
    settings = replace(settings, inventory_model="inventory-model")

    first = take_inventory(views, camera(repo, "cam-sco-1"), gateway, settings, repo)
    second = take_inventory(views, camera(repo, "cam-sco-1"), gateway, settings, repo)

    assert len(gateway.calls) == 1, "all three views go in one request; the repeat is served from cache"
    model, contents, config = gateway.calls[0]
    assert model == "inventory-model"
    images = [p for p in contents[0].parts if p.inline_data]
    assert len(images) == 3 and all(p.media_resolution.level.name == "MEDIA_RESOLUTION_HIGH" for p in images)
    assert config.seed == settings.gemini_seed
    assert [i.description for i in first[0]] == [i["description"] for i in PILE]
    assert first[2] is False and second[2] is True


def test_inventory_falls_back_when_its_model_is_busy(repo, settings):
    gateway = FakeGateway([GeminiUnavailable("busy", 503), text(inventory_json())])
    settings = replace(settings, inventory_model="inventory-model", fallback_models=("backup-model",))

    items, model, _, _ = take_inventory([("pile", JPEG)], camera(repo, "cam-sco-1"), gateway, settings, repo)

    assert model == "backup-model" and len(items) == 3


def test_inventory_endpoint(api):
    main.app.state.gateway = FakeGateway([text(inventory_json())])
    meta = base64.urlsafe_b64encode(json.dumps({"camera_id": "cam-sco-1"}).encode()).decode().rstrip("=")

    res = api.post("/api/inventory", files=[("view", ("pile.jpg", JPEG, "image/jpeg")),
                                            ("view", ("left.jpg", JPEG, "image/jpeg"))],
                   headers={"x-shrinksight-meta": meta})

    assert res.status_code == 200
    assert [i["description"] for i in res.json()["items"]] == [i["description"] for i in PILE]
    no_pile = api.post("/api/inventory", files=[("view", ("left.jpg", JPEG, "image/jpeg"))],
                       headers={"x-shrinksight-meta": meta})
    assert no_pile.status_code == 400


# ---------- tracking a confirmed list ----------
def test_confirmed_list_is_in_the_prompt_and_stored_on_the_verdict(repo, settings):
    confirmed = [InventoryItem(**i) for i in PILE]
    seen = [{"t": "00:01", "description": d["description"], "scanned": False, "inventory_id": n}
            for n, d in enumerate(PILE, start=1)]
    answer = verdict_json(verdict="SCAN_AVOIDANCE", items_seen=3, items_scanned=0, seen_items=seen)
    gateway = FakeGateway([text(answer)])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4", inventory=confirmed)

    briefing = gateway.calls[0][1][0].parts[-1].text
    assert "#3 flat cloth flower" in briefing and "inventory_id" in briefing
    assert [i["description"] for i in events[-1]["incident"]["verdict"]["inventory"]] == [
        i["description"] for i in PILE
    ]


def test_a_confirmed_item_left_out_is_named_in_the_recheck(repo, settings):
    confirmed = [InventoryItem(**i) for i in PILE]
    two = [{"t": "00:01", "description": PILE[n - 1]["description"], "scanned": False, "inventory_id": n}
           for n in (1, 3)]
    three = two + [{"t": "00:05", "description": "black biscuit packet", "scanned": False, "inventory_id": 2}]
    gateway = FakeGateway([
        text(verdict_json(verdict="CONCEALMENT", items_seen=2, items_scanned=0, seen_items=two)),
        text(verdict_json(verdict="CONCEALMENT", items_seen=3, items_scanned=0, seen_items=three)),
    ])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4", inventory=confirmed)

    recheck = gateway.calls[1][1][-1].parts[0].text
    assert "Item #2 (black biscuit packet) from the confirmed list isn't accounted for" in recheck
    assert events[-1]["incident"]["verdict"]["items_seen"] == 3


def test_reconcile_drops_bad_or_duplicate_inventory_ids():
    confirmed = [InventoryItem(description=d) for d in ("bottle", "flower")]
    verdict = VerdictOut(verdict="BENIGN", confidence=0.9, items_seen=3, items_scanned=0, reason="r", seen_items=[
        {"t": "1", "description": "bottle", "scanned": False, "inventory_id": 1, "receipt_line": 1},
        {"t": "2", "description": "bottle?", "scanned": False, "inventory_id": 1},
        {"t": "3", "description": "pen", "scanned": False, "inventory_id": 9},
    ])
    checked, _, soft = reconcile(verdict, [ReceiptLine(name="bottle", price_inr=0)], confirmed)
    assert [i.inventory_id for i in checked.seen_items] == [1, None, None]
    assert any("#1 (bottle) was used for more than one item" in p for p in soft)
    assert any("Item #2 (flower)" in p for p in soft)


def test_different_confirmed_lists_do_not_share_a_cached_answer(repo, settings):
    accounted = json.loads(verdict_json())["seen_items"]
    accounted[0]["inventory_id"] = 1
    answer = verdict_json(seen_items=accounted)
    gateway = FakeGateway([text(answer), text(answer)])
    txn = repo.get_transaction("TXN-L2-2041")

    run(repo, gateway, settings, transaction=txn, inventory=[InventoryItem(description="milk")])
    second = run(repo, gateway, settings, transaction=txn, inventory=[InventoryItem(description="wine")])

    assert second[-1]["cached"] is False and len(gateway.calls) == 2


def test_seed_is_sent_on_the_main_call(repo, settings):
    gateway = FakeGateway([text(verdict_json())])
    run(repo, gateway, replace(settings, gemini_seed=42), transaction=repo.get_transaction("TXN-L2-2041"))
    assert gateway.calls[0][2].seed == 42
    assert CLIP  # shared fixture import


# ---------- eval stability ----------
def test_stability_across_repeated_runs():
    def result(run_no, got, unscanned):
        return ClipResult(file="clip2.mp4", angle="left", lighting="normal", model="m",
                          expected_verdict="SCAN_AVOIDANCE", expected_unscanned=1, predicted_verdict=got,
                          predicted_unscanned=unscanned, run=run_no)

    results = [result(1, "SCAN_AVOIDANCE", 1), result(2, "SCAN_AVOIDANCE", 2), result(3, "BENIGN", 0)]

    s = stability(results)["clip2.mp4"]
    assert s == {"runs": 3, "verdict_right": round(2 / 3, 3), "count_right": round(1 / 3, 3),
                 "unscanned_answers": [0, 1, 2]}
    assert "## Stability across repeated runs" in to_markdown(results, "t")
