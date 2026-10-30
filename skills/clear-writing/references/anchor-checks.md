# Mechanical anchor check

For fragile text, list source spans that must occur unchanged in a JSON array. Typical anchors are a URL, error string, command, identifier, or code block. Only choose prose as an exact anchor if its wording really must stay fixed.

```json
["Idempotency-Key", "24 hours", "https://example.test/api"]
```

Run with Python 3, using paths relative to your current directory:

```bash
python3 /path/to/clear-writing/scripts/check_anchors.py before.txt after.txt --anchors anchors.json
```

Replace `/path/to/clear-writing` with the installed skill directory, which contains `SKILL.md`.

Exit 0: all selected anchors occur in both texts. Exit 1: at least one is missing from the rewrite. Exit 2: input error, including an anchor absent from the original. The command reads files and prints JSON; it never edits them, uploads them, or invokes a model.

This is a substring-presence check, not a parser or a semantic verifier. It cannot detect a changed relationship, negation, extra claim, reordered code, or an omitted fact that was not selected. An anchor may remain in the wrong context. Even a clean result requires a separate review of meaning and coverage. Use a language-aware comparison for code.
