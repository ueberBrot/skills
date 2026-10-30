import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, test } from "@effect/vitest";
import { Effect, FileSystem, PlatformError, Schema } from "effect";

import packageInfo from "../package.json";
import { summarize } from "../src/assessment";
import { CONDITIONS, sampleKey, WriterInputSchema } from "../src/domain";
import { defined } from "../src/internal/json";
import { captureProcess } from "../src/internal/process";
import { executeSuite, replaySuite, loadRun as readRun } from "../src/runs";
import { loadSuite } from "../src/suites";
import { writerLayer } from "../src/writers";
import { run, writeAnchorHelper } from "./shared";

import type { Fixture, JsonValue, RunArtifact, SuiteSpec } from "../src/domain";
import type { ReplayOptions, RunOptions } from "../src/runs";
import type { LoadedSuite } from "../src/suites";

const OUTPUT = "Grüße — voilà\nKeep CODE_42.";
const DIAGNOSTIC = "SECRET_DIAGNOSTIC_NOT_FOR_ARTIFACTS";
const directories: string[] = [];

type CommandOptions = RunOptions & { readonly command: string[] };

const executeWithCommand = (
  suite: LoadedSuite,
  output: string,
  { command, ...options }: CommandOptions
) =>
  executeSuite(suite, output, options).pipe(
    Effect.provide(writerLayer({ _tag: "Command", argv: command })),
    Effect.map((result) => result.artifact)
  );

const replay = (
  suite: LoadedSuite,
  output: string,
  sources: Partial<Record<(typeof CONDITIONS)[number], string>>,
  options: ReplayOptions = {}
) =>
  replaySuite(suite, output, sources, options).pipe(
    Effect.map((result) => result.artifact)
  );

const loadRun = (file: string) =>
  readRun(file).pipe(Effect.map((loaded) => loaded.artifact));

const CaptureSchema = Schema.Struct({
  cwd: Schema.String,
  payload: WriterInputSchema,
});

const decodeCapture = Schema.decodeUnknownSync(CaptureSchema, {
  onExcessProperty: "error",
});

const decodePrompts = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, WriterInputSchema),
  { onExcessProperty: "error" }
);

const expectRejected = async <T>(
  operation: Promise<T>,
  message?: string
): Promise<void> => {
  const error = await operation.then(
    () => {
      throw new Error("Expected the operation to reject");
    },
    Schema.decodeUnknownSync(Schema.instanceOf(Error))
  );

  expect(error).toBeInstanceOf(Error);

  if (message !== undefined) {
    expect(error.message).toContain(message);
  }
};

type WorkerMode =
  | "valid"
  | "malformed"
  | "nonzero"
  | "whitespace"
  | "timeout"
  | "checkpoint";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => {
      await fs.rm(path, { force: true, recursive: true });
    })
  );
});

const json = async (path: string, value: JsonValue): Promise<void> => {
  await Bun.write(path, JSON.stringify(value));
};

interface SuiteFiles {
  root: string;
  path: string;
  captures: string;
  fixtures: Fixture[];
  suite: LoadedSuite;
  spec: SuiteSpec;
}

const fixtureSuite = async (): Promise<SuiteFiles> => {
  const root = await fs.mkdtemp(
    nodePath.join(os.tmpdir(), "writing-execution-")
  );

  directories.push(root);
  await fs.mkdir(nodePath.join(root, "skill/references"), { recursive: true });
  await fs.mkdir(nodePath.join(root, "captures"));
  await Bun.write(
    nodePath.join(root, "skill/SKILL.md"),
    [
      "---",
      "name: skill",
      "description: Fixture only.",
      "metadata:",
      "  version: test",
      "---",
      "SKILL_INSTRUCTION_SENTINEL",
    ].join("\n")
  );
  await Bun.write(
    nodePath.join(root, "skill/references/selected.md"),
    "SELECTED_REFERENCE_SENTINEL"
  );
  await Bun.write(
    nodePath.join(root, "skill/references/unselected.md"),
    "UNSELECTED_REFERENCE_SENTINEL"
  );
  await Bun.write(nodePath.join(root, "short.md"), "SHORT_PROMPT_SENTINEL");

  const fixtures: Fixture[] = [
    { id: "english-case", request: "Edit this note.", source: OUTPUT },
    { id: "german-case", request: "Bitte redigieren.", source: OUTPUT },
  ];

  const spec: SuiteSpec = {
    anchor_helper: await writeAnchorHelper(root),
    cases: fixtures.map((fixture, index) => ({
      anchors: ["CODE_42"],
      id: fixture.id,
      language: index === 0 ? "en" : "de",
      provenance: "synthetic-test-only",
      reader_questions: ["READER_QUESTION_PRIVATE_SENTINEL"],
      references: ["references/selected.md"],
      split: "development",
      task: "message",
    })),
    checks: "checks.json",
    fixtures: "cases.json",
    name: "execution-test",
    short_prompt: "short.md",
    skill: "skill",
  };

  await json(nodePath.join(root, "cases.json"), fixtures);
  await json(
    nodePath.join(root, "checks.json"),
    Object.fromEntries(
      fixtures.map((fixture) => [fixture.id, ["PRIVATE_REVIEW_CHECK_SENTINEL"]])
    )
  );
  const path = nodePath.join(root, "suite.json");
  await json(path, spec);

  return {
    captures: nodePath.join(root, "captures"),
    fixtures,
    path,
    root,
    spec,
    suite: await run(loadSuite(path)),
  };
};

const worker = async (
  files: SuiteFiles,
  mode: WorkerMode = "valid"
): Promise<string[]> => {
  const script = nodePath.join(files.root, `executor-${mode}.ts`);
  await Bun.write(
    script,
    `
import fs from "node:fs/promises";
import nodePath from "node:path";
const payload = JSON.parse(await Bun.stdin.text());
const captures = ${JSON.stringify(files.captures)};
await Bun.write(nodePath.join(captures, crypto.randomUUID() + ".json"), JSON.stringify({payload, cwd: process.cwd()}));
const mode = ${JSON.stringify(mode)};
console.error(${JSON.stringify(DIAGNOSTIC)});
if (mode === "timeout") await Bun.sleep(10_000);
if (mode === "checkpoint" && (await fs.readdir(captures)).length > 1) await Bun.sleep(300);
if (mode === "nonzero") process.exit(7);
if (mode === "malformed") console.log(${JSON.stringify(DIAGNOSTIC)});
else console.log(JSON.stringify({
  output: mode === "whitespace" ? "   " : ${JSON.stringify(OUTPUT)},
  model: "stub/actual", settings: payload.settings, usage: {input_tokens: 10},
  executor_metadata: {backend: "test-command"}
}));
`
  );

  return [process.execPath, "--no-env-file", script];
};

const replayFile = async (
  files: SuiteFiles,
  outputs?: { id: string; output: string }[]
): Promise<string> => {
  const path = nodePath.join(files.root, `replay-${crypto.randomUUID()}.json`);
  await json(
    path,
    outputs ??
      files.fixtures.map((fixture) => ({ id: fixture.id, output: OUTPUT }))
  );

  return path;
};

describe("writer prompts and generic execution", () => {
  test("normalizes dot-segment references before composing the full skill prompt", async () => {
    const reference = "references/./selected.md";
    const files = await fixtureSuite();
    const { spec } = files;
    await json(files.path, {
      ...spec,
      cases: [
        { ...defined(spec.cases[0]), references: [reference] },
        ...spec.cases.slice(1),
      ],
    });
    const suite = await run(loadSuite(files.path));
    const record = defined(suite.cases[0]);
    expect(record.spec.references).toEqual(["references/selected.md"]);
    expect(suite.promptFor(record.fixture.id, "full_skill")).toContain(
      "SELECTED_REFERENCE_SENTINEL"
    );
  });

  test("rejects references that become duplicates after normalization", async () => {
    const files = await fixtureSuite();
    const { spec } = files;
    await json(files.path, {
      ...spec,
      cases: [
        {
          ...defined(spec.cases[0]),
          references: ["references/selected.md", "references/./selected.md"],
        },
        ...spec.cases.slice(1),
      ],
    });
    await expectRejected(run(loadSuite(files.path)), "Duplicate references");
  });

  test("uses snapshotted condition-specific guidance and hides reviewer material", async () => {
    const { suite, root, spec } = await fixtureSuite();
    await Bun.write(
      nodePath.join(root, "skill/SKILL.md"),
      "CHANGED_AFTER_SNAPSHOT"
    );
    await Bun.write(
      defined(spec.anchor_helper),
      "raise RuntimeError('changed after loading')"
    );
    const record = defined(suite.cases[0]);
    const plain = suite.promptFor(record.fixture.id, "no_skill");
    const short = suite.promptFor(record.fixture.id, "short_prompt");
    const full = suite.promptFor(record.fixture.id, "full_skill");

    for (const prompt of [plain, short, full]) {
      expect(prompt).toContain(record.fixture.request);
      expect(prompt).toContain("Grüße — voilà");
      expect(prompt).not.toContain("PRIVATE_REVIEW_CHECK_SENTINEL");
      expect(prompt).not.toContain("READER_QUESTION_PRIVATE_SENTINEL");
      expect(prompt).not.toContain("UNSELECTED_REFERENCE_SENTINEL");
      expect(prompt).not.toContain("CHANGED_AFTER_SNAPSHOT");
    }

    expect(plain).not.toContain("SHORT_PROMPT_SENTINEL");
    expect(plain).not.toContain("SKILL_INSTRUCTION_SENTINEL");
    expect(short).toContain("SHORT_PROMPT_SENTINEL");
    expect(short).not.toContain("SKILL_INSTRUCTION_SENTINEL");
    expect(full).toContain("SKILL_INSTRUCTION_SENTINEL");
    expect(full).toContain("SELECTED_REFERENCE_SENTINEL");
    expect(full).not.toContain("SHORT_PROMPT_SENTINEL");
    expect(suite.skillName).toBe("skill");
    const assessment = await run(suite.assess(record.fixture.id, OUTPUT));

    expect(assessment?.all_selected_anchors_present).toBe(true);
  });

  test("executes shuffled repetitions in fresh workspaces and records actual metadata", async () => {
    const files = await fixtureSuite();
    const command = await worker(files);
    const destination = nodePath.join(files.root, "run");
    const bufferedReads: string[] = [];

    const artifact = await run(
      Effect.gen(function* executableHashing() {
        const filesystem = yield* FileSystem.FileSystem;

        return yield* executeWithCommand(files.suite, destination, {
          command,
          concurrency: 2,
          model: "stub/requested",
          repetitions: 2,
          seed: 42,
          settings: { temperature: 0 },
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...filesystem,
            readFile: (file) => {
              bufferedReads.push(file);

              return filesystem.readFile(file);
            },
          })
        );
      })
    );

    expect(bufferedReads).not.toContain(process.execPath);
    expect(artifact.results).toHaveLength(12);
    expect(
      artifact.results.every((result) => result.status === "success")
    ).toBe(true);
    expect(
      artifact.results.every(
        (result) => result.output === OUTPUT && result.anchors_pass === true
      )
    ).toBe(true);
    expect(
      artifact.results.every(
        (result) => result.reported_model === "stub/actual"
      )
    ).toBe(true);
    expect(
      artifact.results.every(
        (result) =>
          JSON.stringify(result.reported_settings) === '{"temperature":0}'
      )
    ).toBe(true);
    expect(
      artifact.results.every((result) => result.usage?.input_tokens === 10)
    ).toBe(true);
    expect(
      artifact.results.every(
        (result) => result.executor_metadata?.backend === "test-command"
      )
    ).toBe(true);

    for (const fixture of files.fixtures) {
      for (const condition of CONDITIONS) {
        expect(
          artifact.results
            .filter(
              (result) =>
                result.case_id === fixture.id && result.condition === condition
            )
            .map((result) => result.repetition)
        ).toEqual([1, 2]);
      }
    }

    expect(artifact.manifest).toMatchObject({
      concurrency: 2,
      executor_name: "command",
      mode: "execute",
      requested_model: "stub/requested",
      requested_settings: { temperature: 0 },
      schema_version: 2,
      skill_name: "skill",
      skill_version: null,
    });
    expect(artifact.manifest.completed_at).toBeTypeOf("string");
    expect(defined(artifact.manifest.file_hashes[defined(command[2])])).toBe(
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(defined(command[2])).bytes())
        .digest("hex")
    );
    expect(artifact.manifest.package_versions["@tanstack/ai"]).toBe("1.0.0");
    expect(artifact.manifest.package_versions[packageInfo.name]).toBe(
      packageInfo.version
    );
    expect(artifact.manifest.package_versions.bun).toBe(Bun.version);
    expect(await run(loadRun(destination))).toEqual(artifact);

    const prompts = decodePrompts(
      JSON.parse(
        await Bun.file(nodePath.join(destination, "prompts.json")).text()
      )
    );

    const canonicalJobs = files.fixtures.flatMap((fixture) =>
      CONDITIONS.flatMap((condition) => [
        sampleKey(fixture.id, 1, condition),
        sampleKey(fixture.id, 2, condition),
      ])
    );

    expect(Object.keys(prompts).toSorted()).toEqual(canonicalJobs.toSorted());
    expect(Object.keys(prompts)).not.toEqual(canonicalJobs);

    const capturePaths = await fs.readdir(files.captures);

    const captures = await Promise.all(
      capturePaths.map(async (path) =>
        decodeCapture(
          JSON.parse(await Bun.file(nodePath.join(files.captures, path)).text())
        )
      )
    );

    expect(captures).toHaveLength(12);
    expect(new Set(captures.map((capture) => capture.cwd)).size).toBe(12);

    await Promise.all(
      captures.map(async (capture) => {
        expect(Object.keys(capture.payload).toSorted()).toEqual([
          "model",
          "prompt",
          "settings",
        ]);
        expect(capture.payload.model).toBe("stub/requested");
        expect(capture.payload.settings).toEqual({ temperature: 0 });
        await expectRejected(fs.access(capture.cwd));
      })
    );

    expect(JSON.stringify(artifact)).not.toContain(DIAGNOSTIC);
  });

  test.each(["malformed", "nonzero", "whitespace", "timeout"] as const)(
    "records %s failures without retaining raw diagnostics or output",
    async (mode) => {
      const files = await fixtureSuite();
      const command = await worker(files, mode);

      const artifact = await run(
        executeWithCommand(files.suite, nodePath.join(files.root, "run"), {
          command,
          concurrency: 2,
          conditions: ["no_skill"],
          timeout: mode === "timeout" ? 0.1 : 2,
        })
      );

      expect(artifact.results).toHaveLength(2);

      for (const result of artifact.results) {
        expect(result.status).toBe("error");
        expect(result.error_stage).toBe("execution");
        expect(result.error).toBeTypeOf("string");
        expect(result.output).toBeNull();
        expect(result.anchors_pass).toBeNull();
      }

      expect(artifact.manifest.completed_at).toBeTypeOf("string");
      expect(JSON.stringify(artifact)).not.toContain(DIAGNOSTIC);

      if (mode === "timeout") {
        expect(
          artifact.results.every(
            (result) => result.error === "Executor timed out"
          )
        ).toBe(true);
      }

      if (mode === "nonzero") {
        expect(
          artifact.results.every(
            (result) => result.error === "Executor failed with exit code 7"
          )
        ).toBe(true);
      }
    }
  );

  test("checkpoints completed samples before the final completion timestamp", async () => {
    const files = await fixtureSuite();
    const command = await worker(files, "checkpoint");
    const destination = nodePath.join(files.root, "run");

    const pending = run(
      executeWithCommand(files.suite, destination, {
        command,
        conditions: ["no_skill"],
      })
    );

    const waitForCheckpoint = async (
      deadline: number
    ): Promise<RunArtifact | undefined> => {
      try {
        const value = await run(loadRun(destination));

        if (value.results.length === 1) {
          return value;
        }
      } catch {
        /* The first checkpoint may not exist yet. */
      }

      if (performance.now() >= deadline) {
        return undefined;
      }

      await Bun.sleep(10);

      return await waitForCheckpoint(deadline);
    };

    const checkpoint = await waitForCheckpoint(performance.now() + 2000);

    const complete = await pending;
    expect(checkpoint?.results).toHaveLength(1);
    expect(checkpoint?.manifest.completed_at).toBeNull();
    expect(complete.results).toHaveLength(2);
    expect(complete.manifest.completed_at).toBeTypeOf("string");
    expect(await run(loadRun(destination))).toEqual(complete);
  });

  test("refuses overwrite and invalid execution options before starting a worker", async () => {
    const files = await fixtureSuite();
    const command = await worker(files);
    const destination = nodePath.join(files.root, "existing");
    await fs.mkdir(destination);
    await Bun.write(nodePath.join(destination, "keep.txt"), "keep this");
    await expectRejected(
      run(executeWithCommand(files.suite, destination, { command })),
      "Refusing to overwrite"
    );

    const invalidOptions: CommandOptions[] = [
      { command, repetitions: 0 },
      { command, concurrency: 0 },
      { command, timeout: 0 },
      { command, seed: 1.5 },
      { command, conditions: ["no_skill", "no_skill"] },
    ];

    await Promise.all(
      invalidOptions.map(async (options) => {
        await expectRejected(
          run(
            executeWithCommand(
              files.suite,
              nodePath.join(files.root, crypto.randomUUID()),
              options
            )
          )
        );
      })
    );

    expect(await Bun.file(nodePath.join(destination, "keep.txt")).text()).toBe(
      "keep this"
    );
    expect(await fs.readdir(files.captures)).toEqual([]);
  });

  test("atomically reserves a shared output so only one concurrent run generates", async () => {
    const files = await fixtureSuite();
    const command = await worker(files);
    const destination = nodePath.join(files.root, "new-parent", "shared-run");

    const runs = await Promise.allSettled([
      run(
        executeWithCommand(files.suite, destination, {
          command,
          conditions: ["no_skill"],
        })
      ),
      run(
        executeWithCommand(files.suite, destination, {
          command,
          conditions: ["no_skill"],
        })
      ),
    ]);

    const completed = runs.filter((attempt) => attempt.status === "fulfilled");
    const rejected = runs.filter((attempt) => attempt.status === "rejected");
    expect(completed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(defined(rejected[0]).reason)).toContain(
      "Refusing to overwrite run directory"
    );
    expect(await fs.readdir(files.captures)).toHaveLength(2);
    expect(await run(loadRun(destination))).toEqual(
      defined(completed[0]).value
    );
  });
});

describe("offline replay and literal evaluation", () => {
  test("matches exact case IDs even when prompts are identical", async () => {
    const files = await fixtureSuite();
    await json(
      nodePath.join(files.root, "cases.json"),
      files.fixtures.map((fixture) => ({
        ...fixture,
        request: "Edit this note.",
      }))
    );
    const suite = await run(loadSuite(files.path));

    expect(suite.promptFor("english-case", "no_skill")).toBe(
      suite.promptFor("german-case", "no_skill")
    );

    const outputs = files.fixtures.map((fixture) => ({
      id: fixture.id,
      output: `${fixture.id}; CODE_42`,
    }));

    const source = await replayFile(files, outputs);
    const original = await Bun.file(source).bytes();
    let reads = 0;

    const artifact = await run(
      Effect.gen(function* replaySnapshot() {
        const filesystem = yield* FileSystem.FileSystem;

        return yield* replay(suite, nodePath.join(files.root, "replay"), {
          full_skill: source,
          no_skill: source,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...filesystem,
            readFile: (file) => {
              if (file !== source) {
                return filesystem.readFile(file);
              }

              reads += 1;

              return filesystem.readFile(file).pipe(
                Effect.tap(() =>
                  filesystem.writeFileString(
                    source,
                    JSON.stringify(
                      outputs.map((record) => ({
                        ...record,
                        output: "CHANGED_AFTER_READ CODE_42",
                      }))
                    )
                  )
                )
              );
            },
          })
        );
      })
    );

    expect(reads).toBe(1);
    expect(artifact.manifest.file_hashes[source]).toBe(
      new Bun.CryptoHasher("sha256").update(original).digest("hex")
    );
    expect(artifact.manifest.mode).toBe("replay");
    expect(artifact.manifest.repetitions).toBe(1);
    expect(artifact.manifest.conditions).toEqual(["no_skill", "full_skill"]);
    expect(artifact.manifest.executor_argv).toBeNull();
    expect(
      artifact.manifest.limitations.some((limitation) =>
        limitation.includes("not current skill effectiveness")
      )
    ).toBe(true);
    expect(artifact.results).toHaveLength(4);

    for (const result of artifact.results) {
      expect(result.output).toBe(`${result.case_id}; CODE_42`);
      expect(result.reported_model).toBeNull();
      expect(result.reported_settings).toBeNull();
      expect(result.anchors_pass).toBe(true);
    }

    expect(await fs.readdir(files.captures)).toEqual([]);
  });

  test("omits an empty replay source from manifest hashing", async () => {
    const files = await fixtureSuite();
    const source = await replayFile(files);

    const artifact = await run(
      replay(files.suite, nodePath.join(files.root, "replay"), {
        full_skill: "",
        no_skill: source,
      })
    );

    expect(artifact.manifest.conditions).toEqual(["no_skill"]);
    expect(artifact.results).toHaveLength(files.fixtures.length);
    expect(
      artifact.results.every((result) => result.status === "success")
    ).toBe(true);
    expect(artifact.manifest.file_hashes[source]).toBeDefined();
    expect(await fs.readdir(files.captures)).toEqual([]);
  });

  test("rejects missing, additional, duplicate, empty, or malformed recorded outputs", async () => {
    const files = await fixtureSuite();

    const expected = files.fixtures.map((fixture) => ({
      id: fixture.id,
      output: OUTPUT,
    }));

    const invalid = [
      expected.slice(0, 1),
      [...expected, { id: "unexpected-case", output: OUTPUT }],
      [...expected, defined(expected[0])],
      expected.map((record) => ({ ...record, output: " " })),
      [
        { id: defined(expected[0]).id, output: OUTPUT, unexpected_field: true },
        defined(expected[1]),
      ],
    ];

    await Promise.all(
      invalid.map(async (values) => {
        const source = await replayFile(files);
        await json(source, values);
        await expectRejected(
          run(
            replay(
              files.suite,
              nodePath.join(files.root, `invalid-${crypto.randomUUID()}`),
              { no_skill: source }
            )
          )
        );
      })
    );
  });

  test("separates missing literals from execution and grading failures", async () => {
    const files = await fixtureSuite();

    const missing = await replayFile(
      files,
      files.fixtures.map((fixture) => ({
        id: fixture.id,
        output: "Grüße without the identifier.",
      }))
    );

    const valid = await replayFile(files);

    const artifact = await run(
      replay(files.suite, nodePath.join(files.root, "literal-failure"), {
        full_skill: valid,
        no_skill: missing,
      })
    );

    expect(
      artifact.results.every(
        (result) => result.status === "success" && result.error === null
      )
    ).toBe(true);

    for (const result of artifact.results.filter(
      (sample) => sample.condition === "no_skill"
    )) {
      expect(result.anchors_pass).toBe(false);
      expect(result.missing_anchors).toEqual(["CODE_42"]);
    }

    await json(
      valid,
      files.fixtures.map((fixture) => ({
        executor_metadata: { backend: "saved-output" },
        id: fixture.id,
        model: "stub/grading",
        output: OUTPUT,
        settings: { temperature: 0 },
        usage: { input_tokens: 12 },
      }))
    );
    const gradingDestination = nodePath.join(files.root, "grading-failure");

    const gradingFailure = await run(
      Effect.gen(function* gradingPermissionFailure() {
        const filesystem = yield* FileSystem.FileSystem;

        const gradingSuite = yield* loadSuite(files.path).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...filesystem,
            makeTempDirectoryScoped: () =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  method: "makeTempDirectoryScoped",
                  module: "FileSystem",
                })
              ),
          })
        );

        return yield* replay(gradingSuite, gradingDestination, {
          full_skill: valid,
          no_skill: valid,
        });
      })
    );

    const failed = defined(
      gradingFailure.results.find((result) => result.case_id === "english-case")
    );

    expect(failed.status).toBe("error");
    expect(failed.error_stage).toBe("evaluation");
    expect(failed.output).toBe(OUTPUT);
    expect(failed.reported_model).toBe("stub/grading");
    expect(failed.reported_settings).toEqual({ temperature: 0 });
    expect(failed.usage).toEqual({ input_tokens: 12 });
    expect(failed.executor_metadata).toEqual({ backend: "saved-output" });
    expect(failed.anchors_pass).toBeNull();
    expect(failed.missing_anchors).toEqual([]);
    expect(failed.error).toContain("makeTempDirectoryScoped");

    const summary = await run(
      summarize(await run(loadRun(gradingDestination)))
    );

    expect(summary.paired_groups).toBe(0);
    expect(summary.unpaired_groups).toBe(2);

    const groups = Schema.decodeSync(
      Schema.Array(Schema.Record(Schema.String, Schema.Json)),
      { onExcessProperty: "error" }
    )(summary.groups);

    expect(groups).toHaveLength(4);

    for (const group of groups) {
      expect(group.evaluation_errors).toBe(1);
      expect(group.execution_errors).toBe(0);
    }
  });
});

describe("process transport", () => {
  test("roundtrips UTF-8 input, drops stderr, and reports exit status", async () => {
    const files = await fixtureSuite();

    const result = await run(
      captureProcess(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `console.error(${JSON.stringify(DIAGNOSTIC)}); process.stdout.write(await Bun.stdin.text()); process.exitCode = 7;`,
        ],
        OUTPUT,
        files.root,
        2
      )
    );

    expect(result.code).toBe(7);
    expect(result.stdout).toBe(OUTPUT);
    expect(JSON.stringify(result)).not.toContain(DIAGNOSTIC);
  });

  test("rejects invalid commands and timeouts without exposing diagnostics", async () => {
    const files = await fixtureSuite();
    await expectRejected(
      run(captureProcess([], "", files.root, 1)),
      "positive finite timeout"
    );
    await expectRejected(
      run(captureProcess([process.execPath], "", files.root, 0)),
      "positive finite timeout"
    );
    await expectRejected(
      run(
        captureProcess(
          [nodePath.join(files.root, "missing-executable")],
          "",
          files.root,
          1
        )
      ),
      "Could not start executor"
    );
    await expectRejected(
      run(
        captureProcess(
          [process.execPath, "--no-env-file", "-e", "await Bun.sleep(10_000)"],
          "",
          files.root,
          0.05
        )
      ),
      "Executor timed out"
    );
  });
});
