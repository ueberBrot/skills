import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  PlatformError,
  Schema,
} from "effect";

import {
  DecodingSchema,
  exportReview,
  JudgmentsSchema,
  summarize,
} from "../src/assessment";
import { ConditionSchema } from "../src/domain";
import { defined, readJson, writeJson } from "../src/internal/json";
import { sampleRun } from "./review-fixtures";
import { run } from "./shared";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

const destination = async (artifact = sampleRun()) => {
  const root = await mkdtemp(path.join(tmpdir(), "skills-review-export-"));
  directories.push(root);
  const runPath = path.join(root, "run.json");
  await run(writeJson(runPath, artifact));

  return {
    decoding: path.join(root, "packet-decoding.json"),
    options: { out: path.join(root, "packet"), run: runPath, seed: 8 },
    root,
  };
};

describe("review publication", () => {
  test.each(["staging", "public", "decoding"])(
    "a %s failure leaves the destination available for retry",
    async (stage) => {
      const { options, root } = await destination();

      const failure = PlatformError.systemError({
        _tag: "PermissionDenied",
        method: "writeReviewPacket",
        module: "FileSystem",
      });

      await run(
        Effect.gen(function* injectedFailure() {
          const filesystem = yield* FileSystem.FileSystem;

          return yield* Effect.flip(
            exportReview(options).pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...filesystem,
                link: (from, to) => {
                  const failPublic =
                    stage === "public" &&
                    path.basename(to) === "judgments.json";

                  const failDecoding =
                    stage === "decoding" &&
                    path.basename(to) === "packet-decoding.json";

                  return failPublic || failDecoding
                    ? Effect.fail(failure)
                    : filesystem.link(from, to);
                },
                writeFileString: (file, contents, flags) =>
                  stage === "staging" &&
                  path.basename(file) === "comprehension.json"
                    ? Effect.fail(failure)
                    : filesystem.writeFileString(file, contents, flags),
              })
            )
          );
        })
      );

      expect(await readdir(root).then((entries) => entries.toSorted())).toEqual(
        ["run.json"]
      );
      await run(exportReview(options));
      expect(await readdir(root).then((entries) => entries.toSorted())).toEqual(
        ["packet", "packet-decoding.json", "run.json"]
      );
    }
  );

  test("interruption rolls back a claimed output directory and permits retry", async () => {
    const { options, root } = await destination();

    await run(
      Effect.gen(function* interruptPublication() {
        const filesystem = yield* FileSystem.FileSystem;
        const reached = yield* Deferred.make<boolean>();

        const fiber = yield* Effect.forkChild(
          exportReview(options).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...filesystem,
              link: (from, to) =>
                path.basename(to) === "judgments.json"
                  ? Deferred.succeed(reached, true).pipe(
                      Effect.andThen(Effect.never)
                    )
                  : filesystem.link(from, to),
            })
          )
        );

        yield* Deferred.await(reached);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.timeout("2 seconds"))
    );

    expect(await readdir(root).then((entries) => entries.toSorted())).toEqual([
      "run.json",
    ]);
    await run(exportReview(options));
  });

  test("a concurrent exporter cannot overwrite or remove the winning packet", async () => {
    const { options, root, decoding } = await destination();

    const exported = await Promise.allSettled([
      run(exportReview(options)),
      run(exportReview({ ...options, seed: 9 })),
    ]);

    expect(
      exported.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      exported.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(await readdir(root).then((entries) => entries.toSorted())).toEqual([
      "packet",
      "packet-decoding.json",
      "run.json",
    ]);
    expect(
      await readdir(options.out).then((entries) => entries.toSorted())
    ).toEqual(["comparisons.json", "comprehension.json", "judgments.json"]);

    const privatePacket = Schema.decodeUnknownSync(DecodingSchema)(
      await run(readJson(decoding))
    );

    const publicPacket = Schema.decodeUnknownSync(
      Schema.Struct({ review_id: Schema.String })
    )(await run(readJson(path.join(options.out, "comparisons.json"))));

    expect(privatePacket.review_id).toBe(publicPacket.review_id);
    const decodingInfo = await stat(decoding);

    expect(decodingInfo.mode % 0o1000).toBe(0o600);
  });

  test("a decoder created during publication survives rollback", async () => {
    const { options, root, decoding } = await destination();

    await run(
      Effect.gen(function* concurrentDecoder() {
        const filesystem = yield* FileSystem.FileSystem;

        return yield* Effect.flip(
          exportReview(options).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...filesystem,
              link: (from, to) =>
                to === decoding
                  ? filesystem
                      .writeFileString(decoding, "existing decoder", {
                        flag: "wx",
                      })
                      .pipe(Effect.andThen(filesystem.link(from, to)))
                  : filesystem.link(from, to),
            })
          )
        );
      })
    );

    expect(await Bun.file(decoding).text()).toBe("existing decoder");
    expect(await readdir(root).then((entries) => entries.toSorted())).toEqual([
      "packet-decoding.json",
      "run.json",
    ]);
  });
});

describe("review assignments", () => {
  test("imports pairwise ties without counting the excluded condition as a loss", async () => {
    const artifact = sampleRun();

    const excluded = defined(
      artifact.results.find((result) => result.condition === "short_prompt")
    );

    excluded.status = "error";
    excluded.output = null;
    excluded.error = "Not part of this comparison";
    excluded.error_stage = "execution";
    excluded.anchors_pass = null;
    const { options, decoding } = await destination(artifact);
    await run(
      exportReview({ ...options, conditions: ["full_skill", "no_skill"] })
    );

    const privatePacket = Schema.decodeUnknownSync(DecodingSchema)(
      await run(readJson(decoding))
    );

    expect(privatePacket.conditions).toEqual(["no_skill", "full_skill"]);
    expect(privatePacket.trials).toHaveLength(2);

    const judgments = Schema.decodeUnknownSync(JudgmentsSchema)(
      await run(readJson(path.join(options.out, "judgments.json")))
    );

    for (const trial of judgments.trials) {
      expect(Object.keys(trial.fidelity).toSorted()).toEqual(["A", "B"]);
      trial.preference = "tie";
      trial.preference_reason = "Both outputs are equally useful.";
    }

    await run(writeJson(path.join(options.out, "judgments.json"), judgments));

    const summary = Schema.decodeUnknownSync(
      Schema.Struct({
        assessment: Schema.Struct({
          comprehension_answers_pending: Schema.Natural,
          tie_groups: Schema.Natural,
        }),
        groups: Schema.Array(
          Schema.Struct({
            condition: ConditionSchema,
            preference_eligible: Schema.Natural,
            preference_losses: Schema.Natural,
            preference_ties: Schema.Natural,
          })
        ),
      })
    )(await run(summarize(artifact, { decoding, path: options.out })));

    expect(summary.assessment).toEqual({
      comprehension_answers_pending: 4,
      tie_groups: 2,
    });

    for (const group of summary.groups) {
      expect(group.preference_losses).toBe(0);
      expect(group.preference_eligible).toBe(
        group.condition === "short_prompt" ? 0 : 1
      );
      expect(group.preference_ties).toBe(
        group.condition === "short_prompt" ? 0 : 1
      );
    }
  });

  test("rejects invalid pair selections before publishing files", async () => {
    const { options, root } = await destination();

    const selections = [["no_skill"], ["no_skill", "no_skill"]] as const;

    const failures = await Promise.all(
      selections.map(
        async (conditions) =>
          await run(Effect.flip(exportReview({ ...options, conditions })))
      )
    );

    for (const failure of failures) {
      expect(String(failure)).toContain("exactly two distinct run conditions");
    }

    expect(await readdir(root)).toEqual(["run.json"]);
  });
});
