from app.evaluation import ClipResult, by_group, summarise, to_markdown


def clip(file, expected, got, exp_unscanned=0, got_unscanned=0, angle="top", latency=4000, error=None):
    return ClipResult(file=file, angle=angle, lighting="normal", model="m", expected_verdict=expected,
                      expected_unscanned=exp_unscanned, predicted_verdict=None if error else got,
                      predicted_unscanned=None if error else got_unscanned, latency_ms=latency, error=error)


def test_summary_counts_catches_misses_and_false_alarms():
    results = [
        clip("a", "SCAN_AVOIDANCE", "SCAN_AVOIDANCE", 1, 1),          # true positive, exact count
        clip("b", "SCAN_AVOIDANCE", "SCAN_AVOIDANCE", 3, 2),          # true positive, wrong count
        clip("c", "SCAN_AVOIDANCE", "INCONCLUSIVE", 1, 0),            # miss
        clip("d", "BENIGN", "SCAN_AVOIDANCE", 0, 5, angle="left"),    # false alarm
        clip("e", "BENIGN", "BENIGN", angle="left"),                  # true negative
        clip("f", "BENIGN", None, error="quota"),                     # not scored
    ]

    s = summarise(results)

    assert (s["clips"], s["scored"], s["errors"]) == (6, 5, 1)
    assert s["precision"] == round(2 / 3, 3)
    assert s["recall"] == round(2 / 3, 3)
    assert s["false_alarm_rate"] == 0.5
    assert s["verdict_accuracy"] == 0.6
    assert s["exact_count_accuracy"] == 0.4
    assert s["inconclusive_rate"] == 0.2
    assert s["latency_ms_median"] == 4000


def test_inconclusive_on_a_benign_clip_is_not_a_false_alarm():
    s = summarise([clip("a", "BENIGN", "INCONCLUSIVE")])
    assert s["false_alarm_rate"] == 0.0
    assert s["verdict_accuracy"] == 0.0


def test_groups_and_markdown():
    results = [clip("a", "BENIGN", "BENIGN", angle="top"), clip("b", "BENIGN", "SCAN_AVOIDANCE", 0, 1, angle="left")]

    groups = by_group(results, "angle")
    markdown = to_markdown(results, "test run")

    assert groups["left"]["false_alarm_rate"] == 1.0 and groups["top"]["false_alarm_rate"] == 0.0
    assert "| a | top | BENIGN | BENIGN |" in markdown
    assert "## By angle" in markdown
