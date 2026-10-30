import path from "node:path";

import { Schema } from "effect";

import type { CodexThreadEvent } from "@tanstack/ai-codex";

const ConfigurationSchema = Schema.Struct({
  capabilities: Schema.Boolean,
  captures: Schema.String,
  login: Schema.String,
  loginStream: Schema.Literals(["stdout", "stderr"]),
  mode: Schema.Literals([
    "valid",
    "timeout",
    "nonzero",
    "malformed",
    "failed",
    "multiple-messages",
  ]),
  output: Schema.String,
  sentinel: Schema.String,
});

export type CodexFixtureConfiguration = typeof ConfigurationSchema.Type;

const emit = (event: CodexThreadEvent): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const generate = async (
  configuration: CodexFixtureConfiguration,
  args: readonly string[]
): Promise<number> => {
  if (args.includes("--experimental-json") || !args.includes("--json")) {
    return 7;
  }

  const { mode, output, sentinel } = configuration;

  if (mode === "timeout") {
    await Bun.sleep(10_000);
  }

  if (mode === "nonzero") {
    process.stderr.write(`${sentinel}\n`);

    return 9;
  }

  if (mode === "malformed") {
    process.stdout.write("not-json\n");

    return 0;
  }

  emit({ thread_id: "fake-thread", type: "thread.started" });
  emit({ type: "turn.started" });

  if (mode === "failed") {
    emit({ error: { message: sentinel }, type: "turn.failed" });

    return 0;
  }

  if (mode === "multiple-messages") {
    emit({
      item: {
        id: "commentary",
        text: "I will rewrite this now.",
        type: "agent_message",
      },
      type: "item.completed",
    });
    emit({
      item: { id: "item-1", text: output.slice(0, 8), type: "agent_message" },
      type: "item.started",
    });
    emit({
      item: { id: "item-1", text: output.slice(0, 20), type: "agent_message" },
      type: "item.updated",
    });
  }

  emit({
    item: { id: "item-1", text: output, type: "agent_message" },
    type: "item.completed",
  });
  emit({
    type: "turn.completed",
    usage: { cached_input_tokens: 3, input_tokens: 17, output_tokens: 8 },
  });

  return 0;
};

const main = async (): Promise<number> => {
  const configuration = Schema.decodeUnknownSync(ConfigurationSchema)(
    await Bun.file(path.join(path.dirname(Bun.main), "fixture.json")).json()
  );

  const args = process.argv.slice(2);
  const generation = args.includes("exec") && !args.includes("--help");
  const input = generation ? await Bun.stdin.text() : null;

  await Bun.write(
    path.join(configuration.captures, `${crypto.randomUUID()}.json`),
    JSON.stringify({
      api_keys_present: [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "OPENAI_BASE_URL",
        "AZURE_OPENAI_API_KEY",
      ].filter((key) => key in process.env),
      args,
      cwd: process.cwd(),
      generation,
      input,
      pid: process.pid,
    })
  );

  if (args.includes("--version")) {
    process.stdout.write("codex-cli 0.165.0\n");

    return 0;
  }

  if (args.includes("--help")) {
    process.stdout.write(
      configuration.capabilities
        ? "--ignore-user-config --ignore-rules --ephemeral --strict-config --json --sandbox --skip-git-repo-check --no-daemon\n"
        : "old cli\n"
    );

    return 0;
  }

  if (args.includes("features")) {
    process.stdout.write("skip_host_skill_discovery under development false\n");

    return 0;
  }

  if (args.includes("login")) {
    process.stderr.write("Harmless startup warning\n");

    const stream =
      configuration.loginStream === "stdout" ? process.stdout : process.stderr;

    stream.write(`${configuration.login}\n`);

    return 0;
  }

  return generation ? await generate(configuration, args) : 8;
};

process.exitCode = await main();
