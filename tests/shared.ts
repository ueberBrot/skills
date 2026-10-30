import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";

export const run = async <A, E>(
  program: Effect.Effect<A, E, BunServices.BunServices>
): Promise<A> =>
  await Effect.runPromise(program.pipe(Effect.provide(BunServices.layer)));

export const writeAnchorHelper = async (directory: string): Promise<string> => {
  const file = path.join(directory, "anchor-helper.py");
  await Bun.write(
    file,
    `import json
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text()
output = Path(sys.argv[2]).read_text()
anchors = json.loads(Path(sys.argv[4]).read_text())
if any(anchor not in source for anchor in anchors):
    sys.exit(2)
missing = [anchor for anchor in anchors if anchor not in output]
print(json.dumps({
    "all_selected_anchors_present": not missing,
    "missing_from_rewrite": missing,
    "note": "Synthetic grader protocol fixture",
    "selected_anchor_count": len(anchors),
    "semantic_equivalence_checked": False,
}))
sys.exit(1 if missing else 0)
`
  );

  return file;
};
