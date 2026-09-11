#!/usr/bin/env python3
"""Validate all native wire examples and decoded strict core payload schemas."""
import json
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
schema = json.loads((ROOT / "schemas/native-core-v1.schema.json").read_text())
Draft202012Validator.check_schema(schema)
envelopes = Draft202012Validator(schema)
corpus = json.loads((ROOT / "examples/messages/native-core/vectors.json").read_text())
kinds = {
    "core.hello": "Hello", "core.welcome": "Welcome",
    "core.confirm": "SessionBody", "core.ready": "SessionBody",
    "agent.describe": "SessionBody", "agent.description": "DescriptionBody",
    "message.send": "MessageBody", "message.receipt": "ReceiptBody",
    "core.error": "ErrorBody",
}
observed = set()
for vector in corpus["messages"]:
    signed = vector["signed"]
    wire = json.loads((ROOT / "examples/messages/native-core" / (vector["kind"] + ".json")).read_text())
    assert wire == signed
    envelopes.validate(wire)
    payload = json.loads(bytes(wire["message"]["payload"]))
    definition = kinds.get(vector["kind"], "ExtensionBody")
    Draft202012Validator(schema["$defs"][definition]).validate(payload)
    observed.add(vector["kind"])
assert set(kinds) <= observed
assert any(kind.startswith("extension.") for kind in observed)
print(f"Validated {len(observed)} native envelopes and decoded payload schemas")
