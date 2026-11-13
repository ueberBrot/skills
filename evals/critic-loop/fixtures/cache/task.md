Repair `createCache<V>(load, now, ttlMs)` in `src/subject.ts`. It returns
`get(key): Promise<V>` and `invalidate(key): void`.

- Concurrent gets for one key share exactly one loader invocation and the same
  pending Promise. Different keys remain independent.
- Successful values are cached until `now() >= completionTime + ttlMs`.
  TTL begins when loading completes, not when it starts. Zero TTL never reuses
  a settled value. `now` is an injected monotonic clock returning finite numbers.
- Rejection, including a synchronous loader throw, is returned as a rejected
  Promise and does not poison future gets.
- Invalidation removes both a cached value and the current pending registration.
  Existing callers still receive their own pending result. An invalidated load
  must never overwrite newer data or clear a newer pending registration when it
  later resolves or rejects.
- `ttlMs` must be a nonnegative safe integer; invalid values throw `RangeError`
  when the cache is constructed.

Preserve the API, existing public test expectations, task and configuration.
Modify only source and tests. Add useful deterministic regression tests using
deferred promises and the injected clock, without sleeps or network calls.
Run `bun run check`: typecheck, lint, format and tests must all pass.

Quality gate: every behavior above is correct, tests exercise the races, and
all configured checks pass.
