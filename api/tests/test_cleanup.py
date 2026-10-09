from app.cleanup import select_test_data


def test_only_test_data_is_selected_and_seed_data_is_kept():
    docs = {
        "incidents": {"inc-seed-001": {"source": "seed"}, "inc-1a2b": {"source": "live"}},
        "transactions": {"TXN-L1-1001": {"source": "seed"}, "TXN-LIVE-9f": {"source": "live"}},
        "cache": {"inv:abc": {"incident_id": "inc-1a2b"}, "inventory:def": {}, "compile:x": {}},
        "feedback": {"inc-seed-005": {}, "inc-seed-002": {}, "inc-1a2b": {}},
        "edge_config": {"cam-aisle-2": {"level": 1}},
        "cameras": {"cam-sco-1": {}, "cam-judge-1": {}},
        "zones": {"z-scan-1": {"camera_id": "cam-sco-1"}, "z-extra": {"camera_id": "cam-aisle-4"},
                  "z-judge": {"camera_id": "cam-judge-1"}},
        "rules": {"rule-seed-001": {"source": "seed"}, "rule-9f": {"source": "live"}},
    }

    doomed = select_test_data(docs)

    assert doomed == {
        "incidents": ["inc-1a2b"],
        "transactions": ["TXN-LIVE-9f"],
        "cache": ["inv:abc"],
        "feedback": ["inc-1a2b", "inc-seed-002"],
        "edge_config": ["cam-aisle-2"],
        "cameras": ["cam-judge-1"],
        "zones": ["z-judge"],
        "rules": ["rule-9f"],
    }


def test_missing_collections_are_fine():
    assert select_test_data({}) == {"incidents": [], "transactions": [], "cache": [], "feedback": [],
                                    "edge_config": [], "cameras": [], "zones": [], "rules": []}


def test_demo_clip_results_are_kept_unless_asked():
    docs = {"incidents": {"inc-demo": {"source": "demo"}, "inc-live": {"source": "live"}},
            "cache": {"demo:demo~floor~a.mp4": {"incident_id": "inc-demo"}, "inv:x": {}}}

    assert select_test_data(docs)["incidents"] == ["inc-live"]
    assert select_test_data(docs)["cache"] == ["inv:x"]
    every = select_test_data(docs, include_demo=True)
    assert every["incidents"] == ["inc-demo", "inc-live"]
    assert every["cache"] == ["demo:demo~floor~a.mp4", "inv:x"]
