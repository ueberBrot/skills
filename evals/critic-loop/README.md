# Critic-loop evaluations

```sh
vp run test tests/critic-code-oracle.test.ts tests/critic-complex-oracle.test.ts
```

The oracles accept reference implementations and reject seeded defects and
partial repairs. Fixtures are real TypeScript under `fixtures/`, excluded from
application checks and run in disposable projects.

## Native exercises

[scenarios.json](scenarios.json) defines the budgets:

- **Cache revision:** review the unchanged starter, repair from findings, then
  obtain a fresh review. Up to three rounds.
- **Interval exhaustion:** review the unchanged starter, allow one function
  repair, then stop after two rejected rounds with unresolved findings.

Copy `fixtures/project/` into a temporary workspace. Copy the task to `TASK.md`,
the starter to `src/retry.ts` (retry) or `src/subject.ts` (cache/intervals), and
public tests to `tests/`. Provide pinned dependencies.
Keep reference code and oracle tests outside the agent workspace. Replace the
oracle's `"./reference"` import with the final implementation path when grading.

Verify snapshots, fixed criteria, distinct critic sessions, preserved tests and
configuration, and the round cap. Run project checks and independent oracles.
Check dispatch traces for fresh contexts and selected settings.

## Component probes

`suite.json` checks review policy and provider selection. The standard Codex
executor disables delegation, so it cannot test the full native loop.

Commit fixtures and tests, not generated runs. Events use JSONL; verdicts and
manifests use JSON; raw output uses `.log`.
