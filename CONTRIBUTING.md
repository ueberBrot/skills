# Development

```sh
vp install --frozen-lockfile
vp run check
vp run skills --help
```

Skills live in `skills/`; evaluation suites in `evals/`; tooling and tests in
`src/` and `tests/`. [Critic-loop evaluations](evals/critic-loop/README.md).

Add a changeset for skill releases with `vp run changeset`. Tooling-only changes
need no version bump. Keep the release-age policy in `bunfig.toml`.

Commit authored skills, fixtures, oracles and tests. Generated runs stay in
ignored `.eval-runs/`, `.eval-reviews/`, `.critic-loop/` or temporary directories.
Events use JSONL; verdicts/manifests use JSON; raw output uses `.log`.
