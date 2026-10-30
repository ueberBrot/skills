import { access, chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "@effect/vitest";
import {
  Effect,
  Fiber,
  FileSystem,
  PlatformError,
  Schedule,
  Schema,
} from "effect";

import { HarnessError } from "../src/errors";
import { REPO } from "../src/paths";
import { executeSuite } from "../src/runs";
import { prepareWriter, Writer } from "../src/writers";
import { sanitizedEnvironment } from "../src/writers/auth";
import { run as runEffect } from "./shared";

import type { WriterInput } from "../src/domain";
import type { LoadedSuite } from "../src/suites";
import type { CodexFixtureConfiguration } from "./fixtures/codex-cli";
import type { ReasoningLevel } from "@tanstack/ai";
import type { CodexModel } from "@tanstack/ai-codex";

const MODEL = "gpt-6.1-terra" satisfies CodexModel;
const REASONING = "medium" satisfies ReasoningLevel;
const OUTPUT = "Grüße — voilà\nPreserve the intended meaning.";
const SENTINEL = "FAKE_TEST_ONLY_NOT_A_CREDENTIAL";
const originals = new Map<string, string | undefined>();
const directories: string[] = [];

const CaptureSchema = Schema.Struct({
  api_keys_present: Schema.Array(Schema.String),
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  generation: Schema.Boolean,
  input: Schema.NullOr(Schema.String),
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
});

const setEnvironment = (key: string, value: string): void => {
  if (!originals.has(key)) {
    originals.set(key, process.env[key]);
  }

  process.env[key] = value;
};

afterEach(async () => {
  for (const [key, value] of originals) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  originals.clear();

  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

const installStub = async (
  options: {
    mode?: CodexFixtureConfiguration["mode"];
    login?: string;
    loginStream?: "stdout" | "stderr";
    capabilities?: boolean;
  } = {}
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "writing-codex-test-"));
  directories.push(directory);
  const binary = path.join(directory, "codex");
  const captures = path.join(directory, "captures");
  await mkdir(captures);

  const configuration = {
    capabilities: options.capabilities ?? true,
    captures,
    login: options.login ?? "Logged in using ChatGPT",
    loginStream: options.loginStream ?? "stderr",
    mode: options.mode ?? "valid",
    output: OUTPUT,
    sentinel: SENTINEL,
  } satisfies CodexFixtureConfiguration;

  await Bun.write(
    path.join(directory, "fixture.json"),
    JSON.stringify(configuration)
  );

  const fixture = Bun.fileURLToPath(
    new URL("fixtures/codex-cli.ts", import.meta.url)
  );

  await Bun.write(
    binary,
    `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`
  );
  await chmod(binary, 0o755);
  setEnvironment(
    "PATH",
    `${directory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
  );

  return {
    async calls(): Promise<(typeof CaptureSchema.Type)[]> {
      const files = await readdir(captures);

      return await Promise.all(
        files.map(async (file) =>
          Schema.decodeSync(Schema.fromJsonString(CaptureSchema))(
            await Bun.file(path.join(captures, file)).text(),
            { onExcessProperty: "error" }
          )
        )
      );
    },
    directory,
  };
};

const request = (): WriterInput => ({
  model: MODEL,
  prompt: "Bitte überarbeiten. Grüße — voilà!",
  settings: {
    model_reasoning_effort: REASONING,
    model_verbosity: "low",
  },
});

test("TanStack Codex preserves Unicode, normalized usage, isolation flags, and metadata", async () => {
  const stub = await installStub();

  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "AZURE_OPENAI_API_KEY",
  ]) {
    setEnvironment(key, SENTINEL);
  }

  const executor = await runEffect(
    prepareWriter({ _tag: "Builtin", name: "codex" })
  );

  const first = await runEffect(executor.execute(request(), 5));
  const second = await runEffect(executor.execute(request(), 5));
  expect(first.output).toBe(OUTPUT);
  expect(second.output).toBe(OUTPUT);
  expect(first.model).toBeNull();
  expect(first.settings).toBeNull();
  expect(first.usage).toEqual({
    cached_input_tokens: 3,
    input_tokens: 17,
    output_tokens: 8,
    total_tokens: 25,
  });
  expect(first.executor_metadata?.cli_version).toBe("0.165.0");
  const calls = await stub.calls();
  expect(calls.every((call) => call.api_keys_present.length === 0)).toBe(true);
  const generations = calls.filter((call) => call.generation);
  expect(generations).toHaveLength(2);
  expect(new Set(generations.map((call) => call.cwd)).size).toBe(2);

  await Promise.all(
    generations.map(async (call) => {
      await expect(access(call.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    })
  );

  for (const call of generations) {
    expect(call.input).toContain(request().prompt);
    expect(call.args).toContain("--no-daemon");

    for (const flag of [
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--strict-config",
    ]) {
      expect(call.args).toContain(flag);
    }

    expect(call.args).toContain('forced_login_method="chatgpt"');
    expect(call.args).toContain('model_provider="openai"');
    expect(call.args[call.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("gpt-6.1-terra");
    expect(call.args).toContain('model_reasoning_effort="medium"');
  }

  expect(JSON.stringify(calls)).not.toContain(SENTINEL);
  expect(JSON.stringify(first)).not.toContain(SENTINEL);
}, 15_000);

test("returns the final completed assistant message without commentary or duplicate deltas", async () => {
  await installStub({ mode: "multiple-messages" });

  const executor = await runEffect(
    prepareWriter({ _tag: "Builtin", name: "codex" })
  );

  const result = await runEffect(executor.execute(request(), 5));
  expect(result.output).toBe(OUTPUT);
});

for (const loginStream of ["stdout", "stderr"] as const) {
  test(`ChatGPT login is accepted on ${loginStream}`, async () => {
    await installStub({ loginStream });

    const executor = await runEffect(
      prepareWriter({ _tag: "Builtin", name: "codex" })
    );

    expect(executor.descriptor.metadata.authentication).toBe("chatgpt");
  });
}

for (const login of [
  `Logged in using an API key ${SENTINEL}`,
  "Not logged in",
]) {
  test("non-ChatGPT authentication fails before generation without leaking diagnostics", async () => {
    const stub = await installStub({ login });

    const error = await runEffect(
      Effect.flip(prepareWriter({ _tag: "Builtin", name: "codex" }))
    );

    expect(String(error)).not.toContain(SENTINEL);
    expect(String(error)).toContain("ChatGPT login required");

    const calls = await stub.calls();
    expect(calls.some((call) => call.generation)).toBe(false);
  });
}

test("old CLI is rejected before generation", async () => {
  const stub = await installStub({ capabilities: false });

  const error = await runEffect(
    Effect.flip(prepareWriter({ _tag: "Builtin", name: "codex" }))
  );

  expect(error.message).toContain("required isolation flags");
  const calls = await stub.calls();
  expect(calls.some((call) => call.generation)).toBe(false);
});

test("credential location is preserved without creating or reading credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "writing-auth-path-"));
  directories.push(directory);
  const authPath = path.join(directory, "external-auth-does-not-exist");

  await Promise.all(
    ["", "/", "//"].map(async (suffix) => {
      const source = {
        CODEX_HOME: `${authPath}${suffix}`,
        OPENAI_API_KEY: SENTINEL,
      };

      const sanitized = await runEffect(sanitizedEnvironment(source));
      expect(sanitized.CODEX_HOME).toBe(source.CODEX_HOME);
      expect(sanitized.OPENAI_API_KEY).toBeUndefined();
    })
  );

  await expect(access(authPath)).rejects.toMatchObject({ code: "ENOENT" });

  await Promise.all(
    ["", path.join(REPO, ".local-auth"), "~/.codex", "relative-auth"].map(
      async (invalid) => {
        const error = await runEffect(
          Effect.flip(sanitizedEnvironment({ CODEX_HOME: invalid }))
        );

        expect(error.message).toContain("outside the repository");
      }
    )
  );

  await Promise.all(
    ["", "relative-home"].map(async (invalid) => {
      const error = await runEffect(
        Effect.flip(sanitizedEnvironment({ HOME: invalid }))
      );

      expect(error.message).toContain("outside the repository");
    })
  );
});

test.each([
  ["direct", ""],
  ["one trailing slash", "/"],
  ["dot segment", "/."],
  ["ancestor", "/nested"],
  ["parent segment", "/.."],
  ["parent segment and child", "/../auth"],
])(
  "credential path checks reject a dangling symlink with %s",
  async (_description, suffix) => {
    const directory = await mkdtemp(path.join(tmpdir(), "writing-auth-link-"));
    directories.push(directory);
    const target = path.join(REPO, `.missing-auth-${crypto.randomUUID()}`);
    const link = path.join(directory, "auth-link");
    await runEffect(
      Effect.gen(function* createDanglingAuthLink() {
        const filesystem = yield* FileSystem.FileSystem;
        yield* filesystem.symlink(target, link);
      })
    );

    const authPath = `${link}${suffix}`;

    const error = await runEffect(
      Effect.flip(sanitizedEnvironment({ CODEX_HOME: authPath }))
    );

    expect(error.message).toContain("outside the repository");
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  }
);

test("credential path checks fail closed on permission errors", async () => {
  const authPath = "/external-auth-not-readable";
  const inspected: string[] = [];

  const filesystem = FileSystem.layerNoop({
    realPath: (candidate) => {
      inspected.push(candidate);

      return candidate === authPath
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              method: "realPath",
              module: "FileSystem",
            })
          )
        : Effect.succeed(candidate);
    },
  });

  const error = await runEffect(
    Effect.flip(
      sanitizedEnvironment({ CODEX_HOME: authPath }).pipe(
        Effect.provide(filesystem)
      )
    )
  );

  expect(error.message).toContain("outside the repository");
  expect(inspected.at(-1)).toBe(authPath);
});

test.each(["HOME", "USERPROFILE"])(
  "default credential location resolves symlinks before parent segments in %s",
  async (key) => {
    const directory = await mkdtemp(path.join(tmpdir(), "writing-home-link-"));
    directories.push(directory);
    const link = path.join(directory, "home-link");
    await runEffect(
      Effect.gen(function* linkRepositoryChild() {
        const filesystem = yield* FileSystem.FileSystem;
        yield* filesystem.symlink(path.join(REPO, "src"), link);
      })
    );

    const error = await runEffect(
      Effect.flip(sanitizedEnvironment({ [key]: `${link}/..` }))
    );

    expect(error.message).toContain("outside the repository");
  }
);

test.each(["CODEX_HOME", "HOME", "USERPROFILE"])(
  "%s cannot erase a missing repository directory with parent segments",
  async (key) => {
    const missing = path.join(REPO, `.missing-auth-${crypto.randomUUID()}`);

    const error = await runEffect(
      Effect.flip(sanitizedEnvironment({ [key]: `${missing}/../..` }))
    );

    expect(error.message).toContain("outside the repository");
    await expect(access(missing)).rejects.toMatchObject({ code: "ENOENT" });
  }
);

test.each(["/.", "/..", "/../auth", "/./../.."])(
  "credential paths reject traversal through a missing external directory with %s",
  async (suffix) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "writing-missing-home-")
    );

    directories.push(directory);
    const missing = path.join(directory, "missing");

    const error = await runEffect(
      Effect.flip(sanitizedEnvironment({ CODEX_HOME: `${missing}${suffix}` }))
    );

    expect(error.message).toContain("outside the repository");
    await expect(access(missing)).rejects.toMatchObject({ code: "ENOENT" });
  }
);

test.each(["/.", "/.."])(
  "credential paths reject traversal through a regular file with %s",
  async (suffix) => {
    const directory = await mkdtemp(path.join(tmpdir(), "writing-file-home-"));
    directories.push(directory);

    const file = path.join(directory, "regular-file");
    await Bun.write(file, "ordinary test data");

    const error = await runEffect(
      Effect.flip(sanitizedEnvironment({ CODEX_HOME: `${file}${suffix}` }))
    );

    expect(error.message).toContain("outside the repository");
    expect(await Bun.file(file).text()).toBe("ordinary test data");
  }
);

test.each(["HOME", "USERPROFILE"])(
  "external default credential location preserves the original %s spelling",
  async (key) => {
    const directory = await mkdtemp(path.join(tmpdir(), "writing-home-path-"));
    directories.push(directory);
    const nested = path.join(directory, "nested");
    const link = path.join(directory, "home-link");
    await runEffect(
      Effect.gen(function* linkExternalChild() {
        const filesystem = yield* FileSystem.FileSystem;
        yield* filesystem.makeDirectory(nested);
        yield* filesystem.symlink(nested, link);
      })
    );

    const source = { [key]: `${link}/..` };
    const environment = await runEffect(sanitizedEnvironment(source));
    expect(environment[key]).toBe(source[key]);
    expect(environment.CODEX_HOME).toBeUndefined();
    await expect(access(path.join(directory, ".codex"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
);

for (const mode of ["malformed", "failed", "nonzero"] as const) {
  test(`bad Codex result ${mode} fails without raw diagnostics`, async () => {
    const stub = await installStub({ mode });

    const executor = await runEffect(
      prepareWriter({ _tag: "Builtin", name: "codex" })
    );

    const error = await runEffect(Effect.flip(executor.execute(request(), 5)));

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(SENTINEL);

    const calls = await stub.calls();
    const generations = calls.filter((call) => call.generation);

    expect(generations).toHaveLength(1);

    await Promise.all(
      generations.map(async (call) => {
        await expect(access(call.cwd)).rejects.toMatchObject({
          code: "ENOENT",
        });
      })
    );
  }, 10_000);
}

test("timed out Codex execution releases its process and workspace", async () => {
  const stub = await installStub({ mode: "timeout" });

  const executor = await runEffect(
    prepareWriter({ _tag: "Builtin", name: "codex" })
  );

  const error = await runEffect(Effect.flip(executor.execute(request(), 0.5)));

  expect(error.message).toBe("Codex execution timed out");
  const calls = await stub.calls();
  const generation = calls.find((call) => call.generation);
  expect(generation).toBeDefined();

  if (generation === undefined) {
    throw new Error("Expected Codex generation to start before timing out");
  }

  expect(() => process.kill(generation.pid, 0)).toThrow();
  await expect(access(generation.cwd)).rejects.toMatchObject({
    code: "ENOENT",
  });
}, 10_000);

test("interrupting Codex execution releases its process and workspace", async () => {
  const stub = await installStub({ mode: "timeout" });

  const executor = await runEffect(
    prepareWriter({ _tag: "Builtin", name: "codex" })
  );

  const generation = await runEffect(
    Effect.gen(function* interruptGeneration() {
      const fiber = yield* Effect.forkChild(executor.execute(request(), 15));

      const started = yield* Effect.tryPromise(
        async () => await stub.calls()
      ).pipe(
        Effect.flatMap((calls) => {
          const call = calls.find((entry) => entry.generation);

          return call === undefined
            ? Effect.fail(
                new HarnessError({ message: "Generation has not started" })
              )
            : Effect.succeed(call);
        }),
        Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 80 })
      );

      yield* Fiber.interrupt(fiber);

      return started;
    })
  );

  expect(() => process.kill(generation.pid, 0)).toThrow();
  await expect(access(generation.cwd)).rejects.toMatchObject({
    code: "ENOENT",
  });
}, 10_000);

const invalidSettings: WriterInput["settings"][] = [
  { model_provider: "other" },
  { forced_login_method: "api" },
  { model_reasoning_effort: "imaginary" },
];

test("invalid Codex run configuration leaves no artifacts or generated samples", async () => {
  const stub = await installStub();
  const output = path.join(stub.directory, "not-created", "run");

  const suite: LoadedSuite = {
    assess: () => Effect.succeed(null),
    cases: [
      {
        checks: [],
        fixture: { id: "example", request: "Edit this.", source: "A draft." },
        spec: {
          anchors: [],
          id: "example",
          language: "en",
          provenance: "synthetic-test",
          reader_questions: [],
          references: [],
          split: "development",
          task: "editing",
        },
      },
    ],
    name: "configuration-preflight",
    promptFor: () => "Edit this text.",
    provenance: {},
    skillName: "skill",
  };

  const executor = await runEffect(
    prepareWriter({ _tag: "Builtin", name: "codex" })
  );

  const error = await runEffect(
    executeSuite(suite, output, {
      model: MODEL,
      settings: { model_reasoning_effort: "imaginary" },
    }).pipe(Effect.provideService(Writer, executor), Effect.flip)
  );

  expect(error.message).toContain("Codex setting");
  await expect(access(path.dirname(output))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const calls = await stub.calls();
  expect(calls.some((call) => call.generation)).toBe(false);
});

for (const settings of invalidSettings) {
  test("unsupported settings cannot override authentication", async () => {
    const stub = await installStub();

    const executor = await runEffect(
      prepareWriter({ _tag: "Builtin", name: "codex" })
    );

    const error = await runEffect(
      Effect.flip(executor.execute({ ...request(), settings }, 5))
    );

    expect(error.message).toContain("Codex setting");
    const calls = await stub.calls();
    expect(calls.some((call) => call.generation)).toBe(false);
  });
}

for (const model of [null, "   "]) {
  test("Codex requires an explicit model", async () => {
    const stub = await installStub();

    const executor = await runEffect(
      prepareWriter({ _tag: "Builtin", name: "codex" })
    );

    const error = await runEffect(
      Effect.flip(executor.execute({ ...request(), model }, 5))
    );

    expect(error.message).toContain("explicit model");
    const calls = await stub.calls();
    expect(calls.some((call) => call.generation)).toBe(false);
  });
}
