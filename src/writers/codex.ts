import { chat, REASONING_LEVELS } from "@tanstack/ai";
import { codexText } from "@tanstack/ai-codex";
import { Duration, Effect, Schema } from "effect";

import { WriterOutputSchema } from "../domain";
import { HarnessError } from "../errors";
import { CODEX_EXECUTABLE_ENV, ISOLATION_FLAGS } from "./auth";
import { inspectCodex } from "./codex-preflight";
import { runLocalSession } from "./local-session";

import type { JsonObject, WriterInput } from "../domain";
import type {
  PreparedWriter,
  WriterConfiguration,
  WriterDescriptor,
} from "./service";
import type { CodexModel } from "@tanstack/ai-codex";

const LAUNCHER_PATH = Bun.fileURLToPath(
  new URL("launcher.ts", import.meta.url)
);

const POLICY: JsonObject = {
  approval_policy: "never",
  "cloud.skills.enabled": false,
  "features.apps": false,
  "features.browser_use": false,
  "features.computer_use": false,
  "features.hooks": false,
  "features.image_generation": false,
  "features.in_app_browser": false,
  "features.memories": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.plugins": false,
  "features.shell_tool": false,
  "features.skill_mcp_dependency_install": false,
  "features.skill_search": false,
  "features.skip_host_skill_discovery": true,
  "features.view_image": false,
  forced_login_method: "chatgpt",
  "history.persistence": "none",
  model_provider: "openai",
  project_doc_max_bytes: 0,
  "skills.bundled.enabled": false,
  "skills.include_instructions": false,
  web_search: "disabled",
};

const CodexSettingsSchema = Schema.Struct({
  model_reasoning_effort: Schema.optionalKey(
    Schema.Literals([
      ...REASONING_LEVELS.filter((level) => level !== "off"),
      // Native Codex supports this beyond TanStack's generic reasoning levels.
      "ultra",
    ])
  ),
  model_verbosity: Schema.optionalKey(
    Schema.Literals(["low", "medium", "high"])
  ),
});

const validateCodexRequest = Effect.fnUntraced(function* validateCodexRequest(
  request: WriterConfiguration
): Effect.fn.Return<CodexModel, HarnessError> {
  const { model } = request;

  if (model === null || model.trim().length === 0) {
    return yield* new HarnessError({
      message: "The Codex executor requires an explicit model",
    });
  }

  yield* Schema.decodeEffect(CodexSettingsSchema)(request.settings, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      () =>
        new HarnessError({ message: "Unsupported or invalid Codex setting" })
    )
  );

  return model;
});

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const executionError = () =>
  new HarnessError({
    message: "Codex execution failed; diagnostics were not saved",
  });

class CodexExecutor {
  readonly descriptor: WriterDescriptor;
  private readonly executable: string;
  private readonly version: string;
  private readonly environment: Record<string, string>;

  constructor(
    executable: string,
    version: string,
    environment: Record<string, string>
  ) {
    this.executable = executable;
    this.version = version;
    this.environment = environment;
    this.descriptor = {
      command: [executable, "exec"],
      files: [executable, process.execPath, LAUNCHER_PATH],
      metadata: this.metadata(),
      name: "codex",
    };
  }

  private metadata(): JsonObject {
    const cliFlags = ["--no-daemon", ...ISOLATION_FLAGS];
    const requestedPolicy = { ...POLICY };
    Object.freeze(cliFlags);
    Object.freeze(requestedPolicy);

    return {
      authentication: "chatgpt",
      backend: "tanstack-codex",
      cli_flags: cliFlags,
      cli_version: this.version,
      model_metadata:
        "TanStack reports the requested model; actual model/settings stay unknown.",
      requested_policy: requestedPolicy,
      sandbox: "read-only",
      session: "ephemeral",
    };
  }

  readonly execute = Effect.fn("CodexExecutor.execute")(function* execute(
    this: CodexExecutor,
    request: WriterInput,
    timeoutSeconds: number
  ) {
    const model = yield* validateCodexRequest(request);

    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      return yield* new HarnessError({
        message: "Codex timeout must be positive",
      });
    }

    const { environment } = this;
    const { executable } = this;
    const metadata = this.metadata();

    const launcher = [
      process.execPath,
      "--no-env-file",
      "--no-orphans",
      LAUNCHER_PATH,
    ]
      .map(quote)
      .join(" ");

    const generation = runLocalSession(
      {
        environment,
        passEnv: [
          "CODEX_HOME",
          "HTTPS_PROXY",
          "HTTP_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "NODE_EXTRA_CA_CERTS",
          "SSH_AUTH_SOCK",
        ],
        scrubEnv: ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
      },
      ({ abortController, adapterEnvironment, middleware, runId, threadId }) =>
        chat({
          abortController,
          adapter: codexText(model, {
            authMode: "host",
            codexExecutable: launcher,
            config: Object.fromEntries(
              Object.entries({ ...POLICY, ...request.settings }).map(
                ([key, value]) => [key, JSON.stringify(value)]
              )
            ),
            env: {
              ...adapterEnvironment,
              [CODEX_EXECUTABLE_ENV]: executable,
            },
            sandboxMode: "read-only",
            webSearchMode: "disabled",
          }),
          debug: false,
          messages: [{ content: request.prompt, role: "user" }],
          middleware,
          retry: { maxRetries: 0 },
          runId,
          threadId,
        })
    ).pipe(
      Effect.flatMap((completion) =>
        Schema.decodeEffect(WriterOutputSchema)(
          {
            executor_metadata: {
              ...metadata,
              requested_settings: request.settings,
            },
            ...completion,
          },
          { onExcessProperty: "error" }
        )
      ),
      Effect.mapError(executionError),
      Effect.catchDefect(() => Effect.fail(executionError()))
    );

    return yield* generation.pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(timeoutSeconds),
        orElse: () =>
          Effect.fail(
            new HarnessError({ message: "Codex execution timed out" })
          ),
      })
    );
  });
}

export const prepareCodex = Effect.fn("prepareCodex")(function* prepareCodex() {
  const { environment, executable, version } = yield* inspectCodex();

  const executor = new CodexExecutor(executable, version, environment);

  return {
    descriptor: executor.descriptor,
    execute: executor.execute.bind(executor),
    validate: (configuration) =>
      validateCodexRequest(configuration).pipe(Effect.asVoid),
  } satisfies PreparedWriter;
});
