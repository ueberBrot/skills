import { Duration, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { HarnessError } from "../errors";
import { ISOLATION_FLAGS, sanitizedEnvironment } from "./auth";

const inspectCli = Effect.fnUntraced(
  function* inspectCli(
    argv: readonly [string, ...string[]],
    environment: Record<string, string>
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make(argv[0], argv.slice(1), {
        env: environment,
        extendEnv: false,
        forceKillAfter: Duration.millis(250),
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      })
    );

    const [code, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      ],
      { concurrency: "unbounded" }
    );

    return { code, stderr, stdout };
  },
  Effect.scoped,
  Effect.timeout(Duration.seconds(10)),
  Effect.mapError(
    () =>
      new HarnessError({
        message: "Could not inspect Codex CLI; diagnostics were not saved",
      })
  )
);

export const inspectCodex = Effect.fn("inspectCodex")(function* inspectCodex() {
  const environment = yield* sanitizedEnvironment();

  const executable = yield* Effect.sync(() =>
    Bun.which("codex", { PATH: environment.PATH })
  );

  if (executable === null || executable.length === 0) {
    return yield* new HarnessError({
      message: "Codex CLI is not installed or is not on PATH",
    });
  }

  const version = yield* inspectCli([executable, "--version"], environment);

  const match =
    /^codex-cli (?<version>\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/u.exec(
      version.stdout
    );

  const cliVersion = match?.groups?.version;

  if (
    version.code !== 0 ||
    cliVersion === undefined ||
    cliVersion.length === 0
  ) {
    return yield* new HarnessError({
      message: "Could not identify the installed Codex CLI version",
    });
  }

  const help = yield* inspectCli([executable, "exec", "--help"], environment);

  if (
    help.code !== 0 ||
    [...ISOLATION_FLAGS, "--json", "--sandbox", "--skip-git-repo-check"].some(
      (flag) => !help.stdout.includes(flag)
    )
  ) {
    return yield* new HarnessError({
      message:
        "Codex CLI lacks required isolation flags; update Codex before evaluating",
    });
  }

  const features = yield* inspectCli(
    [executable, "features", "list"],
    environment
  );

  if (
    features.code !== 0 ||
    !features.stdout.includes("skip_host_skill_discovery")
  ) {
    return yield* new HarnessError({
      message: "Codex CLI lacks the required skill-isolation capability",
    });
  }

  const login = yield* inspectCli([executable, "login", "status"], environment);
  const lines = `${login.stdout}\n${login.stderr}`.split(/\r?\n/u);

  if (
    login.code !== 0 ||
    !lines.includes("Logged in using ChatGPT") ||
    lines.some((line) => line.includes("Logged in using an API key"))
  ) {
    return yield* new HarnessError({
      message:
        "Existing ChatGPT login required; API-key authentication is not allowed",
    });
  }

  return { environment, executable, version: cliVersion };
});
