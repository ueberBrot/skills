import { expect, test } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { defined } from "../src/internal/json";
import { captureProcess } from "../src/internal/process";
import { REPO } from "../src/paths";
import { run } from "./shared";

const scenarios = ["cache", "intervals"] as const;

const variants = [
  "reference",
  "starter",
  "coalescing",
  "stale-write",
  "early-expiry",
  "touching",
  "split",
  "validation",
  "normalize-only",
  "subtract-only",
] as const;

const mutate = (
  reference: string,
  starter: string,
  variant: (typeof variants)[number]
): string => {
  switch (variant) {
    case "reference": {
      return reference;
    }

    case "starter": {
      return starter;
    }

    case "coalescing": {
      return reference.replace("return active.promise;", "return load(key);");
    }

    case "stale-write": {
      return reference.replaceAll("flights.get(key)?.token === token", "true");
    }

    case "early-expiry": {
      return reference
        .replace(
          "const token = Symbol(key);",
          "const started = now(); const token = Symbol(key);"
        )
        .replace("expiresAt: now() + ttlMs", "expiresAt: started + ttlMs");
    }

    case "touching": {
      return reference.replace("start <= previous[1]", "start < previous[1]");
    }

    case "split": {
      return reference.replace(
        "if (cutStart > cursor) output.push([cursor, cutStart]);",
        ""
      );
    }

    case "validation": {
      return reference.replace(
        'throw new RangeError("Invalid interval");',
        "return [start, end];"
      );
    }

    case "normalize-only": {
      const prefix = defined(reference.split("export const subtract = (")[0]);
      const suffix = defined(starter.split("export const subtract = (")[1]);

      return `${prefix}export const subtract = (${suffix}`;
    }

    case "subtract-only": {
      const prefix = defined(starter.split("export const subtract = (")[0]);
      const suffix = defined(reference.split("export const subtract = (")[1]);

      return `${prefix}export const subtract = (${suffix}`;
    }

    default: {
      throw new Error("Unsupported oracle variant");
    }
  }
};

const evaluate = async (
  scenario: (typeof scenarios)[number],
  variant: (typeof variants)[number]
) =>
  await run(
    Effect.gen(function* evaluateComplexOracle() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtures = path.join(REPO, "evals/critic-loop/fixtures", scenario);

      const reference = yield* fs.readFileString(
        path.join(fixtures, "reference.ts")
      );

      const starter = yield* fs.readFileString(
        path.join(fixtures, "starter.ts")
      );

      const source = mutate(reference, starter, variant);

      if (variant !== "reference") {
        expect(source).not.toBe(reference);
      }

      const workspace = yield* fs.makeTempDirectoryScoped({
        prefix: "skills-complex-oracle-",
      });

      const subject = path.join(workspace, "subject.ts");
      const tests = path.join(workspace, "oracle.test.ts");

      const oracle = (yield* fs.readFileString(
        path.join(fixtures, "oracle.test.ts")
      )).replace('"./reference"', JSON.stringify(subject));

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

test.each(scenarios)("%s oracle accepts its reference", async (scenario) => {
  const result = await evaluate(scenario, "reference");
  expect(result.code).toBe(0);
});

test.each(scenarios)("%s oracle rejects its starter", async (scenario) => {
  const result = await evaluate(scenario, "starter");
  expect(result.code).not.toBe(0);
});

test.each(["coalescing", "stale-write", "early-expiry"] as const)(
  "cache oracle rejects %s",
  async (variant) => {
    const result = await evaluate("cache", variant);
    expect(result.code).not.toBe(0);
  }
);

test.each([
  "touching",
  "split",
  "validation",
  "normalize-only",
  "subtract-only",
] as const)("interval oracle rejects %s", async (variant) => {
  const result = await evaluate("intervals", variant);
  expect(result.code).not.toBe(0);
});
