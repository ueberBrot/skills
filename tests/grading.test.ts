import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "@effect/vitest";
import { CODEX_MODELS } from "@tanstack/ai-codex";
import { Effect, Schema } from "effect";

import { gradeRun } from "../src/assessment/grading";
import { JsonObjectSchema } from "../src/domain";
import { defined, readJson, writeJson } from "../src/internal/json";
import { Writer } from "../src/writers";
import { sampleRun } from "./review-fixtures";
import { run } from "./shared";

import type { GradingOptions } from "../src/assessment/grading";
import type { JsonValue } from "../src/domain";
import type { ReasoningLevel } from "@tanstack/ai";
import type { CodexModel } from "@tanstack/ai-codex";

const model = "gpt-6.1-terra" satisfies CodexModel;
const reasoning = "medium" satisfies ReasoningLevel;
const directories: string[] = [];

const PayloadSchema = Schema.Struct({
  expectations: Schema.optionalKey(Schema.Array(Schema.String)),
  items: Schema.optionalKey(
    Schema.Array(Schema.Struct({ question: Schema.String }))
  ),
  output: Schema.optionalKey(Schema.String),
  outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  questions: Schema.optionalKey(Schema.Array(Schema.String)),
});

type Payload = typeof PayloadSchema.Type;

const decodePayload = (prompt: string): Payload =>
  Schema.decodeSync(Schema.fromJsonString(PayloadSchema))(
    prompt.slice(prompt.indexOf("PAYLOAD_JSON\n") + "PAYLOAD_JSON\n".length)
  );

const scriptedResponse = (payload: Payload): JsonValue => {
  if (payload.expectations !== undefined) {
    return {
      eval_feedback: [],
      expectations: payload.expectations.map((text) => ({
        evidence: "The output retains the waiting period.",
        passed: true,
        text,
      })),
      unsupported_claims: [],
    };
  }

  if (payload.questions !== undefined) {
    return payload.questions.map((question) => ({
      answer: "24 hours.",
      question,
    }));
  }

  if (payload.items !== undefined) {
    return payload.items.map(({ question }) => ({
      question,
      reason: "The answer matches the reference waiting period.",
      score: "correct",
    }));
  }

  const outputs = defined(payload.outputs);

  const first = defined(outputs.A);

  const preference =
    first.includes("position-case") || first.includes("better") ? "A" : "B";

  return {
    preference,
    reason: "The selected output gives a clearer next step.",
  };
};

const stubWriter = (
  reply = (payload: Payload): string =>
    JSON.stringify(scriptedResponse(payload))
) => {
  const prompts: string[] = [];

  const writer = Writer.of({
    descriptor: {
      command: null,
      files: [],
      metadata: {},
      name: "scripted-codex",
    },
    execute: (request) =>
      Effect.sync(() => {
        expect(request.model).toBe(model);
        expect(request.settings).toEqual({ model_reasoning_effort: reasoning });
        prompts.push(request.prompt);

        return {
          executor_metadata: null,
          model: null,
          output: reply(decodePayload(request.prompt)),
          settings: null,
          usage: null,
        };
      }),
    validate: () => Effect.void,
  });

  return { prompts, writer };
};

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "skills-grading-"));
  directories.push(directory);
  const artifact = sampleRun();
  artifact.manifest.conditions = ["no_skill", "full_skill"];
  artifact.results = artifact.results.filter(
    (result) => result.condition !== "short_prompt"
  );

  artifact.cases = artifact.cases.map((record) => ({
    ...record,
    fixture: {
      ...record.fixture,
      source: "PRIVATE_SOURCE_SENTINEL: wait 24 hours before retrying.",
    },
  }));

  for (const result of artifact.results) {
    const marker =
      result.case_id === "first-case" ? "consistent-case" : "position-case";

    result.output = `${marker}: ${result.condition === "full_skill" ? "better" : "ordinary"}: wait 24 hours before retrying.`;
  }

  const runPath = path.join(directory, "run.json");
  const answerKeys = path.join(directory, "keys.json");

  const keys = {
    cases: Object.fromEntries(
      artifact.cases.map((record) => [
        record.fixture.id,
        {
          questions: record.spec.reader_questions.map((question) => ({
            question,
            reference_answer: "PRIVATE_KEY_SENTINEL: wait 24 hours.",
          })),
        },
      ])
    ),
    scoring: { correct: "Answer every asked part accurately." },
  };

  await run(writeJson(runPath, artifact));
  await run(writeJson(answerKeys, keys));

  const withoutKeys: GradingOptions = {
    concurrency: 2,
    model,
    out: path.join(directory, "assessment"),
    run: runPath,
    settings: { model_reasoning_effort: reasoning },
    timeout: 5,
  };

  return {
    artifact,
    directory,
    keys,
    options: { ...withoutKeys, answerKeys },
    withoutKeys,
  };
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

describe("automated grading", () => {
  test("remaps reversed comparisons and isolates output-only answers from source and keys", async () => {
    const { artifact: runArtifact, options } = await fixture();
    const { prompts, writer } = stubWriter();

    const result = await run(
      gradeRun(options).pipe(Effect.provideService(Writer, writer))
    );

    expect(result.exitCode).toBe(0);

    const artifact = Schema.decodeUnknownSync(
      Schema.Struct({
        comparisons: Schema.Array(
          Schema.Struct({ case_id: Schema.String, preference: Schema.String })
        ),
        manifest: Schema.Struct({
          kind: Schema.String,
          requested_model: Schema.String,
        }),
      })
    )(await run(readJson(path.join(options.out, "grading.json"))));

    expect(artifact.comparisons).toEqual([
      { case_id: "first-case", preference: "full_skill" },
      { case_id: "second-case", preference: "inconclusive" },
    ]);
    expect(artifact.manifest).toEqual({
      kind: "model",
      requested_model: model,
    });

    const answerPrompts = prompts.filter(
      (prompt) => decodePayload(prompt).questions !== undefined
    );

    expect(answerPrompts).toHaveLength(4);

    for (const prompt of answerPrompts) {
      const payload = Schema.decodeSync(Schema.fromJsonString(Schema.Json))(
        prompt.slice(prompt.indexOf("PAYLOAD_JSON\n") + "PAYLOAD_JSON\n".length)
      );

      expect(
        Object.keys(
          Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
            payload
          )
        ).toSorted()
      ).toEqual(["output", "questions"]);
      expect(prompt).not.toContain("PRIVATE_SOURCE_SENTINEL");
      expect(prompt).not.toContain("PRIVATE_KEY_SENTINEL");
    }

    expect(
      prompts.filter((prompt) => decodePayload(prompt).items !== undefined)
    ).toHaveLength(4);

    const callsBeforeResume = prompts.length;

    const callFiles = await readdir(path.join(options.out, "calls")).then(
      (files) => files.toSorted()
    );

    const resumed = await run(
      gradeRun({ ...options, resume: true }).pipe(
        Effect.provideService(Writer, writer)
      )
    );

    expect(resumed).toEqual(result);
    expect(prompts).toHaveLength(callsBeforeResume);
    expect(
      await readdir(path.join(options.out, "calls")).then((files) =>
        files.toSorted()
      )
    ).toEqual(callFiles);
    const manifestPath = path.join(options.out, "manifest.json");
    const manifestBeforeMismatch = await Bun.file(manifestPath).text();

    const cachedPath = path.join(options.out, "calls", defined(callFiles[0]));
    const originalCall = await Bun.file(cachedPath).text();

    const stored = Schema.decodeSync(Schema.fromJsonString(JsonObjectSchema))(
      originalCall
    );

    await run(writeJson(cachedPath, { ...stored, prompt: "Corrupted prompt" }));
    await expect(
      run(
        gradeRun({ ...options, resume: true }).pipe(
          Effect.provideService(Writer, writer)
        )
      )
    ).rejects.toThrow("Stored grading prompt differs from its hash");
    expect(await Bun.file(manifestPath).text()).toBe(manifestBeforeMismatch);
    expect(prompts).toHaveLength(callsBeforeResume);
    await Bun.write(cachedPath, originalCall);

    await Promise.all(
      [
        { ...options, model: CODEX_MODELS[0], resume: true },
        {
          ...options,
          resume: true,
          settings: { model_reasoning_effort: "high" satisfies ReasoningLevel },
        },
      ].map(async (changed) => {
        const failure = await run(
          Effect.flip(
            gradeRun(changed).pipe(Effect.provideService(Writer, writer))
          )
        );

        expect(String(failure)).toMatch(/resume|match/iu);
      })
    );
    expect(prompts).toHaveLength(callsBeforeResume);
    expect(await Bun.file(manifestPath).text()).toBe(manifestBeforeMismatch);

    defined(runArtifact.results[0]).output = "A changed generated output.";
    await run(writeJson(options.run, runArtifact));

    const changedRun = await run(
      Effect.flip(
        gradeRun({ ...options, resume: true }).pipe(
          Effect.provideService(Writer, writer)
        )
      )
    );

    expect(String(changedRun)).toMatch(/resume|match/iu);
    expect(prompts).toHaveLength(callsBeforeResume);
    expect(await Bun.file(manifestPath).text()).toBe(manifestBeforeMismatch);
    expect(
      await readdir(path.join(options.out, "calls")).then((files) =>
        files.toSorted()
      )
    ).toEqual(callFiles);
  });

  test("retains malformed raw responses as errors while valid failed checks remain advisory", async () => {
    const { options, withoutKeys } = await fixture();

    const { writer } = stubWriter((payload) => {
      if (payload.expectations !== undefined) {
        return defined(payload.output).includes("consistent-case")
          ? "{malformed"
          : JSON.stringify({
              eval_feedback: ["Check an additional meaningful source claim."],
              expectations: payload.expectations.map((text) => ({
                evidence: "A required condition was omitted.",
                passed: false,
                text,
              })),
              unsupported_claims: [],
            });
      }

      return JSON.stringify(scriptedResponse(payload));
    });

    const result = await run(
      gradeRun(withoutKeys).pipe(Effect.provideService(Writer, writer))
    );

    expect(result.exitCode).toBe(1);

    const artifact = Schema.decodeUnknownSync(
      Schema.Struct({
        calls: Schema.Array(
          Schema.Struct({
            assessment: Schema.Json,
            error: Schema.NullOr(Schema.String),
            response: Schema.NullOr(Schema.Struct({ output: Schema.String })),
            status: Schema.String,
            task: Schema.String,
          })
        ),
      })
    )(await run(readJson(path.join(options.out, "grading.json"))));

    const fidelity = artifact.calls.filter((call) => call.task === "fidelity");
    expect(fidelity.filter((call) => call.status === "error")).toHaveLength(2);
    expect(fidelity.filter((call) => call.status === "success")).toHaveLength(
      2
    );

    for (const call of fidelity.filter((item) => item.status === "error")) {
      expect(call.response?.output).toBe("{malformed");
      expect(call.assessment).toBeNull();
      expect(call.error).toContain("Invalid fidelity grading response");
    }

    const previousFiles = await readdir(path.join(options.out, "calls")).then(
      (files) => files.toSorted()
    );

    const retried = stubWriter();

    const recovered = await run(
      gradeRun({ ...withoutKeys, resume: true }).pipe(
        Effect.provideService(Writer, retried.writer)
      )
    );

    expect(recovered.exitCode).toBe(0);
    expect(retried.prompts).toHaveLength(2);

    const recoveredFiles = await readdir(path.join(options.out, "calls")).then(
      (files) => files.toSorted()
    );

    expect(recoveredFiles).toHaveLength(previousFiles.length + 2);
    expect(recoveredFiles.slice(0, previousFiles.length)).toEqual(
      previousFiles
    );

    const advisory = await fixture();

    const failedWriter = stubWriter((payload) =>
      payload.expectations === undefined
        ? JSON.stringify(scriptedResponse(payload))
        : JSON.stringify({
            eval_feedback: [],
            expectations: payload.expectations.map((text) => ({
              evidence: "The output omits the condition.",
              passed: false,
              text,
            })),
            unsupported_claims: [],
          })
    );

    const advisoryResult = await run(
      gradeRun(advisory.withoutKeys).pipe(
        Effect.provideService(Writer, failedWriter.writer)
      )
    );

    expect(advisoryResult.exitCode).toBe(0);
  });

  test("rejects mismatched private questions and existing destinations before generation", async () => {
    const { directory, keys, options, withoutKeys } = await fixture();
    const { prompts, writer } = stubWriter();
    const first = defined(Object.values(keys.cases)[0]);
    defined(first.questions[0]).question = "An unrelated private question?";
    await run(writeJson(defined(options.answerKeys), keys));

    const mismatch = await run(
      Effect.flip(gradeRun(options).pipe(Effect.provideService(Writer, writer)))
    );

    expect(String(mismatch)).toContain(
      "Answer keys do not match run questions"
    );
    expect(prompts).toHaveLength(0);
    expect(await readdir(directory)).not.toContain("assessment");
    await mkdir(options.out);
    const sentinel = path.join(options.out, "existing.json");
    await Bun.write(sentinel, "existing assessment");

    const overwrite = await run(
      Effect.flip(
        gradeRun(withoutKeys).pipe(Effect.provideService(Writer, writer))
      )
    );

    expect(String(overwrite)).toContain(
      "Refusing to overwrite grading directory"
    );
    expect(prompts).toHaveLength(0);
    expect(await Bun.file(sentinel).text()).toBe("existing assessment");
  });
});
