#!/usr/bin/env python3
"""Check explicitly chosen literal spans; never claim semantic equivalence."""

import argparse
import json
from pathlib import Path
import sys


def check(before, after, anchors):
    if not isinstance(anchors, list) or not anchors:
        raise ValueError("anchors must be a non-empty JSON array")
    if any(not isinstance(anchor, str) or not anchor for anchor in anchors):
        raise ValueError("each anchor must be a non-empty string")
    anchors = list(dict.fromkeys(anchors))
    absent_before = [anchor for anchor in anchors if anchor not in before]
    if absent_before:
        raise ValueError("anchors absent from original: " + json.dumps(absent_before, ensure_ascii=False))
    missing = [anchor for anchor in anchors if anchor not in after]
    return {
        "selected_anchor_count": len(anchors),
        "all_selected_anchors_present": not missing,
        "missing_from_rewrite": missing,
        "semantic_equivalence_checked": False,
        "note": "Checks substring presence only. Review meaning, coverage, and code separately.",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--anchors", required=True, type=Path, help="UTF-8 JSON array of exact source spans")
    args = parser.parse_args(argv)
    try:
        result = check(
            args.before.read_text(encoding="utf-8"),
            args.after.read_text(encoding="utf-8"),
            json.loads(args.anchors.read_text(encoding="utf-8")),
        )
    except (OSError, UnicodeError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["all_selected_anchors_present"] else 1


if __name__ == "__main__":
    sys.exit(main())
