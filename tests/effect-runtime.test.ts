import { BunServices } from "@effect/platform-bun";
import { expect, it, test } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Path, Schedule, Schema } from "effect";

import {
  CaseSpecSchema,
  ResultSchema,
  RunArtifactSchema,
  WriterInputSchema,
} from "../src/domain";
import { HarnessError } from "../src/errors";
import { captureProcess } from "../src/internal/process";

test("decoded defaults initialize optional fields and isolate mutable state", () => {
  const decodeCase = Schema.decodeUnknownSync(CaseSpecSchema, {
    onExcessProperty: "error",
  });

  const caseInput = {
    id: "default-case",
    language: "en",
    provenance: "synthetic-test",
    task: "message",
  };

  expect(decodeCase(caseInput)).toMatchObject({
    anchors: [],
    reader_questions: [],
    references: [],
    split: "development",
  });

  const decodeInput = Schema.decodeUnknownSync(WriterInputSchema, {
    onExcessProperty: "error",
  });

  const firstInput = decodeInput({ prompt: "Edit this note." });
  const secondInput = decodeInput({ prompt: "Edit this note." });
  firstInput.settings.extra = true;
  expect(secondInput.settings).toEqual({});

  const decodeRun = Schema.decodeUnknownSync(RunArtifactSchema, {
    onExcessProperty: "error",
  });

  const runInput = {
    cases: [],
    manifest: {
      concurrency: 1,
      conditions: ["no_skill"],
      file_hashes: {},
      limitations: [],
      mode: "replay",
      package_versions: {},
      repetitions: 1,
      run_id: "default-test",
      schema_version: 2,
      seed: 42,
      skill_name: "fixture-skill",
      started_at: "2026-10-28T00:00:00.000Z",
      suite: "default-test",
    },
  };

  const firstRun = decodeRun(runInput);
  const secondRun = decodeRun(runInput);

  const result = Schema.decodeSync(ResultSchema, {
    onExcessProperty: "error",
  })({
    case_id: "default-case",
    condition: "no_skill",
    duration_seconds: 0,
    language: "en",
    output: "Edited note.",
    repetition: 1,
    split: "development",
    status: "success",
    task: "message",
  });

  firstRun.results.push(result);
  expect(secondRun.results).toEqual([]);
});

const PidsSchema = Schema.Struct({
  child: Schema.Int.check(Schema.isGreaterThan(0)),
  parent: Schema.Int.check(Schema.isGreaterThan(0)),
});

const pidExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    const failure = Schema.decodeUnknownSync(Schema.instanceOf(Error))(error);

    if (!failure.message.includes("ESRCH")) {
      throw failure;
    }

    return false;
  }
};

it.live.skipIf(process.platform === "win32")(
  "interrupting captureProcess releases its process group",
  () =>
    Effect.gen(function* processGroupCancellation() {
      const pidFile = yield* Effect.gen(function* cancellation() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "writing-cancellation-",
        });

        const worker = path.join(directory, "worker.ts");
        const pidsFile = path.join(directory, "pids.json");
        yield* fs.writeFileString(
          worker,
          `
const child = Bun.spawn([process.execPath, "--no-env-file", "-e", "await Bun.sleep(30_000)"], {
  stdin: "ignore", stdout: "ignore", stderr: "ignore"
});
await Bun.write(${JSON.stringify(pidsFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));
await child.exited;
`
        );

        const fiber = yield* Effect.forkChild(
          captureProcess(
            [process.execPath, "--no-env-file", worker],
            "",
            directory,
            20
          )
        );

        const pids = yield* fs.readFileString(pidsFile).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(PidsSchema), {
              onExcessProperty: "error",
            })
          ),
          Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 80 })
        );

        expect(pidExists(pids.parent)).toBe(true);
        expect(pidExists(pids.child)).toBe(true);
        yield* Fiber.interrupt(fiber);
        yield* Effect.sync(
          () => !pidExists(pids.parent) && !pidExists(pids.child)
        ).pipe(
          Effect.flatMap((gone) =>
            gone
              ? Effect.void
              : new HarnessError({
                  message: "Interrupted process group still exists",
                })
          ),
          Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 80 })
        );

        return pidsFile;
      }).pipe(Effect.scoped);

      const exists = yield* Effect.promise(
        async () => await Bun.file(pidFile).exists()
      );

      expect(exists).toBe(false);
    }).pipe(Effect.provide(BunServices.layer))
);
