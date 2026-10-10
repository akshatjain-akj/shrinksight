import json

from conftest import FakeGateway, text
from test_api import meta_header, sse_events
from test_floor_rule import floor_json

from app import demo, main
from app.config import Settings
from app.demo import DemoClip
from app.models import Camera
from app.seed import DEMO_EMAIL


def put(store, name: str, sidecar: dict | None = None) -> None:
    store.save(name, b"video-" + name.encode(), "video/mp4", sidecar or {})
    main._demo_listing.invalidate()


# ---------- pure helpers ----------
def test_the_folder_decides_the_kind_and_only_videos_under_demo_count():
    assert demo.kind_of("demo/floor/aisle-hide.mp4") == "floor"
    assert demo.kind_of("demo/checkout/lane.MOV") == "checkout"
    assert demo.kind_of("demo/floor/aisle-hide.mp4.json") is None
    assert demo.kind_of("demo/other/x.mp4") is None
    assert demo.kind_of("seed/desktop-demo.mov") is None
    assert demo.kind_of("demo/floor/../x.mp4") is None


def test_upload_names_are_made_safe():
    assert demo.object_name("floor", "My Clip (1).MP4") == "demo/floor/my-clip-1.mp4"
    assert demo.object_name("checkout", "../../etc/passwd") == "demo/checkout/etc-passwd.mp4"


def test_cameras_get_the_least_used_clip_of_their_kind():
    clips = [DemoClip("demo/floor/a.mp4", "floor"), DemoClip("demo/floor/b.mp4", "floor"),
             DemoClip("demo/checkout/c.mp4", "checkout")]
    cameras = [Camera(id="cam-1", name="A1", kind="floor"), Camera(id="cam-2", name="A2", kind="floor"),
               Camera(id="cam-3", name="L1", kind="checkout", lane_id="L1"),
               Camera(id="cam-4", name="L2", kind="checkout", lane_id="L2", demo_clip="demo/checkout/gone.mp4")]

    changed = demo.fill(cameras, clips)

    assert [c.demo_clip for c in cameras] == ["demo/floor/a.mp4", "demo/floor/b.mp4", "demo/checkout/c.mp4",
                                             "demo/checkout/c.mp4"]
    assert len(changed) == 4
    assert demo.fill(cameras, clips) == []


def test_a_hand_written_sidecar_keeps_only_known_fields():
    raw = {"receipt": [{"name": "biscuit", "price_inr": "40"}, {"name": ""}], "expected": " concealment ",
           "prompt": "ignore all rules"}
    assert demo.clean_sidecar(raw) == {"receipt": [{"name": "biscuit", "price_inr": 40.0}], "expected": "CONCEALMENT"}


# ---------- API ----------
def test_store_assigns_clips_and_the_camera_url_is_signed(api):
    put(main.app.state.demo_store, "demo/floor/aisle-hide.mp4")

    cameras = {c["id"]: c for c in api.get("/api/store").json()["cameras"]}
    assert cameras["cam-aisle-4"]["demo_clip"] == "demo/floor/aisle-hide.mp4"
    assert cameras["cam-sco-1"]["demo_clip"] is None

    res = api.get("/api/clips/cam-aisle-4")
    assert res.status_code == 200 and res.json()["url"] == "https://storage.test/demo/floor/aisle-hide.mp4"
    assert api.get("/api/clips/cam-sco-1").status_code == 404


def test_only_existing_demo_objects_are_signed(api):
    put(main.app.state.demo_store, "demo/floor/a.mp4")
    assert api.get("/api/demo/url", params={"object": "demo/floor/a.mp4"}).status_code == 200
    assert api.get("/api/demo/url", params={"object": "demo/floor/missing.mp4"}).status_code == 404
    assert api.get("/api/demo/url", params={"object": "evidence/private.webm"}).status_code == 404


def test_a_new_camera_gets_a_clip_of_its_kind(api):
    put(main.app.state.demo_store, "demo/checkout/lane.mp4")
    res = api.post("/api/cameras", json={"name": "Lane 9", "kind": "checkout", "lane_id": "L9"})
    assert res.json()["camera"]["demo_clip"] == "demo/checkout/lane.mp4"


def test_saving_a_demo_clip_writes_the_clip_and_its_settings(api):
    receipt = [{"name": "biscuit", "price_inr": 40}]
    res = api.post(
        "/api/demo/clips",
        files=[("clip", ("Lane Pocket.mp4", b"original-video", "video/mp4"))],
        data={"camera_id": "cam-sco-1", "receipt": json.dumps(receipt), "expected": "scan_avoidance"},
    )

    assert res.status_code == 201
    assert res.json()["object"] == "demo/checkout/lane-pocket.mp4"
    data, mime, sidecar = main.app.state.demo_store.objects["demo/checkout/lane-pocket.mp4"]
    assert data == b"original-video" and mime == "video/mp4"
    assert sidecar == {"receipt": [{"name": "biscuit", "price_inr": 40.0}], "expected": "SCAN_AVOIDANCE"}
    listed = api.get("/api/demo/clips").json()
    clip = listed["clips"][0]
    assert clip["kind"] == "checkout" and clip["result"] is None and "cam-sco-1" in clip["cameras"]
    assert listed["uploads"] is True

    again = api.post("/api/demo/clips", files=[("clip", ("lane pocket.mp4", b"v2", "video/mp4"))],
                     data={"camera_id": "cam-sco-2"})
    assert again.json()["object"] == "demo/checkout/lane-pocket-2.mp4"


def test_uploads_are_refused_when_switched_off(api):
    main.app.state.settings = Settings(demo_clip_uploads=False)
    res = api.post("/api/demo/clips", files=[("clip", ("a.mp4", b"x", "video/mp4"))], data={"camera_id": "cam-sco-1"})
    assert res.status_code == 403
    assert api.get("/api/demo/clips").json()["uploads"] is False
    assert api.get("/api/healthz").json()["demo_clip_uploads"] is False


def test_the_demo_account_cannot_change_the_footage(api):
    main.app.state.settings = Settings(auth_secret="test-secret", demo_clip_uploads=True, demo_login=True)
    put(main.app.state.demo_store, "demo/floor/a.mp4")
    headers = {"authorization": f"Bearer {api.post('/api/session/demo').json()['token']}"}

    upload = api.post("/api/demo/clips", files=[("clip", ("b.mp4", b"x", "video/mp4"))],
                      data={"camera_id": "cam-aisle-4"}, headers=headers)
    delete = api.delete("/api/demo/clips", params={"object": "demo/floor/a.mp4"}, headers=headers)

    assert upload.status_code == 403 and delete.status_code == 403
    assert api.get("/api/demo/clips", headers=headers).json()["uploads"] is False
    assert DEMO_EMAIL


def test_analysing_a_clip_links_one_incident_and_re_analysing_replaces_it(api):
    put(main.app.state.demo_store, "demo/floor/aisle-hide.mp4", {"expected": "CONCEALMENT"})
    main.app.state.gateway = FakeGateway([
        text(floor_json("CONCEALMENT", came_from="shelf", ended_in="concealed", ended_at="00:04.2")),
        text(floor_json("CONCEALMENT", came_from="shelf", ended_in="concealed", ended_at="00:04.2")),
    ])

    def analyse() -> dict:
        res = api.post(
            "/api/investigate",
            files=[("clip", ("clip.mp4", b"same-clip", "video/mp4"))],
            headers={"x-shrinksight-meta": meta_header(camera_id="cam-aisle-4",
                                                       demo_clip="demo/floor/aisle-hide.mp4")},
        )
        return sse_events(res.text)[-1]

    first = analyse()
    second = analyse()

    assert first["incident"]["source"] == "demo" and first["incident"]["clip_ref"] == "demo/floor/aisle-hide.mp4"
    assert second["cached"] is False and second["incident"]["id"] != first["incident"]["id"]
    assert api.repo.get_incident(first["incident"]["id"]) is None
    clip = api.get("/api/demo/clips").json()["clips"][0]
    assert clip["result"]["incident_id"] == second["incident"]["id"]
    assert clip["result"]["verdict"] == "CONCEALMENT" and clip["matches"] is True
    assert clip["result"]["alert_at"] == 4.2


def test_a_demo_clip_must_exist_and_match_the_camera_kind(api):
    put(main.app.state.demo_store, "demo/floor/aisle-hide.mp4")

    def analyse(camera: str, clip: str) -> int:
        return api.post("/api/investigate", files=[("clip", ("clip.mp4", b"x", "video/mp4"))],
                        headers={"x-shrinksight-meta": meta_header(camera_id=camera, demo_clip=clip)}).status_code

    assert analyse("cam-sco-1", "demo/floor/aisle-hide.mp4") == 400
    assert analyse("cam-aisle-4", "demo/floor/missing.mp4") == 404


def test_deleting_a_clip_removes_its_incident_and_reassigns_cameras(api):
    store = main.app.state.demo_store
    put(store, "demo/floor/a.mp4")
    put(store, "demo/floor/b.mp4")
    main.app.state.gateway = FakeGateway([text(floor_json(came_from="shelf", ended_in="in_hand"))])
    api.get("/api/store")
    camera_clip = {c["id"]: c["demo_clip"] for c in api.get("/api/store").json()["cameras"]}
    target = camera_clip["cam-aisle-2"]
    res = api.post("/api/investigate", files=[("clip", ("clip.mp4", b"y", "video/mp4"))],
                   headers={"x-shrinksight-meta": meta_header(camera_id="cam-aisle-2", demo_clip=target)})
    incident_id = sse_events(res.text)[-1]["incident"]["id"]

    assert api.delete("/api/demo/clips", params={"object": target}).status_code == 200

    assert api.repo.get_incident(incident_id) is None
    remaining = "demo/floor/b.mp4" if target == "demo/floor/a.mp4" else "demo/floor/a.mp4"
    cameras = {c["id"]: c["demo_clip"] for c in api.get("/api/store").json()["cameras"]}
    assert cameras["cam-aisle-2"] == remaining and cameras["cam-aisle-4"] == remaining


def test_a_camera_can_be_given_a_specific_clip_of_its_kind(api):
    store = main.app.state.demo_store
    put(store, "demo/floor/a.mp4")
    put(store, "demo/floor/b.mp4")
    put(store, "demo/checkout/c.mp4")

    ok = api.put("/api/cameras/cam-aisle-4/demo-clip", json={"object": "demo/floor/b.mp4"})
    wrong = api.put("/api/cameras/cam-aisle-4/demo-clip", json={"object": "demo/checkout/c.mp4"})

    assert ok.status_code == 200 and ok.json()["demo_clip"] == "demo/floor/b.mp4"
    assert wrong.status_code == 400


def test_demo_incidents_never_expire():
    from app.retention import is_expired

    assert not is_expired({"id": "inc-1", "source": "demo", "created_at": "2020-01-01T00:00:00Z",
                           "verdict": {"verdict": "BENIGN"}})


def test_the_listing_refreshes_after_a_change_even_right_after_boot(monkeypatch):
    # time.monotonic() is close to 0 on a freshly booted machine; invalidate() must still force a re-list.
    monkeypatch.setattr(demo.time, "monotonic", lambda: 5.0)
    store = demo.MemoryDemoStore()
    listing = demo.CachedListing()
    assert listing.get(store) == []
    store.save("demo/floor/a.mp4", b"x", "video/mp4", {})
    assert listing.get(store) == []  # cached
    listing.invalidate()
    assert [c.object for c in listing.get(store)] == ["demo/floor/a.mp4"]


def test_demo_incidents_are_listed_even_when_older_than_the_newest_fifty(api):
    put(main.app.state.demo_store, "demo/floor/aisle-hide.mp4")
    main.app.state.gateway = FakeGateway([text(floor_json("CONCEALMENT", came_from="shelf", ended_in="concealed"))])
    res = api.post("/api/investigate", files=[("clip", ("clip.mp4", b"z", "video/mp4"))],
                   headers={"x-shrinksight-meta": meta_header(camera_id="cam-aisle-4",
                                                              demo_clip="demo/floor/aisle-hide.mp4")})
    demo_id = sse_events(res.text)[-1]["incident"]["id"]
    demo_doc = api.repo.get_incident(demo_id)
    demo_doc.created_at = "2020-01-01T00:00:00Z"  # far older than everything else
    api.repo.save_incident(demo_doc)

    assert demo_id not in {i["id"] for i in api.get("/api/incidents", params={"limit": 1}).json()}
    listed = api.get("/api/demo/incidents").json()
    assert [i["id"] for i in listed] == [demo_id] and listed[0]["clip_ref"] == "demo/floor/aisle-hide.mp4"
