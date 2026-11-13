import { expect, test } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { captureProcess } from "../src/internal/process";
import { REPO } from "../src/paths";
import { run } from "./shared";

const variants = [
  "reference",
  "starter",
  "uncapped",
  "unchecked",
  "zero-overflow",
] as const;

const evaluate = async (variant: (typeof variants)[number]) =>
  await run(
    Effect.gen(function* evaluateOracle() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtures = path.join(REPO, "evals/critic-loop/fixtures/retry");

      const workspace = yield* fs.makeTempDirectoryScoped({
        prefix: "skills-code-oracle-",
      });

      let source = yield* fs.readFileString(
        path.join(
          fixtures,
          variant === "starter" ? "starter.ts" : "reference.ts"
        )
      );

      if (variant === "uncapped") {
        source = source.replace(
          "Math.min(baseMs * 2 ** attempt, maxMs)",
          "baseMs * 2 ** attempt"
        );
      }

      if (variant === "unchecked") {
        source = source.replace(
          'throw new RangeError("Expected nonnegative safe integers");',
          "return 0;"
        );
      }

      if (variant === "zero-overflow") {
        source = source.replace("baseMs === 0 || maxMs === 0", "maxMs === 0");
      }

      const subject = path.join(workspace, "retry.ts");

      const oracle = (yield* fs.readFileString(
        path.join(fixtures, "oracle.test.ts")
      )).replace('"./reference"', JSON.stringify(subject));

      const tests = path.join(workspace, "oracle.test.ts");
      yield* fs.writeFileString(subject, source);
      yield* fs.writeFileString(
        tests,
        `${oracle}\nconsole.log("oracle-loaded");\n`
      );

      const result = yield* captureProcess(
        [process.execPath, "--no-env-file", "test", tests],
        "",
        workspace,
        15
      );

      expect(result.stdout.split(/\r?\n/u)).toContain("oracle-loaded");

      return result;
    }).pipe(Effect.scoped)
  );

test("the held-out oracle accepts the known-correct implementation", async () => {
  const result = await evaluate("reference");

  expect(result.code).toBe(0);
});

test.each(["starter", "uncapped", "unchecked", "zero-overflow"] as const)(
  "the held-out oracle rejects the %s defect",
  async (variant) => {
    const result = await evaluate(variant);

    expect(result.code).not.toBe(0);
  }
);
