import base64
import json

from conftest import FakeGateway, text
from test_investigator import run, verdict_json

from app import main
from app.models import ZoneHint
from app.zones import from_crop, to_crop, zones_context

CROP = [200, 300, 700, 800]  # ymin, xmin, ymax, xmax of the full view, 0-1000
SCANNER = ZoneHint(zone_id="z-scan-2", kind="scanner", description="paper square",
                   polygon=[{"x": 0.5, "y": 0.4}, {"x": 0.6, "y": 0.4}, {"x": 0.6, "y": 0.5}, {"x": 0.5, "y": 0.5}])


def test_crop_round_trip():
    full = [400, 500, 500, 600]
    in_crop = to_crop(full, CROP)
    assert in_crop == [400, 400, 600, 600]
    assert from_crop(in_crop, CROP) == full
    assert to_crop(full, None) == full and from_crop(full, None) == full


def test_zone_boxes_are_given_in_video_coordinates_when_cropped():
    text_ = zones_context([SCANNER], [], CROP)
    assert "[400, 400, 600, 600]" in text_ and "VIDEO coordinates" in text_
    assert "[400, 500, 500, 600]" in zones_context([SCANNER], [])


def test_item_boxes_are_mapped_back_to_the_full_view_and_crop_is_recorded(repo, settings):
    gateway = FakeGateway([text(verdict_json())])  # the wine bottle box is [300, 600, 640, 700] in crop coordinates

    events = run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"),
                 zones=[SCANNER], video_crop=CROP)

    incident = events[-1]["incident"]
    wine = next(i for i in incident["verdict"]["seen_items"] if "wine" in i["description"])
    assert wine["box_2d"] == [350, 600, 520, 650]
    assert incident["video_crop"] == CROP
    assert "VIDEO coordinates" in gateway.calls[0][1][0].parts[-1].text


def test_crop_changes_the_cache_key(repo, settings):
    gateway = FakeGateway([text(verdict_json()), text(verdict_json())])
    txn = repo.get_transaction("TXN-L2-2041")

    run(repo, gateway, settings, transaction=txn)
    second = run(repo, gateway, settings, transaction=txn, video_crop=CROP)

    assert second[-1]["cached"] is False


def test_invalid_crop_is_rejected_by_the_api(api):
    meta = base64.urlsafe_b64encode(json.dumps(
        {"camera_id": "cam-sco-2", "video_crop": [500, 500, 510, 510]}).encode()).decode().rstrip("=")
    res = api.post("/api/investigate", content=b"x", headers={"content-type": "video/webm", "x-shrinksight-meta": meta})
    assert res.status_code == 400
    assert main.app  # app imported for the fixture


def test_custody_timestamps_provenance_and_look_alikes_are_in_the_prompt():
    from app.investigator import SYSTEM_PROMPT, VERDICT_INSTRUCTION
    from app.models import SeenItem

    assert "picked_up_at, scanner_at" in SYSTEM_PROMPT
    assert "comes out of the shopper's own clothing or bag and goes back there is a personal item" in SYSTEM_PROMPT
    assert "pulling stuck plastic bags apart" in SYSTEM_PROMPT
    assert "ended_in" in VERDICT_INSTRUCTION
    item = SeenItem(t="00:01", description="x", scanned=True, picked_up_at="00:01.0", scanner_at=None,
                    ended_at="00:02.5")
    assert item.scanner_at is None and item.ended_at == "00:02.5"
