import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { makeGrader } from "../src/assessment/grading-call";
import { JsonObjectSchema } from "../src/domain";
import { HarnessError } from "../src/errors";
import { readJson, writeJson } from "../src/internal/json";
import { Writer } from "../src/writers";
import { run } from "./shared";

import type { CallIdentity } from "../src/assessment/grading-call";
import type { ReasoningLevel } from "@tanstack/ai";
import type { CodexModel } from "@tanstack/ai-codex";

const directories: string[] = [];

const identity: CallIdentity = {
  case_id: "case-one",
  conditions: ["full_skill"],
  repetition: 1,
  task: "fidelity",
};

const decode = (text: string) =>
  Schema.decodeEffect(
    Schema.fromJsonString(Schema.Struct({ value: Schema.String }))
  )(text, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new HarnessError({ message: "Invalid assessment" }))
  );

const fixture = async () => {
  const out = await mkdtemp(path.join(tmpdir(), "skills-grading-cache-"));
  directories.push(out);
  await mkdir(path.join(out, "calls"));
  let generated = 0;

  const writer = Writer.of({
    descriptor: { command: null, files: [], metadata: {}, name: "scripted" },
    execute: () =>
      Effect.sync(() => {
        generated += 1;

        return {
          executor_metadata: null,
          model: null,
          output: JSON.stringify({ value: String(generated) }),
          settings: null,
          usage: null,
        };
      }),
    validate: () => Effect.void,
  });

  const options = {
    model: "gpt-6.1-terra" satisfies CodexModel,
    out,
    settings: {
      model_reasoning_effort: "medium" satisfies ReasoningLevel,
    },
    timeout: 5,
  };

  const prepare = async (resume: boolean) =>
    await run(
      makeGrader({ ...options, resume }).pipe(
        Effect.provideService(Writer, writer)
      )
    );

  const grader = await prepare(false);
  await run(grader.execute(identity, "Original prompt", decode));

  return {
    file: path.join(out, "calls", "0001.json"),
    generated: () => generated,
    out,
    prepare,
  };
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

test("resume rejects corrupted hashes, mismatched filenames, and duplicate IDs", async () => {
  const current = await fixture();

  const stored = Schema.decodeUnknownSync(JsonObjectSchema)(
    await run(readJson(current.file))
  );

  await run(writeJson(current.file, { ...stored, prompt: "Changed secretly" }));
  await expect(current.prepare(true)).rejects.toThrow();

  await run(writeJson(current.file, { ...stored, id: 2 }));
  await expect(current.prepare(true)).rejects.toThrow();

  await run(writeJson(current.file, stored));
  await run(writeJson(path.join(current.out, "calls", "1.json"), stored));
  await expect(current.prepare(true)).rejects.toThrow();
  expect(current.generated()).toBe(1);
});
