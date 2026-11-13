Repair both interval-set operations in `src/subject.ts`.

`normalize(intervals)` takes readonly pairs of safe integer endpoints. Intervals
are half-open `[start, end)`. Reject unsafe, fractional, or reversed endpoints
with `RangeError`; ignore zero-length intervals. Return a sorted union that
merges overlaps and touching spans. Preserve negative coordinates. Never mutate
the input or return aliases to its tuples.

`subtract(source, removed)` returns the normalized interval set representing
source minus removed. It must validate both inputs, account for unsorted,
overlapping, duplicated and adjacent spans, split source intervals where needed,
and preserve input arrays and tuples. Touching boundaries remove no points.

Preserve exported signatures, public test expectations, task and configuration.
Modify only source and tests. Add useful regressions. All configured type, lint,
format and test checks must pass using `bun run check`.

Quality gate: both operations satisfy the contract, existing tests are intact,
and every configured check passes.
