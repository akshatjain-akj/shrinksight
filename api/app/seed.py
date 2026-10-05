"""Synthetic demo store. Everything here is invented; no real people, stores or brands.

Bump SEED_VERSION whenever this file changes so deployed instances re-seed Firestore.
Seeded documents use fixed ids, so re-seeding never duplicates and never touches live incidents.
"""

from .models import (
    Camera,
    Feedback,
    Incident,
    ReceiptLine,
    Rule,
    RuleSpec,
    SeenItem,
    Sku,
    TimelineEvent,
    ToolCallLog,
    Transaction,
    UnscannedItem,
    VerdictOut,
    Zone,
)

SEED_VERSION = "2026-10-05.memory"
STORE_NAME = "Demo Mart (synthetic)"

CAMERAS = [
    Camera(id="cam-sco-1", name="Self-checkout · Lane 1", kind="checkout", lane_id="L1",
           zone_ids=["z-pick-1", "z-scan-1", "z-bag-1"]),
    Camera(id="cam-sco-2", name="Self-checkout · Lane 2", kind="checkout", lane_id="L2",
           zone_ids=["z-pick-2", "z-scan-2", "z-bag-2"]),
    Camera(id="cam-aisle-4", name="Aisle 4 · Spirits", kind="floor", zone_ids=["z-spirits"]),
    Camera(id="cam-aisle-2", name="Aisle 2 · Snacks", kind="floor", zone_ids=["z-snacks", "z-exit"]),
]

ZONES = [
    Zone(id="z-pick-1", name="Item pile · Lane 1", camera_id="cam-sco-1", kind="pickup"),
    Zone(id="z-scan-1", name="Scanner · Lane 1", camera_id="cam-sco-1", kind="scanner"),
    Zone(id="z-bag-1", name="Bagging area · Lane 1", camera_id="cam-sco-1", kind="bagging"),
    Zone(id="z-pick-2", name="Item pile · Lane 2", camera_id="cam-sco-2", kind="pickup"),
    Zone(id="z-scan-2", name="Scanner · Lane 2", camera_id="cam-sco-2", kind="scanner"),
    Zone(id="z-bag-2", name="Bagging area · Lane 2", camera_id="cam-sco-2", kind="bagging"),
    Zone(id="z-spirits", name="Spirits shelf", camera_id="cam-aisle-4", kind="shelf", high_value=True),
    Zone(id="z-snacks", name="Snacks shelf", camera_id="cam-aisle-2", kind="shelf"),
    Zone(id="z-exit", name="Store exit", camera_id="cam-aisle-2", kind="exit"),
]

SKUS = [
    Sku(sku="SKU-0001", name="Toned milk 1L", price_inr=68),
    Sku(sku="SKU-0002", name="Whole wheat bread", price_inr=50),
    Sku(sku="SKU-0003", name="Basmati rice 1kg", price_inr=140),
    Sku(sku="SKU-0004", name="Sunflower oil 1L", price_inr=165),
    Sku(sku="SKU-0005", name="Red wine 750ml bottle", price_inr=1850, high_value=True),
    Sku(sku="SKU-0006", name="Whisky 750ml bottle", price_inr=2400, high_value=True),
    Sku(sku="SKU-0007", name="Potato chips 150g packet", price_inr=50),
    Sku(sku="SKU-0008", name="Chocolate bar", price_inr=80),
    Sku(sku="SKU-0009", name="Instant noodles pack", price_inr=60),
    Sku(sku="SKU-0010", name="Shampoo 340ml bottle", price_inr=290),
    Sku(sku="SKU-0011", name="Toothpaste 150g", price_inr=110),
    Sku(sku="SKU-0012", name="Coffee 200g jar", price_inr=450),
    Sku(sku="SKU-0013", name="Tea 500g box", price_inr=280),
    Sku(sku="SKU-0014", name="Biscuits pack", price_inr=40),
    Sku(sku="SKU-0015", name="Cereal 500g box", price_inr=320),
    Sku(sku="SKU-0016", name="Apples 1kg", price_inr=220),
    Sku(sku="SKU-0017", name="Bananas dozen", price_inr=70),
    Sku(sku="SKU-0018", name="Detergent 1kg", price_inr=210),
    Sku(sku="SKU-0019", name="Soft drink 1.25L bottle", price_inr=90),
    Sku(sku="SKU-0020", name="Paneer 200g", price_inr=95),
    Sku(sku="SKU-0021", name="Butter 100g", price_inr=60),
    Sku(sku="SKU-0022", name="Honey 500g jar", price_inr=260),
    Sku(sku="SKU-0023", name="Almonds 250g packet", price_inr=330, high_value=True),
    Sku(sku="SKU-0024", name="Razor cartridges pack", price_inr=650, high_value=True),
    Sku(sku="SKU-0025", name="AA batteries 4-pack", price_inr=180),
]
_PRICE = {s.sku: s for s in SKUS}


def _line(sku: str) -> ReceiptLine:
    s = _PRICE[sku]
    return ReceiptLine(name=s.name, price_inr=s.price_inr, sku=s.sku)


TRANSACTIONS = [
    Transaction(id="TXN-L2-2041", lane_id="L2", started_at="2026-10-03T08:58:10Z",
                lines=[_line("SKU-0001"), _line("SKU-0002"), _line("SKU-0007")]),
    Transaction(id="TXN-L1-1001", lane_id="L1", started_at="2026-10-03T07:40:00Z",
                lines=[_line("SKU-0001"), _line("SKU-0002"), _line("SKU-0007"), _line("SKU-0008")]),
    Transaction(id="TXN-L1-1002", lane_id="L1", started_at="2026-10-03T06:15:32Z",
                lines=[_line("SKU-0015"), _line("SKU-0011"), _line("SKU-0010")]),
    Transaction(id="TXN-L1-1003", lane_id="L1", started_at="2026-10-03T05:02:11Z",
                lines=[_line("SKU-0016"), _line("SKU-0017"), _line("SKU-0013"), _line("SKU-0014"),
                       _line("SKU-0021")]),
    Transaction(id="TXN-L2-2042", lane_id="L2", started_at="2026-10-03T09:20:45Z",
                lines=[_line("SKU-0015"), _line("SKU-0016"), _line("SKU-0013")]),
    Transaction(id="TXN-L2-2043", lane_id="L2", started_at="2026-10-03T09:41:03Z",
                lines=[_line("SKU-0019"), _line("SKU-0009"), _line("SKU-0014"), _line("SKU-0004")]),
]

INCIDENTS = [
    Incident(
        id="inc-seed-001", created_at="2026-10-03T09:00:02Z", camera_id="cam-sco-2",
        camera_name="Self-checkout · Lane 2", camera_kind="checkout", status="NEEDS_REVIEW",
        transaction_id="TXN-L2-2041", receipt=TRANSACTIONS[0].lines, model="seed", source="seed",
        latency_ms=5400, est_loss_inr=1850,
        unscanned_items=[UnscannedItem(t="00:06.4", description="green glass wine bottle",
                                       price_inr=1850, matched_sku="SKU-0005")],
        tool_calls=[ToolCallLog(name="get_pos_transaction", args={"lane_id": "L2"}),
                    ToolCallLog(name="get_sku_price", args={"description": "green glass wine bottle"})],
        verdict=VerdictOut(
            verdict="SCAN_AVOIDANCE", confidence=0.91, items_seen=4, items_scanned=3,
            seen_items=[
                SeenItem(t="00:01.2", description="milk carton", scanned=True, box_2d=[420, 380, 610, 470]),
                SeenItem(t="00:03.0", description="bread loaf", scanned=True, box_2d=[400, 360, 600, 520]),
                SeenItem(t="00:06.4", description="green glass wine bottle", scanned=False,
                         box_2d=[300, 610, 640, 700]),
                SeenItem(t="00:08.1", description="chips packet", scanned=True, box_2d=[410, 370, 590, 500]),
            ],
            timeline=[TimelineEvent(t="00:01.2", event="scans milk carton"),
                      TimelineEvent(t="00:03.0", event="scans bread loaf"),
                      TimelineEvent(t="00:06.4", event="moves wine bottle beside the scanner into the bag"),
                      TimelineEvent(t="00:08.1", event="scans chips packet")],
            reason="Four items were handled but the receipt has three. The wine bottle passed beside the "
                   "scanner at 00:06 and went straight into the bag.",
        ),
    ),
    Incident(
        id="inc-seed-002", created_at="2026-10-03T08:12:40Z", camera_id="cam-aisle-4",
        camera_name="Aisle 4 · Spirits", camera_kind="floor", status="NEEDS_REVIEW", model="seed",
        source="seed", latency_ms=4700, est_loss_inr=2400,
        unscanned_items=[UnscannedItem(t="00:03.4", description="whisky bottle", price_inr=2400,
                                       matched_sku="SKU-0006")],
        tool_calls=[ToolCallLog(name="get_zone_policy", args={"zone_id": "z-spirits"}),
                    ToolCallLog(name="get_sku_price", args={"description": "whisky bottle"})],
        verdict=VerdictOut(
            verdict="CONCEALMENT", confidence=0.86, items_seen=1, items_scanned=0,
            seen_items=[SeenItem(t="00:03.4", description="whisky bottle", scanned=False,
                                 box_2d=[350, 450, 620, 540])],
            timeline=[TimelineEvent(t="00:02.1", event="takes a bottle from the spirits shelf"),
                      TimelineEvent(t="00:03.4", event="places the bottle inside a jacket"),
                      TimelineEvent(t="00:05.0", event="walks away from the shelf")],
            reason="A bottle was taken from the high-value spirits shelf and placed inside a jacket "
                   "rather than a basket.",
        ),
    ),
    Incident(
        id="inc-seed-003", created_at="2026-10-03T07:55:18Z", camera_id="cam-aisle-2",
        camera_name="Aisle 2 · Snacks", camera_kind="floor", status="REJECTED", model="seed",
        source="seed", latency_ms=3900,
        tool_calls=[ToolCallLog(name="get_zone_policy", args={"zone_id": "z-snacks"})],
        verdict=VerdictOut(
            verdict="BENIGN", confidence=0.93, items_seen=0, items_scanned=0,
            timeline=[TimelineEvent(t="00:01.5", event="hand moves to trouser pocket"),
                      TimelineEvent(t="00:02.2", event="takes out a phone and looks at it")],
            reason="The hand went to the pocket to take out a phone. No merchandise was in hand.",
        ),
    ),
    Incident(
        id="inc-seed-004", created_at="2026-10-03T07:41:05Z", camera_id="cam-sco-1",
        camera_name="Self-checkout · Lane 1", camera_kind="checkout", status="REJECTED",
        transaction_id="TXN-L1-1001", receipt=TRANSACTIONS[1].lines, model="seed", source="seed",
        latency_ms=5100,
        tool_calls=[ToolCallLog(name="get_pos_transaction", args={"lane_id": "L1"})],
        verdict=VerdictOut(
            verdict="BENIGN", confidence=0.88, items_seen=4, items_scanned=4,
            seen_items=[SeenItem(t="00:01.0", description="milk carton", scanned=True),
                        SeenItem(t="00:02.6", description="bread loaf", scanned=True),
                        SeenItem(t="00:04.9", description="chips packet", scanned=True),
                        SeenItem(t="00:07.3", description="chocolate bar", scanned=True)],
            timeline=[TimelineEvent(t="00:04.1", event="chips packet scan fails, shopper rescans"),
                      TimelineEvent(t="00:04.9", event="rescan succeeds")],
            reason="The unusual hand movement was a rescan after a failed barcode read. All four items "
                   "match the receipt.",
        ),
    ),
    Incident(
        id="inc-seed-005", created_at="2026-10-03T06:16:20Z", camera_id="cam-sco-1",
        camera_name="Self-checkout · Lane 1", camera_kind="checkout", status="RESOLVED_CONFIRMED",
        reviewed_at="2026-10-03T06:30:00Z", transaction_id="TXN-L1-1002", receipt=TRANSACTIONS[2].lines,
        model="seed", source="seed", latency_ms=6200, est_loss_inr=650,
        unscanned_items=[UnscannedItem(t="00:05.2", description="small blister pack under cereal box",
                                       price_inr=650, matched_sku="SKU-0024")],
        tool_calls=[ToolCallLog(name="get_pos_transaction", args={"lane_id": "L1"}),
                    ToolCallLog(name="get_sku_price", args={"description": "razor cartridges pack"})],
        verdict=VerdictOut(
            verdict="SCAN_AVOIDANCE", confidence=0.79, items_seen=4, items_scanned=3,
            seen_items=[SeenItem(t="00:05.2", description="cereal box", scanned=True,
                                 box_2d=[380, 400, 640, 560]),
                        SeenItem(t="00:05.2", description="small blister pack under cereal box",
                                 scanned=False, box_2d=[600, 420, 660, 520]),
                        SeenItem(t="00:07.9", description="toothpaste box", scanned=True),
                        SeenItem(t="00:09.6", description="shampoo bottle", scanned=True)],
            timeline=[TimelineEvent(t="00:05.2", event="cereal box scanned with a small pack held beneath it")],
            reason="A small pack was held flat under the cereal box so only the cereal was scanned.",
        ),
        review_reason="missed_scan",
    ),
    Incident(
        id="inc-seed-006", created_at="2026-10-02T17:02:41Z", camera_id="cam-sco-1",
        camera_name="Self-checkout · Lane 1", camera_kind="checkout", status="RESOLVED_DISMISSED",
        reviewed_at="2026-10-02T17:15:00Z", transaction_id="TXN-L1-1003", receipt=TRANSACTIONS[3].lines,
        model="seed", source="seed", latency_ms=5800, est_loss_inr=0,
        unscanned_items=[UnscannedItem(t="00:08.3", description="black phone")],
        tool_calls=[ToolCallLog(name="get_pos_transaction", args={"lane_id": "L1"})],
        verdict=VerdictOut(
            verdict="SCAN_AVOIDANCE", confidence=0.58, items_seen=6, items_scanned=5,
            seen_items=[SeenItem(t="00:01.4", description="apples bag", scanned=True, receipt_line=1),
                        SeenItem(t="00:02.9", description="bananas", scanned=True, receipt_line=2),
                        SeenItem(t="00:04.2", description="tea box", scanned=True, receipt_line=3),
                        SeenItem(t="00:05.6", description="biscuits pack", scanned=True, receipt_line=4),
                        SeenItem(t="00:06.8", description="butter pack", scanned=True, receipt_line=5),
                        SeenItem(t="00:08.3", description="black phone", scanned=False,
                                 location="never_near_scanner", ended_in="hand_or_pocket")],
            timeline=[TimelineEvent(t="00:08.3", event="picks a phone up from the bagging shelf and pockets it")],
            reason="A black handheld object went from the bagging shelf into a pocket without being scanned.",
        ),
        review_reason="personal_item",
        review_note="Shopper's own phone, put down while paying",
    ),
]

# The manager's decisions above, as the per-camera memory Gemini sees on new Lane 1 investigations.
FEEDBACK = [
    Feedback(incident_id="inc-seed-006", camera_id="cam-sco-1", decision="dismiss", reason="personal_item",
             note="Shopper's own phone, put down while paying", verdict="SCAN_AVOIDANCE",
             summary=INCIDENTS[5].verdict.reason, items=["black phone"], reviewed_at="2026-10-02T17:15:00Z"),
    Feedback(incident_id="inc-seed-005", camera_id="cam-sco-1", decision="confirm", reason="missed_scan",
             verdict="SCAN_AVOIDANCE", summary=INCIDENTS[4].verdict.reason,
             items=["small blister pack under cereal box"], reviewed_at="2026-10-03T06:30:00Z"),
]

RULES = [
    Rule(
        id="rule-seed-001", source="seed", created_at="2026-10-03T06:00:00Z",
        source_text="Alert if anyone stays at the spirits shelf for more than 45 seconds after 9pm",
        spec=RuleSpec(supported=True, type="DWELL", zone_id="z-spirits", min_seconds=45,
                      active_from="21:00", active_to="06:00", severity="MEDIUM",
                      summary="Loitering at the Spirits shelf for over 45 s, 21:00–06:00"),
    ),
]
