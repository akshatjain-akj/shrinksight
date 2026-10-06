from app.cleanup import select_test_data


def test_only_test_data_is_selected_and_seed_data_is_kept():
    docs = {
        "incidents": {"inc-seed-001": {"source": "seed"}, "inc-1a2b": {"source": "live"}},
        "transactions": {"TXN-L1-1001": {"source": "seed"}, "TXN-LIVE-9f": {"source": "live"}},
        "cache": {"inv:abc": {"incident_id": "inc-1a2b"}, "inventory:def": {}, "compile:x": {}},
        "feedback": {"inc-seed-005": {}, "inc-1a2b": {}},
        "edge_config": {"cam-aisle-2": {"level": 1}},
    }

    doomed = select_test_data(docs)

    assert doomed == {
        "incidents": ["inc-1a2b"],
        "transactions": ["TXN-LIVE-9f"],
        "cache": ["inv:abc"],
        "feedback": ["inc-1a2b"],
        "edge_config": ["cam-aisle-2"],
    }


def test_missing_collections_are_fine():
    assert select_test_data({}) == {"incidents": [], "transactions": [], "cache": [], "feedback": [],
                                    "edge_config": []}
