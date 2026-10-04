"""Plain-English store rule -> validated RuleSpec, using Gemini structured output."""

import hashlib
import json
from dataclasses import dataclass

from pydantic import ValidationError

from .gemini import Gateway
from .models import RuleSpec, Zone, validate_rule_spec

SYSTEM_PROMPT = """You convert a store manager's plain-English loss-prevention rule into a structured rule.

Supported rule types:
- DWELL: someone stays inside a zone longer than min_seconds (loitering).
- ZONE_ENTRY: someone enters a zone (e.g. a restricted area or the exit during closed hours).
- CONCEALMENT_SENSITIVITY: how sensitive concealment detection is in a zone (low/medium/high).
- SCANNER_BYPASS: alert when items move around the scanner zone at a self-checkout.

Rules:
- zone_id MUST be one of the provided zone ids. Pick the zone the manager means.
- Times are 24h HH:MM. "after 9pm" means active_from 21:00 and active_to 06:00. No time -> both null.
- If the request is about a person's appearance, identity, age, gender or ethnicity, or anything outside the
  supported types, set supported=false and explain briefly in unsupported_reason.
- summary: one short plain-English sentence restating the rule, e.g.
  "Loitering at the Spirits shelf for over 45 s, 21:00–06:00".
"""


@dataclass
class CompileResult:
    spec: RuleSpec
    problems: list[str]
    cached: bool


def cache_key(text: str, zones: list[Zone], model: str) -> str:
    normalised = " ".join(text.lower().split())
    payload = json.dumps([normalised, sorted(z.id for z in zones), model])
    return "rule:" + hashlib.sha256(payload.encode()).hexdigest()


def compile_rule(text: str, zones: list[Zone], gateway: Gateway, model: str, repo) -> CompileResult:
    from google.genai import types

    key = cache_key(text, zones, model)
    zone_map = {z.id: z for z in zones}
    cached = repo.cache_get(key)
    if cached:
        spec = RuleSpec(**cached["spec"])
        return CompileResult(spec=spec, problems=validate_rule_spec(spec, zone_map), cached=True)

    zone_list = "\n".join(f"- {z.id}: {z.name} ({z.kind}{', high value' if z.high_value else ''})" for z in zones)
    prompt = f"Store zones:\n{zone_list}\n\nManager's rule:\n{text}"
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        response_mime_type="application/json",
        response_schema=RuleSpec,
        temperature=0,
    )
    result = gateway.generate(model, [prompt], config)
    try:
        spec = RuleSpec.model_validate_json(result.text)
    except ValidationError:
        spec = RuleSpec(supported=False, unsupported_reason="I couldn't understand that rule. Try rephrasing.",
                        summary="Not understood")
        return CompileResult(spec=spec, problems=validate_rule_spec(spec, zone_map), cached=False)

    repo.cache_put(key, {"spec": spec.model_dump()})
    return CompileResult(spec=spec, problems=validate_rule_spec(spec, zone_map), cached=False)
