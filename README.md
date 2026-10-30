# Skills

Agent skills by [Maurice de Bruyn](https://github.com/ueberbrot).

## Available skills

- [clear-writing](skills/clear-writing/SKILL.md): clear, natural workplace prose in English and German.

## Install

```sh
npx skills add ueberbrot/skills
```

## Development

Installable skills live in `skills/<name>/`. Optional evaluation suites live in
`evals/<name>/suite.json`. Shared tooling and its tests live in `src/` and `tests/`.

```sh
vp install --frozen-lockfile
vp run check
vp run skills list
```

GitHub Actions runs the same checks on pull requests and pushes to `main`.

The collection version in `package.json` covers all skills and shared tooling.
For release changes, run `vp run changeset` and commit the note with the change.
On `main`, the Changesets Action opens a PR with the version and changelog updates.
Merging that PR creates the Git tag and GitHub Release. Run manifests record the
collection version and file hashes.

Use `vp run skills --help` for commands. Add `--log-events` to a run or replay
to write `events.jsonl`. Fresh Codex runs use an existing ChatGPT login.
Credentials stay outside the repository.

Licensed under [ISC](LICENSE).
