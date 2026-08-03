#!/usr/bin/env python3
"""Verify the checked-in website demo evidence."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).parent

EXPECTED = {
    "go": {
        "raw": (16, 76, 2895, 1, 8),
        "out": (2, 10, 458, 1, 1),
        "runs": [2, 2, 2, 2],
    },
    "python": {
        "raw": (18, 117, 7812, 9, 9),
        "out": (2, 11, 774, 1, 1),
        "runs": [2, 2, 2, 2],
    },
    "rust": {
        "raw": (22, 106, 5090, 3, 11),
        "out": (2, 13, 546, 1, 1),
        "runs": [2, 4, 2, 2],
    },
}


def metrics(text: str) -> tuple[int, int, int, int, int]:
    lines = text.splitlines()
    changed = sum(
        (line.startswith("+") and not line.startswith("+++"))
        or (line.startswith("-") and not line.startswith("---"))
        for line in lines
    )
    files = sum(line.startswith("diff --git ") for line in lines)
    hunks = sum(line.startswith("@@") for line in lines)
    return changed, len(lines), len(text.encode()), files, hunks


EXPECTED_RUBRICS = {
    "38d6b8f832030c7da90e4138452540788cadecf2": "e6866ffaafb898ce",
    "85fd905c4957203dcae7be146de745d5f93fbac3": "3c17e8412d288ebc",
}


def main() -> None:
    runs = json.loads((ROOT / "runs.json").read_text())
    assert runs["model"] == "gpt-5.6-sol"
    assert runs["canonical_rubric_hash"] == "3c17e8412d288ebc"

    embedded_text = (ROOT / "data.js").read_text().strip()
    prefix = "window.__DEMO_FILES__ = "
    assert embedded_text.startswith(prefix) and embedded_text.endswith(";")
    embedded = json.loads(embedded_text[len(prefix) : -1])

    viewer = (ROOT / "viewer.html").read_text()
    assert '<script src="data.js"></script>' in viewer
    assert "fetch(" not in viewer
    assert "grid-template-columns:46px minmax(0,1fr)" in viewer
    for key in embedded:
        assert key in viewer

    for name, expected in EXPECTED.items():
        raw_path = ROOT / f"{name}.original.diff"
        out_path = ROOT / f"{name}.meat.diff"
        response_path = ROOT / f"{name}.meat.json"
        raw = raw_path.read_text()
        out = out_path.read_text()
        response = json.loads(response_path.read_text())

        assert metrics(raw) == expected["raw"], (name, "raw", metrics(raw))
        assert metrics(out) == expected["out"], (name, "out", metrics(out))
        assert response["smart_diff"] == out
        assert response["elision"].startswith(
            f"kept {expected['out'][0]}/{expected['raw'][0]} changed lines"
        )

        run_data = runs["candidates"][name]
        assert run_data["input_sha256"] == hashlib.sha256(raw.encode()).hexdigest()
        kept = [metrics(run["response"]["smart_diff"])[0] for run in run_data["runs"]]
        assert kept == expected["runs"], (name, "runs", kept)
        for run in run_data["runs"]:
            assert run["model"] == "gpt-5.6-sol"
            assert run["rubric_hash"] == EXPECTED_RUBRICS[run["meat_commit"]]
            assert "-no-cache" in run["flags"] and "-json" in run["flags"]
        assert run_data["runs"][-1]["response"] == response

        assert embedded[f"{name}-original.diff"] == raw
        assert embedded[f"{name}-meat.diff"] == out

    print("website demo artifacts verified")


if __name__ == "__main__":
    main()
