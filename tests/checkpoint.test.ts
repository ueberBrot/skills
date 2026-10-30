import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  PlatformError,
  Schedule,
  Schema,
} from "effect";

import { ResultSchema, RunArtifactSchema } from "../src/domain";
import { inspectRun, loadRun, replaySuite } from "../src/runs";
import { initializeCheckpoint } from "../src/runs/checkpoint";
import { run } from "./shared";

import type { LoadedSuite } from "../src/suites";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

const temporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skills-checkpoint-"));
  directories.push(directory);

  return directory;
};

const emptyRun = () =>
  Schema.decodeSync(RunArtifactSchema)({
    cases: ["first", "second"].map((id) => ({
      checks: ["Keep the supplied value."],
      fixture: { id, request: "Return the value.", source: "value" },
      spec: { id, language: "en", provenance: "synthetic-test", task: "echo" },
    })),
    manifest: {
      concurrency: 2,
      conditions: ["no_skill"],
      file_hashes: {},
      limitations: [],
      mode: "replay",
      package_versions: {},
      repetitions: 1,
      run_id: "checkpoint-test",
      schema_version: 2,
      seed: 42,
      skill_name: "checkpoint-fixture",
      started_at: "2026-10-29T00:00:00.000Z",
      suite: "checkpoint-test",
    },
  });

const result = (id: string) =>
  Schema.decodeSync(ResultSchema)({
    case_id: id,
    condition: "no_skill",
    duration_seconds: 0,
    language: "en",
    output: "value",
    repetition: 1,
    split: "development",
    status: "success",
    task: "echo",
  });

const suite = (): LoadedSuite => ({
  assess: () => Effect.succeed(null),
  cases: emptyRun().cases,
  name: "checkpoint-test",
  promptFor: () => "Return the value.",
  provenance: {},
  skillName: "checkpoint-fixture",
});

test("completed manifests require every expected sample, while partial runs remain loadable", () => {
  const artifact = emptyRun();
  artifact.results.push(result("first"));
  expect(inspectRun(artifact).results.size).toBe(1);
  artifact.manifest.completed_at = "2026-10-29T00:01:00.000Z";
  expect(() => inspectRun(artifact)).toThrow("missing expected sample results");
  artifact.results.push(result("second"));
  expect(inspectRun(artifact).results.size).toBe(2);
  artifact.manifest.conditions = [];
  expect(() => inspectRun(artifact)).toThrow(
    "conditions must be nonempty and unique"
  );
});

test("the loader reports an incomplete terminal snapshot as a domain error", async () => {
  const directory = await temporaryDirectory();
  const artifact = emptyRun();
  artifact.manifest.completed_at = "2026-10-29T00:01:00.000Z";
  await Bun.write(path.join(directory, "run.json"), JSON.stringify(artifact));
  const error = await run(Effect.flip(loadRun(directory)));

  expect(error).toMatchObject({
    _tag: "HarnessError",
    message: "Completed run is missing expected sample results",
  });
});

test("interruption waits for both the active checkpoint write and queued commits", async () => {
  const directory = await temporaryDirectory();

  const artifact = await run(
    Effect.gen(function* checkpointCancellation() {
      const filesystem = yield* FileSystem.FileSystem;
      const writing = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();
      let writes = 0;

      const checkpoint = yield* initializeCheckpoint(
        directory,
        emptyRun()
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...filesystem,
          writeFileString: (file, data, options) =>
            Effect.gen(function* controlledWrite() {
              writes += 1;

              if (writes === 2) {
                yield* Deferred.succeed(writing, undefined);
                yield* Deferred.await(release);
              }

              return yield* filesystem.writeFileString(file, data, options);
            }),
        })
      );

      const first = yield* Effect.forkChild(
        checkpoint.commit(result("first")),
        { startImmediately: true }
      );

      yield* Deferred.await(writing);

      const second = yield* Effect.forkChild(
        checkpoint.commit(result("second")),
        { startImmediately: true }
      );

      const stopFirst = yield* Effect.forkChild(Fiber.interrupt(first), {
        startImmediately: true,
      });

      const stopSecond = yield* Effect.forkChild(Fiber.interrupt(second), {
        startImmediately: true,
      });

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopFirst);
      yield* Fiber.join(stopSecond);

      return checkpoint.artifact;
    })
  );

  expect(artifact.results).toHaveLength(2);
  expect(artifact.manifest.completed_at).toBeNull();
  const loaded = await run(loadRun(directory));

  expect(loaded.artifact).toEqual(artifact);
});

test("a failed rename preserves the previous snapshot and committed in-memory state", async () => {
  const directory = await temporaryDirectory();

  const artifact = await run(
    Effect.gen(function* failedCheckpoint() {
      const filesystem = yield* FileSystem.FileSystem;
      let renames = 0;

      const checkpoint = yield* initializeCheckpoint(
        directory,
        emptyRun()
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...filesystem,
          rename: (from, to) => {
            renames += 1;

            return renames === 3
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    method: "rename",
                    module: "FileSystem",
                  })
                )
              : filesystem.rename(from, to);
          },
        })
      );

      yield* checkpoint.commit(result("first"));
      const failure = yield* Effect.exit(checkpoint.commit(result("second")));
      expect(Exit.isFailure(failure)).toBe(true);

      return checkpoint.artifact;
    })
  );

  expect(artifact.results.map((item) => item.case_id)).toEqual(["first"]);
  const loaded = await run(loadRun(directory));

  expect(loaded.artifact).toEqual(artifact);
  const files = await readdir(directory);

  expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("an evaluated sample survives interruption during its persistence handoff", async () => {
  const directory = await temporaryDirectory();
  const source = path.join(directory, "outputs.json");
  const destination = path.join(directory, "run");
  await Bun.write(
    source,
    JSON.stringify(["first", "second"].map((id) => ({ id, output: "value" })))
  );

  await run(
    Effect.gen(function* interruptHandoff() {
      const filesystem = yield* FileSystem.FileSystem;
      const writing = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();
      let snapshots = 0;

      const fiber = yield* Effect.forkChild(
        replaySuite(suite(), destination, { no_skill: source }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...filesystem,
            writeFileString: (file, data, options) =>
              Effect.gen(function* controlledWrite() {
                if (path.basename(file).startsWith("run.json.")) {
                  snapshots += 1;

                  if (snapshots === 2) {
                    yield* Deferred.succeed(writing, undefined);
                    yield* Deferred.await(release);
                  }
                }

                return yield* filesystem.writeFileString(file, data, options);
              }),
          })
        )
      );

      yield* Deferred.await(writing);

      const stopping = yield* Effect.forkChild(Fiber.interrupt(fiber), {
        startImmediately: true,
      });

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
    })
  );

  const { artifact: saved } = await run(loadRun(destination));
  expect(saved.results).toHaveLength(1);
  expect(saved.manifest.completed_at).toBeNull();
});

test("assessment remains interruptible before its result handoff", async () => {
  const directory = await temporaryDirectory();
  const source = path.join(directory, "outputs.json");
  const destination = path.join(directory, "run");
  await Bun.write(
    source,
    JSON.stringify(["first", "second"].map((id) => ({ id, output: "value" })))
  );

  await run(
    Effect.gen(function* cancelAssessment() {
      const assessing = yield* Deferred.make<undefined>();

      const interruptedSuite: LoadedSuite = {
        ...suite(),
        assess: () =>
          Deferred.succeed(assessing, undefined).pipe(
            Effect.andThen(Effect.never)
          ),
      };

      const fiber = yield* Effect.forkChild(
        replaySuite(interruptedSuite, destination, { no_skill: source })
      );

      yield* Deferred.await(assessing);
      yield* Fiber.interrupt(fiber);
    })
  );

  const loaded = await run(loadRun(destination));

  expect(loaded.artifact.results).toHaveLength(0);
});

test.skipIf(process.platform === "win32")(
  "a forced process termination leaves the last committed snapshot loadable",
  async () => {
    const directory = await temporaryDirectory();
    const worker = path.join(directory, "worker.ts");
    const marker = path.join(directory, "committed");

    const checkpointModule = path.resolve(
      import.meta.dirname,
      "../src/runs/checkpoint.ts"
    );

    await Bun.write(
      worker,
      `
import { BunServices } from ${JSON.stringify(import.meta.resolve("@effect/platform-bun"))};
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { initializeCheckpoint } from ${JSON.stringify(checkpointModule)};
await Effect.runPromise(Effect.gen(function*() {
  const checkpoint = yield* initializeCheckpoint(${JSON.stringify(directory)}, ${JSON.stringify(emptyRun())});
  yield* checkpoint.commit(${JSON.stringify(result("first"))});
  yield* Effect.promise(() => Bun.write(${JSON.stringify(marker)}, "committed"));
  yield* Effect.never;
}).pipe(Effect.provide(BunServices.layer)));
`
    );

    const child = Bun.spawn([process.execPath, "--no-env-file", worker], {
      stderr: "pipe",
      stdout: "ignore",
    });

    const diagnostics = new Response(child.stderr).text();

    try {
      await run(
        Effect.gen(function* awaitCommit() {
          const filesystem = yield* FileSystem.FileSystem;
          yield* filesystem.readFileString(marker).pipe(
            Effect.retry({
              schedule: Schedule.spaced("10 millis"),
              times: 200,
            })
          );
        })
      );
      child.kill("SIGKILL");
      await child.exited;
      const { artifact: saved } = await run(loadRun(directory));
      expect(saved.results.map((item) => item.case_id)).toEqual(["first"]);
      expect(saved.manifest.completed_at).toBeNull();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      expect(await diagnostics).toBe("");
    }
  }
);
