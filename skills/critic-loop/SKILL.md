---
name: critic-loop
description: >-
  Improve a deliverable through scored independent reviews and revisions,
  stopping at a target score or round limit. Supports fresh native critics
  and optional multi-model panels.
license: ISC
---

# Critic loop

The current agent builds and revises. Default to one native critic using the
current model and settings, or a requested panel of up to three critics.

Start every sub-agent with a fresh context window.

## Set the gate

Resolve from the request:

- `TARGET_SOLUTION`: deliverable, audience and scope.
- `QUALITY_GATE`: acceptance criteria and required verification.
- `TARGET_SCORE`: 0–10, default 8.
- `MAX_ROUNDS`: positive integer, default 3.
- `CRITICS`: one inherited-model critic, or up to three requested critics.

One round includes a build or revision and its reviews, including the initial
attempt. Validate the bounds and keep the gate, roster and cap fixed unless the
user changes the task. Ask only for requirements that cannot be inferred.

Confirm delegation supports fresh contexts without inherited history. For
requested models, reasoning settings or panels, read
[delegation selection](references/delegation.md). If delegation is unavailable,
report it; do not substitute self-review or launch an external agent CLI.

## Run each round

1. Build or revise from the ranked findings. Preserve the previous artifact
   before editing so regressions can be undone without affecting other work.
2. Discover and run relevant configured type, lint, format and test checks using
   pinned tools. Preserve failures and unavailable checks. Inspect rendered UI
   with available browser/image tools and exercise changed behavior.
3. Freeze the attempt until every critic finishes. Start new critic sessions;
   give each only the original request, fixed criteria, exact artifact, necessary
   source/reference material, check results and [critic brief](references/critic.md).
   Exclude previous reviews/scores, builder rationale, target score and round
   budget. Critics may not delegate. Keep snapshots read-only; run checks that
   write files in disposable copies within the authorized scope.
4. Validate every verdict: matching artifact, finite score in range, and each
   criterion exactly once with status and evidence. Stop on a missing or invalid
   verdict; never count it as a pass or silently replace a failed critic.
5. Accept immediately when every critic reaches `TARGET_SCORE`, all required
   criteria pass in every review, and required checks pass. Use the minimum
   critic score as the round score; a high score cannot waive a failed check.
6. Otherwise, merge duplicate findings, verify their evidence and revise from
   the supported ranked issues. Record disputed findings with reasons. Reassess
   the whole artifact, including regressions. Restore the previous artifact if a
   revision breaks a previously passing required check, retaining the failed review.

Stop at the cap even if a critic recommends more work. Cancellation, missing
verification essential to proceeding or a genuine blocker also ends the run.
Keep all actions within the user's authorized task.

## Record and return

Record each round's artifact, critic ids, known model/settings, scores, criterion
and check results, findings and disposition. Keep this in the conversation or a
supplied run directory or `.critic-loop/` outside the reviewed files. Generated
records stay out of commits unless requested as deliverables.

Reuse the host logger when available. Otherwise use `events.jsonl`, one JSON
object per line. Verdicts/manifests use JSON, raw command output uses `.log`, and
snapshots retain source extensions. Keep snapshots only for review and recovery.

Return the deliverable, acceptance status, rounds used, reviewed score and
unresolved issues. For a restored artifact, report its own review separately
from the rejected attempt; label unreviewed work accordingly. At exhaustion,
state that the quality gate was not met.
