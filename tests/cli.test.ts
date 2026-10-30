import { mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "@effect/vitest";
import { Effect, FileSystem, Schedule, Schema } from "effect";

import { CONDITIONS, RunArtifactSchema } from "../src/domain";
import { defined, readJson, writeJson } from "../src/internal/json";
import { run as runEffect, writeAnchorHelper } from "./shared";

const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skills-cli-"));
  temporary.push(root);
  await mkdir(path.join(root, "skill"));
  await Bun.write(
    path.join(root, "skill/SKILL.md"),
    "---\nname: skill\ndescription: Synthetic writing fixture.\n---\nPreserve conditions and uncertainty.\n"
  );
  await Bun.write(
    path.join(root, "short.txt"),
    "Write clearly and preserve meaning.\n"
  );
  await runEffect(
    writeJson(path.join(root, "fixtures.json"), [
      {
        id: "retry-email",
        request: "Clarify this email.",
        source: "Please wait 24 hours before retrying.",
      },
    ])
  );
  await runEffect(
    writeJson(path.join(root, "checks.json"), {
      "retry-email": ["The wait and retry condition remain unchanged."],
    })
  );

  const spec = {
    anchor_helper: await writeAnchorHelper(root),
    cases: [
      {
        anchors: ["24 hours"],
        id: "retry-email",
        language: "en",
        provenance: "synthetic-regression",
        reader_questions: ["How long should you wait?"],
        task: "email",
      },
    ],
    checks: "checks.json",
    fixtures: "fixtures.json",
    name: "cli-integration",
    short_prompt: "short.txt",
    skill: "skill",
  };

  const suite = path.join(root, "suite.json");
  await runEffect(writeJson(suite, spec));
  const replay = path.join(root, "outputs.json");
  await runEffect(
    writeJson(replay, [
      { id: "retry-email", output: "Wait 24 hours before retrying." },
    ])
  );

  return { replay, root, spec, suite };
};

const spawnCli = (root: string, args: string[]) =>
  Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
    cwd: root,
    // No authentication or provider variables are passed to CLI integration tests.
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
    },
    stderr: "pipe",
    stdout: "pipe",
  });

const invoke = async (root: string, args: string[]) => {
  const child = spawnCli(root, args);

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, stderr, stdout };
};

const errorMessage = (stderr: string): string =>
  Schema.decodeSync(
    Schema.fromJsonString(Schema.Struct({ error: Schema.String }))
  )(stderr, { onExcessProperty: "error" }).error;

const decodeEvent = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      annotations: Schema.Record(Schema.String, Schema.Json),
      message: Schema.String,
      timestamp: Schema.String,
    })
  )
);

const readEvents = async (output: string) => {
  const text = await Bun.file(path.join(output, "events.jsonl")).text();

  return {
    events: text
      .trim()
      .split("\n")
      .map((line) => decodeEvent(line)),
    text,
  };
};

describe("evaluation CLI", () => {
  test("writes flushed JSONL lifecycle metadata only when requested", async () => {
    const { root, suite, replay } = await fixture();
    const plain = path.join(root, "plain");
    const logged = path.join(root, "logged");
    const args = ["--suite", suite, "--outputs", `no_skill=${replay}`];

    const disabled = await invoke(root, ["replay", ...args, "--out", plain]);
    expect(disabled.code).toBe(0);
    expect(await Bun.file(path.join(plain, "events.jsonl")).exists()).toBe(
      false
    );

    const enabled = await invoke(root, [
      "replay",
      ...args,
      "--out",
      logged,
      "--log-events",
      "--settings",
      JSON.stringify({ private_setting: "PRIVATE_SETTING_SENTINEL" }),
    ]);

    expect(enabled.code).toBe(0);
    expect(enabled.stderr).toBe("");
    expect(JSON.parse(enabled.stdout)).toMatchObject({
      execution_errors: 0,
      results: 1,
    });

    const { events, text } = await readEvents(logged);
    expect(events.map((event) => event.message)).toEqual([
      "run.started",
      "sample.started",
      "sample.completed",
      "run.completed",
    ]);

    const run = Schema.decodeUnknownSync(RunArtifactSchema)(
      await runEffect(readJson(path.join(logged, "run.json")))
    );

    for (const event of events) {
      expect(event.annotations).toMatchObject({
        mode: "replay",
        run_id: run.manifest.run_id,
        skill_name: "skill",
        suite: "cli-integration",
      });
      expect(event.timestamp).toBeTypeOf("string");
    }

    expect(defined(events[2]).annotations).toMatchObject({
      case_id: "retry-email",
      condition: "no_skill",
      error_stage: null,
      repetition: 1,
      status: "success",
    });
    expect(
      defined(events[2]).annotations.duration_seconds
    ).toBeGreaterThanOrEqual(0);
    expect(defined(events[3]).annotations).toMatchObject({
      evaluation_errors: 0,
      execution_errors: 0,
      literal_failures: 0,
      results: 1,
    });
    expect(text).not.toContain("24 hours");
    expect(text).not.toContain("Clarify this email");
    expect(text).not.toContain("PRIVATE_SETTING_SENTINEL");

    if (process.platform !== "win32") {
      const info = await stat(path.join(logged, "events.jsonl"));
      expect(info.mode % 0o1000).toBe(0o600);
    }
  });

  test.each(["execution", "checkpoint"])(
    "flushes lifecycle events after a %s failure",
    async (failure) => {
      const { root, suite } = await fixture();
      const output = path.join(root, "failed");
      const worker = path.join(root, "worker.ts");
      await Bun.write(
        worker,
        failure === "execution"
          ? 'console.error("RAW_DIAGNOSTIC_SENTINEL"); process.exit(7);'
          : `import { mkdir } from "node:fs/promises";
await Bun.file(${JSON.stringify(path.join(output, "run.json"))}).delete();
await mkdir(${JSON.stringify(path.join(output, "run.json"))});
console.log(JSON.stringify({ output: "Wait 24 hours before retrying." }));`
      );

      const result = await invoke(root, [
        "run",
        "--suite",
        suite,
        "--out",
        output,
        "--model",
        "stub",
        "--conditions",
        "no_skill",
        "--log-events",
        "--command",
        process.execPath,
        "--no-env-file",
        worker,
      ]);

      expect(result.code).toBe(failure === "execution" ? 1 : 2);
      const { events, text } = await readEvents(output);
      expect(events.map((event) => event.message)).toContain("sample.started");
      expect(defined(events.at(-1)).message).toBe(
        failure === "execution" ? "run.completed" : "run.failed"
      );

      if (failure === "execution") {
        expect(
          defined(events.find((event) => event.message === "sample.completed"))
            .annotations
        ).toMatchObject({
          error_stage: "execution",
          status: "error",
        });
        expect(defined(events.at(-1)).annotations.execution_errors).toBe(1);
      } else {
        expect(defined(events.at(-1)).annotations.stage).toBe("run");
        expect(result.stdout).toBe("");
      }

      expect(text).not.toContain("RAW_DIAGNOSTIC_SENTINEL");
      expect(text).not.toContain("24 hours");
    }
  );

  test.skipIf(process.platform === "win32")(
    "flushes lifecycle events when a run is interrupted",
    async () => {
      const { root, suite } = await fixture();
      const output = path.join(root, "interrupted");
      const marker = path.join(root, "started");
      const worker = path.join(root, "worker.ts");
      await Bun.write(
        worker,
        `await Bun.write(${JSON.stringify(marker)}, "started"); await Bun.sleep(30_000);`
      );

      const child = spawnCli(root, [
        "run",
        "--suite",
        suite,
        "--out",
        output,
        "--model",
        "stub",
        "--conditions",
        "no_skill",
        "--log-events",
        "--command",
        process.execPath,
        "--no-env-file",
        worker,
      ]);

      try {
        await runEffect(
          Effect.tryPromise(async () => await Bun.file(marker).text()).pipe(
            Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 })
          )
        );
        child.kill("SIGINT");
        await child.exited;
        const { events } = await readEvents(output);
        expect(events.map((event) => event.message)).toEqual([
          "run.started",
          "sample.started",
          "run.interrupted",
        ]);
        expect(defined(events.at(-1)).annotations.stage).toBe("run");
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await child.exited;
        }
      }
    }
  );

  test("discovers multiple skills and validates only available suites", async () => {
    const { root, spec } = await fixture();

    await Promise.all(
      ["first-skill", "second-skill"].map(async (name) => {
        const directory = path.join(root, "skills", name);
        await mkdir(directory, { recursive: true });
        await Bun.write(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: Synthetic skill fixture.\n---\nFixture instructions.\n`
        );
      })
    );

    const directory = path.join(root, "evals", "first-skill");
    await mkdir(directory, { recursive: true });
    const suite = path.join(directory, "suite.json");
    await runEffect(
      writeJson(suite, {
        ...spec,
        checks: path.join(root, "checks.json"),
        fixtures: path.join(root, "fixtures.json"),
        short_prompt: path.join(root, "short.txt"),
        skill: "../../skills/first-skill",
      })
    );

    const listed = await invoke(root, ["list"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject([
      { name: "first-skill", suite: await realpath(suite) },
      { name: "second-skill", suite: null },
    ]);

    const repository = await invoke(root, ["validate"]);
    expect(repository.code).toBe(0);
    expect(JSON.parse(repository.stdout)).toEqual({ skills: 2, suites: 1 });

    const selected = await invoke(root, ["validate", "--skill", "first-skill"]);
    expect(selected.code).toBe(0);
    expect(JSON.parse(selected.stdout)).toEqual({ cases: 1, suite: spec.name });

    const unevaluated = await invoke(root, [
      "validate",
      "--skill",
      "second-skill",
    ]);

    expect(unevaluated.code).toBe(2);
    expect(errorMessage(unevaluated.stderr)).toContain("evaluation");
  });

  test("validates a supplied suite and prints actionable help", async () => {
    const { root, suite } = await fixture();
    const result = await invoke(root, ["validate", "--suite", suite]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cases: 1,
      suite: "cli-integration",
    });
    expect(result.stderr).toBe("");
    const help = await invoke(root, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--command EXECUTABLE");
    expect(help.stdout).toContain("replay --suite PATH");
    expect(help.stdout).toContain("vp run skills validate");

    const implicitHelp = await invoke(root, []);
    expect(implicitHelp.code).toBe(0);
    expect(implicitHelp.stdout).toContain("skills");
    expect(implicitHelp.stderr).toBe("");

    const runHelp = await invoke(root, ["run", "--help"]);
    expect(runHelp.code).toBe(0);
    expect(runHelp.stdout).toContain("--executor");
    expect(runHelp.stdout).toContain("--timeout");
    expect(runHelp.stderr).toBe("");
  });

  test.each([
    ["unknown option", ["validate", "--typo"], "Unrecognized flag"],
    [
      "invalid split",
      ["validate", "--split", "other"],
      "Invalid value for flag --split",
    ],
  ])("rejects %s", async (_name, args, message) => {
    const { root, suite } = await fixture();

    const result = await invoke(root, [...args, "--suite", suite]);

    expect(result.code).toBe(2);
    expect(errorMessage(result.stderr)).toContain(message);
    expect(result.stdout).toBe("");
  });

  test("rejects invalid suite data instead of running a partial suite", async () => {
    const { root, suite, spec } = await fixture();
    await runEffect(
      writeJson(suite, {
        ...spec,
        cases: [{ ...spec.cases[0], language: "INVALID TAG" }],
      })
    );
    const result = await invoke(root, ["validate", "--suite", suite]);
    expect(result.code).toBe(2);
    expect(errorMessage(result.stderr)).toContain("language");
    expect(await readdir(root)).not.toContain("run");
  });

  test.each([
    ["missing executor", ["--model", "offline-model"], "Choose one executor"],
    ["missing model", [], "Missing required flag: --model"],
    [
      "empty command",
      ["--model", "offline-model", "--command"],
      "needs an executable",
    ],
    [
      "unknown executor",
      ["--model", "offline-model", "--executor", "other"],
      "Invalid value for flag --executor",
    ],
    [
      "two executors",
      [
        "--model",
        "offline-model",
        "--executor",
        "codex",
        "--command",
        process.execPath,
      ],
      "Choose one executor",
    ],
  ])(
    "rejects %s before connecting to a provider",
    async (_name, options, message) => {
      const { root, suite } = await fixture();

      const result = await invoke(root, [
        "run",
        "--suite",
        suite,
        "--out",
        path.join(root, "run"),
        ...options,
      ]);

      expect(result.code).toBe(2);
      expect(errorMessage(result.stderr)).toContain(message);
      expect(await readdir(root)).not.toContain("run");
    }
  );

  test.each([
    ["--seed", "1.5"],
    ["--repetitions", "0"],
    ["--concurrency", "1.5"],
    ["--timeout", "Infinity"],
    ["--timeout", "-1"],
  ])("rejects invalid numeric option %s=%s", async (option, value) => {
    const { root, suite } = await fixture();

    const result = await invoke(root, [
      "run",
      "--suite",
      suite,
      "--out",
      path.join(root, "run"),
      "--model",
      "offline-model",
      `${option}=${value}`,
      "--command",
      process.execPath,
    ]);

    expect(result.code).toBe(2);
    expect(errorMessage(result.stderr)).toMatch(/number|integer|positive/u);
    expect(await readdir(root)).not.toContain("run");
  });

  test.each(["[]", "{broken"])(
    "rejects invalid settings %s",
    async (settings) => {
      const { root, suite } = await fixture();

      const result = await invoke(root, [
        "run",
        "--suite",
        suite,
        "--out",
        path.join(root, "run"),
        "--model",
        "offline-model",
        "--settings",
        settings,
        "--command",
        process.execPath,
      ]);

      expect(result.code).toBe(2);
      expect(errorMessage(result.stderr).length).toBeGreaterThan(0);
      expect(await readdir(root)).not.toContain("run");
    }
  );

  test("resolves relative launchers and passes adapter arguments verbatim after global flags", async () => {
    const { root, suite } = await fixture();
    const worker = path.join(root, "worker.ts");
    const preload = path.join(root, "preload.ts");
    await Bun.write(preload, "");
    await Bun.write(
      worker,
      `const request = JSON.parse(await Bun.stdin.text());
process.stdout.write(JSON.stringify({
  output: "Wait 24 hours before retrying.",
  model: "offline-worker",
  executor_metadata: { argv: process.argv.slice(2), received_model: request.model, received_prompt: typeof request.prompt === "string" }
}));\n`
    );
    await Bun.write(
      path.join(root, "literal.ts"),
      "Application argument only.\n"
    );
    const run = path.join(root, "run");

    const result = await invoke(root, [
      "--log-level",
      "info",
      "run",
      "--suite",
      suite,
      "--out",
      run,
      "--model",
      "offline-model",
      "--conditions",
      "full_skill",
      "--command",
      process.execPath,
      "--no-env-file",
      "--preload",
      preload,
      "worker.ts",
      "--help",
      "--conditions",
      "literal.ts",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      execution_errors: 0,
      fidelity: "not_assessed",
      literal_failures: 0,
      results: 1,
    });

    const artifact = Schema.decodeUnknownSync(RunArtifactSchema)(
      await runEffect(readJson(path.join(run, "run.json"))),
      { onExcessProperty: "error" }
    );

    expect(artifact.manifest.executor_argv?.slice(1)).toEqual([
      "--no-env-file",
      "--preload",
      preload,
      await realpath(worker),
      "--help",
      "--conditions",
      "literal.ts",
    ]);
    expect(defined(artifact.results[0]).executor_metadata).toEqual({
      argv: ["--help", "--conditions", "literal.ts"],
      received_model: "offline-model",
      received_prompt: true,
    });
    expect(defined(artifact.results[0]).reported_model).toBe("offline-worker");
  });

  test("rejects duplicate replay conditions before creating a run", async () => {
    const { root, suite, replay } = await fixture();

    const result = await invoke(root, [
      "replay",
      "--suite",
      suite,
      "--out",
      path.join(root, "run"),
      "--outputs",
      `no_skill=${replay}`,
      "--outputs",
      `no_skill=${replay}`,
    ]);

    expect(result.code).toBe(2);
    expect(errorMessage(result.stderr)).toContain("Duplicate replay condition");
    expect(await readdir(root)).not.toContain("run");
  });

  test.each([
    ["missing sources", []],
    ["invalid condition", ["--outputs", "unknown=/missing"]],
    ["empty path", ["--outputs", "no_skill="]],
    [
      "missing file",
      ["--outputs", "no_skill=/missing-skills-test-output.json"],
    ],
  ])("rejects replay with %s", async (_name, options) => {
    const { root, suite } = await fixture();

    const result = await invoke(root, [
      "replay",
      "--suite",
      suite,
      "--out",
      path.join(root, "run"),
      ...options,
    ]);

    expect(result.code).toBe(2);
    expect(errorMessage(result.stderr).length).toBeGreaterThan(0);
    expect(await readdir(root)).not.toContain("run");
  });

  test.each([
    ["invalid JSON", "{broken"],
    ["invalid response", '[{"id":"retry-email","output":42}]'],
  ])("rejects replay files with %s", async (_name, content) => {
    const { root, suite, replay } = await fixture();
    await Bun.write(replay, content);

    const result = await invoke(root, [
      "replay",
      "--suite",
      suite,
      "--out",
      path.join(root, "run"),
      "--outputs",
      `no_skill=${replay}`,
    ]);

    expect(result.code).toBe(2);
    expect(errorMessage(result.stderr).length).toBeGreaterThan(0);
    expect(await readdir(root)).not.toContain("run");
  });

  test("report preserves a summary.json input through a symlink", async () => {
    const { root, suite, replay } = await fixture();
    const run = path.join(root, "run");

    const replayed = await invoke(root, [
      "replay",
      "--suite",
      suite,
      "--out",
      run,
      "--outputs",
      `no_skill=${replay}`,
    ]);

    expect(replayed.code).toBe(0);
    const target = path.join(root, "summary.json");
    await Bun.write(target, Bun.file(path.join(run, "run.json")));
    const original = await Bun.file(target).text();
    const input = path.join(root, "artifact");

    await runEffect(
      Effect.gen(function* linkArtifact() {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.symlink(target, input);
      })
    );

    const reported = await invoke(root, ["report", "--run", input]);
    expect(reported.code).toBe(2);
    expect(reported.stdout).toBe("");
    expect(errorMessage(reported.stderr)).toContain(
      "overwrite an input artifact"
    );
    expect(await Bun.file(target).text()).toBe(original);
    expect(await Bun.file(input).text()).toBe(original);
  });

  test.each([
    ["judgments", "direct"],
    ["decoding", "symlink"],
    ["judgments", "parent-segment"],
    ["comprehension", "directory"],
    ["comprehension", "file"],
  ])("report preserves %s input through a %s path", async (input, kind) => {
    const { root, suite, replay } = await fixture();
    const run = path.join(root, "run");

    const replayed = await invoke(root, [
      "replay",
      "--suite",
      suite,
      "--out",
      run,
      ...["no_skill", "full_skill"].flatMap((condition) => [
        "--outputs",
        `${condition}=${replay}`,
      ]),
    ]);

    expect(replayed.code).toBe(0);

    const review = path.join(root, "review");

    const exported = await invoke(root, [
      "review",
      "--run",
      run,
      "--out",
      review,
    ]);

    expect(exported.code).toBe(0);

    const judgments = path.join(review, "judgments.json");
    const decoding = path.join(root, "review-decoding.json");

    const inputPath =
      input === "decoding" ? decoding : path.join(review, `${input}.json`);

    const target = path.join(run, "summary.json");
    await Bun.write(target, Bun.file(inputPath));
    const original = await Bun.file(target).text();

    if (kind !== "direct") {
      await runEffect(
        Effect.gen(function* aliasReviewInput() {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(inputPath);
          yield* fs.symlink(target, inputPath);
        })
      );
    }

    let reviewInput =
      input === "judgments" && kind === "direct" ? target : judgments;

    if (kind === "parent-segment") {
      const aliases = path.join(root, "aliases");
      const nested = path.join(run, "nested");
      await mkdir(aliases);
      await mkdir(nested);
      await Bun.write(path.join(aliases, "summary.json"), original);
      await runEffect(
        Effect.gen(function* aliasParentTraversal() {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.symlink(nested, path.join(aliases, "link"));
        })
      );

      const alias = `${aliases}/link/../summary.json`;

      reviewInput = alias;
    }

    const reported = await invoke(root, [
      "report",
      "--run",
      run,
      "--reviews",
      kind === "directory" ? review : reviewInput,
      "--decoding",
      decoding,
    ]);

    expect(reported.code).toBe(2);
    expect(reported.stdout).toBe("");
    expect(errorMessage(reported.stderr)).toContain(
      "overwrite an input artifact"
    );
    expect(await Bun.file(target).text()).toBe(original);
    expect(await Bun.file(inputPath).text()).toBe(original);
  });

  test("replays, exports an anonymous review, and reports pending assessments separately from anchor failures", async () => {
    const { root, suite, replay } = await fixture();
    const failedAnchors = path.join(root, "failed-anchors.json");
    await runEffect(
      writeJson(failedAnchors, [
        { id: "retry-email", output: "Retry when ready." },
      ])
    );
    const run = path.join(root, "run.json");

    const replayed = await invoke(root, [
      "replay",
      "--suite",
      suite,
      "--out",
      run,
      ...CONDITIONS.flatMap((condition) => [
        "--outputs",
        `${condition}=${condition === "short_prompt" ? failedAnchors : replay}`,
      ]),
    ]);

    expect(replayed.code).toBe(1);
    expect(replayed.stderr).toBe("");
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      execution_errors: 0,
      fidelity: "not_assessed",
      literal_failures: 1,
      results: 3,
    });

    const artifact = Schema.decodeUnknownSync(RunArtifactSchema)(
      await runEffect(readJson(path.join(run, "run.json"))),
      { onExcessProperty: "error" }
    );

    expect(artifact.manifest.mode).toBe("replay");
    expect(artifact.manifest.requested_model).toBeNull();
    expect(
      artifact.results.every((result) => result.status === "success")
    ).toBe(true);

    const review = path.join(root, "review");

    const exported = await invoke(root, [
      "review",
      "--run",
      run,
      "--out",
      review,
      "--seed",
      "17",
    ]);

    expect(exported.code).toBe(0);
    expect(exported.stderr).toBe("");
    const reviewFiles = await readdir(review);
    expect(reviewFiles.toSorted()).toEqual([
      "comparisons.json",
      "comprehension.json",
      "judgments.json",
    ]);

    const reported = await invoke(root, [
      "report",
      "--run",
      path.join(run, "run.json"),
      "--reviews",
      review,
      "--decoding",
      path.join(root, "review-decoding.json"),
    ]);

    expect(reported.code).toBe(0);
    expect(reported.stderr).toBe("");

    const summary = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          assessment: Schema.Struct({
            comprehension_correctness: Schema.String,
            preference_judged_groups: Schema.Finite,
            preference_pending_groups: Schema.Finite,
          }),
          groups: Schema.Array(
            Schema.Struct({
              anchors_failed: Schema.Finite,
              fidelity_passed: Schema.Finite,
              fidelity_pending: Schema.Finite,
            })
          ),
          paired_groups: Schema.Finite,
          unpaired_groups: Schema.Finite,
        })
      )
    )(reported.stdout);

    expect(summary.paired_groups).toBe(1);
    expect(summary.unpaired_groups).toBe(0);
    expect(
      summary.groups.reduce((sum, group) => sum + group.anchors_failed, 0)
    ).toBe(1);
    expect(
      summary.groups.reduce((sum, group) => sum + group.fidelity_pending, 0)
    ).toBe(3);
    expect(
      summary.groups.reduce((sum, group) => sum + group.fidelity_passed, 0)
    ).toBe(0);
    expect(summary.assessment).toMatchObject({
      comprehension_correctness: "not_scored",
      preference_judged_groups: 0,
      preference_pending_groups: 1,
    });
    expect(
      JSON.parse(await Bun.file(path.join(run, "summary.json")).text())
    ).toEqual(JSON.parse(reported.stdout));

    const artifactFile = path.join(root, "artifact");
    await Bun.write(artifactFile, Bun.file(path.join(run, "run.json")));

    const reportFromFile = await invoke(root, [
      "report",
      "--run",
      artifactFile,
    ]);

    expect(reportFromFile.code).toBe(0);
    expect(reportFromFile.stderr).toBe("");
    expect(
      JSON.parse(await Bun.file(path.join(root, "summary.json")).text())
    ).toEqual(JSON.parse(reportFromFile.stdout));

    const aliases = path.join(root, "aliases");
    const nested = path.join(review, "nested");
    await mkdir(aliases);
    await mkdir(nested);
    await runEffect(
      Effect.gen(function* linkReviewParent() {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.symlink(nested, path.join(aliases, "link"));
      })
    );

    const reportFromAlias = await invoke(root, [
      "report",
      "--run",
      artifactFile,
      "--reviews",
      `${aliases}/link/../judgments.json`,
      "--decoding",
      path.join(root, "review-decoding.json"),
    ]);

    expect(reportFromAlias.code).toBe(0);
    expect(reportFromAlias.stderr).toBe("");
    expect(JSON.parse(reportFromAlias.stdout)).toEqual(
      JSON.parse(reported.stdout)
    );
    expect(await Bun.file(path.join(aliases, "judgments.json")).exists()).toBe(
      false
    );
  });
});
