import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ComprehensionPacketSchema,
  DecodingSchema,
  exportReview,
  summarize,
  JudgmentsSchema,
} from "../src/assessment";
import { CONDITIONS } from "../src/domain";
import {
  canonicalJson,
  defined,
  readJson,
  sha256,
  writeJson,
} from "../src/internal/json";
import { sampleRun } from "./review-fixtures";
import { run as runEffect } from "./shared.ts";

import type {
  ComprehensionPacket,
  Decoding,
  Judgments,
} from "../src/assessment";
import type { JsonObject } from "../src/domain";
import type { ReasoningLevel } from "@tanstack/ai";
import type { CodexModel } from "@tanstack/ai-codex";

const SummarySchema = Schema.Struct({
  assessment: Schema.Struct({
    assessor: Schema.NullOr(Schema.Json),
    comprehension_answers_pending: Schema.Natural,
    comprehension_answers_recorded: Schema.Natural,
    comprehension_correctness: Schema.Literal("not_scored"),
    preference_judged_groups: Schema.Natural,
    preference_pending_groups: Schema.Natural,
    tie_groups: Schema.Natural,
  }),
  expected_results: Schema.Natural,
  groups: Schema.Array(
    Schema.Struct({
      anchors_checked: Schema.Natural,
      anchors_failed: Schema.Natural,
      anchors_not_applicable: Schema.Natural,
      anchors_passed: Schema.Natural,
      condition: Schema.Literals(CONDITIONS),
      evaluation_errors: Schema.Natural,
      execution_errors: Schema.Natural,
      expected: Schema.Natural,
      fidelity_failed: Schema.Natural,
      fidelity_passed: Schema.Natural,
      fidelity_pending: Schema.Natural,
      language: Schema.Literals(["en", "de"]),
      missing_results: Schema.Natural,
      preference_eligible: Schema.Natural,
      preference_losses: Schema.Natural,
      preference_pending: Schema.Natural,
      preference_ties: Schema.Natural,
      preference_wins: Schema.Natural,
      recorded: Schema.Natural,
      split: Schema.Literals(["development", "held_out"]),
      successful: Schema.Natural,
      task: Schema.String,
    })
  ),
  paired_groups: Schema.Natural,
  recorded_results: Schema.Natural,
  unpaired_groups: Schema.Natural,
});

type Summary = typeof SummarySchema.Type;

type Count = Exclude<
  keyof Summary["groups"][number],
  "condition" | "language" | "task" | "split"
>;

const total = (summary: Summary, field: Count) =>
  summary.groups.reduce((sum, group) => sum + group[field], 0);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

const packet = async (run = sampleRun(), seed = 8) => {
  const root = await mkdtemp(path.join(tmpdir(), "skills-review-"));
  tempDirs.push(root);
  const publicDir = path.join(root, "packet");
  const decodingPath = path.join(root, "packet-decoding.json");
  const runPath = path.join(root, "run.json");
  await runEffect(writeJson(runPath, run));
  await runEffect(exportReview({ out: publicDir, run: runPath, seed }));

  return {
    comprehension: Schema.decodeUnknownSync(ComprehensionPacketSchema)(
      await runEffect(readJson(path.join(publicDir, "comprehension.json")))
    ),
    decoding: Schema.decodeUnknownSync(DecodingSchema)(
      await runEffect(readJson(decodingPath))
    ),
    decodingPath,
    judgments: Schema.decodeUnknownSync(JudgmentsSchema)(
      await runEffect(readJson(path.join(publicDir, "judgments.json")))
    ),
    publicDir,
    root,
    run,
    runPath,
  };
};

describe("anonymous assessment", () => {
  test("canonical hashes ignore nested object key order and preserve array order", () => {
    const first = Schema.decodeSync(Schema.fromJsonString(Schema.Json))(
      '[{"z":2,"a":{"d":[null,false,3,"Grüße"],"c":1}}]'
    );

    const reordered = [{ a: { c: 1, d: [null, false, 3, "Grüße"] }, z: 2 }];

    expect(canonicalJson(first)).toBe(
      '[{"a":{"c":1,"d":[null,false,3,"Grüße"]},"z":2}]'
    );
    expect(sha256(canonicalJson(first))).toBe(sha256(canonicalJson(reordered)));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("keeps execution identities private and gives answerability sessions only outputs", async () => {
    const { publicDir, decoding, run, comprehension } = await packet();
    expect(decoding.run_id).toBe(run.manifest.run_id);
    const files = await readdir(publicDir);
    expect(files.toSorted()).toEqual([
      "comparisons.json",
      "comprehension.json",
      "judgments.json",
    ]);

    const contents = await Promise.all(
      files.map(
        async (name) => await Bun.file(path.join(publicDir, name)).text()
      )
    );

    const text = contents.join("\n");

    for (const identity of [
      "private-run-identity",
      "private-suite-identity",
      "private-model-identity",
      "private-skill-name",
      "private-skill-version",
      "private-file-identity",
      "first-case",
      "second-case",
      ...CONDITIONS,
    ]) {
      expect(text).not.toContain(identity);
    }

    expect(Object.keys(comprehension).toSorted()).toEqual([
      "items",
      "review_id",
    ]);
    expect(comprehension.items).toHaveLength(6);

    for (const item of comprehension.items) {
      expect(Object.keys(item).toSorted()).toEqual([
        "item_id",
        "output",
        "questions",
      ]);
      expect(item.questions).toEqual([
        { answer: null, question: "How long should the reader wait?" },
      ]);
      expect(item.output).toContain("Grüße —");
    }
  });

  test("reproduces public packets with the same run and seed", async () => {
    const { root, runPath, publicDir } = await packet();
    const second = path.join(root, "second");
    await runEffect(exportReview({ out: second, run: runPath, seed: 8 }));

    await Promise.all(
      ["comparisons.json", "judgments.json", "comprehension.json"].map(
        async (name) => {
          const [original, repeated] = await Promise.all([
            Bun.file(path.join(publicDir, name)).bytes(),
            Bun.file(path.join(second, name)).bytes(),
          ]);

          expect(original).toEqual(repeated);
        }
      )
    );
  });

  test("refuses public-directory and private-decoder overwrites", async () => {
    const { root, runPath, publicDir, decodingPath } = await packet();
    const before = await Bun.file(decodingPath).bytes();
    expect(
      String(
        await runEffect(
          Effect.flip(exportReview({ out: publicDir, run: runPath, seed: 8 }))
        )
      )
    ).toContain("already exists");
    expect(await Bun.file(decodingPath).bytes()).toEqual(before);
    await Bun.write(
      path.join(root, "different-decoding.json"),
      "existing private data"
    );
    expect(
      String(
        await runEffect(
          Effect.flip(
            exportReview({
              out: path.join(root, "different"),
              run: runPath,
              seed: 8,
            })
          )
        )
      )
    ).toContain("already exists");
    expect(await readdir(root)).not.toContain("different");
  });

  test("shows failed and missing groups without counting ties", async () => {
    const run = sampleRun();
    run.results.pop();
    run.manifest.completed_at = null;
    run.results[0] = {
      ...defined(run.results[0]),
      anchors_pass: null,
      error: "executor failed",
      error_stage: "execution",
      missing_anchors: [],
      output: null,
      status: "error",
    };

    const summary = Schema.decodeUnknownSync(SummarySchema)(
      await runEffect(summarize(run))
    );

    expect(summary.paired_groups).toBe(0);
    expect(summary.unpaired_groups).toBe(2);
    expect(summary.recorded_results).toBe(5);
    expect(summary.assessment.tie_groups).toBe(0);
    expect(summary.assessment.preference_pending_groups).toBe(0);
    expect(total(summary, "execution_errors")).toBe(1);
    expect(total(summary, "missing_results")).toBe(1);

    const directory = await mkdtemp(
      path.join(tmpdir(), "skills-empty-review-")
    );

    tempDirs.push(directory);
    const runPath = path.join(directory, "run.json");
    await runEffect(writeJson(runPath, run));
    expect(
      String(
        await runEffect(
          Effect.flip(
            exportReview({
              out: path.join(directory, "packet"),
              run: runPath,
              seed: 8,
            })
          )
        )
      )
    ).toContain("No complete");
  });

  test("exports complete groups and records skipped cases privately", async () => {
    const run = sampleRun();
    run.results.pop();
    run.manifest.completed_at = null;
    const { publicDir, decoding } = await packet(run);

    const comparisons = Schema.decodeUnknownSync(
      Schema.Struct({
        trials: Schema.Array(Schema.Struct({ trial_id: Schema.String })),
      })
    )(await runEffect(readJson(path.join(publicDir, "comparisons.json"))));

    expect(comparisons.trials).toHaveLength(1);
    expect(decoding.skipped).toEqual([
      {
        case_id: "second-case",
        reason: "missing_or_failed_condition",
        repetition: 1,
      },
    ]);
    expect(
      Schema.decodeUnknownSync(SummarySchema)(await runEffect(summarize(run)))
        .paired_groups
    ).toBe(1);
  });

  test("keeps mechanical anchors separate from assessed fidelity and groups by task and split", async () => {
    const run = sampleRun();
    defined(run.results[0]).anchors_pass = false;
    defined(run.results[0]).missing_anchors = ["24 hours"];
    defined(run.results[1]).anchors_pass = null;
    const record = defined(run.cases[1]);

    run.cases[1] = {
      ...record,
      spec: { ...record.spec, split: "held_out", task: "proposal" },
    };

    for (const result of run.results.filter(
      (candidate) => candidate.case_id === "second-case"
    )) {
      result.task = "proposal";
      result.split = "held_out";
    }

    const summary = Schema.decodeUnknownSync(SummarySchema)(
      await runEffect(summarize(run))
    );

    expect(total(summary, "anchors_passed")).toBe(4);
    expect(total(summary, "anchors_failed")).toBe(1);
    expect(total(summary, "anchors_not_applicable")).toBe(1);
    expect(total(summary, "fidelity_pending")).toBe(6);
    expect(total(summary, "fidelity_passed")).toBe(0);
    expect(new Set(summary.groups.map((group) => group.language))).toEqual(
      new Set(["en", "de"])
    );
    expect(new Set(summary.groups.map((group) => group.condition))).toEqual(
      new Set(CONDITIONS)
    );
    expect(new Set(summary.groups.map((group) => group.task))).toEqual(
      new Set(["email", "proposal"])
    );
    expect(new Set(summary.groups.map((group) => group.split))).toEqual(
      new Set(["development", "held_out"])
    );
  });

  test("keeps comprehension pending when only the source-aware judgments arrive", async () => {
    const { publicDir, decodingPath, run } = await packet();
    await Bun.file(path.join(publicDir, "comprehension.json")).delete();

    const summary = Schema.decodeUnknownSync(SummarySchema)(
      await runEffect(
        summarize(run, {
          decoding: decodingPath,
          path: path.join(publicDir, "judgments.json"),
        })
      )
    );

    expect(summary.assessment).toMatchObject({
      assessor: null,
      comprehension_answers_pending: 6,
      comprehension_answers_recorded: 0,
      comprehension_correctness: "not_scored",
    });
    expect(total(summary, "fidelity_pending")).toBe(6);
  });

  test("preserves model provenance and answers without treating completion as correctness", async () => {
    const { publicDir, decodingPath, run, judgments, comprehension } =
      await packet();

    judgments.assessor = {
      executor_name: "codex",
      kind: "model",
      reported_model: null,
      reported_settings: null,
      requested_model: "gpt-6.1-terra" satisfies CodexModel,
      requested_settings: {
        model_reasoning_effort: "medium" satisfies ReasoningLevel,
      },
    };

    const first = defined(judgments.trials[0]);
    first.fidelity.A = { passed: true, reason: "Preserves the condition." };
    first.fidelity.B = { passed: false, reason: "The condition is unclear." };
    first.preference = "A";
    first.preference_reason = "Easier to read.";
    defined(judgments.trials[1]).preference = "tie";
    defined(judgments.trials[1]).preference_reason = "Equally useful.";
    defined(defined(comprehension.items[0]).questions[0]).answer = "24 hours.";
    await runEffect(
      writeJson(path.join(publicDir, "judgments.json"), judgments)
    );
    await runEffect(
      writeJson(path.join(publicDir, "comprehension.json"), comprehension)
    );

    const summary = Schema.decodeUnknownSync(SummarySchema)(
      await runEffect(
        summarize(run, {
          decoding: decodingPath,
          path: path.join(publicDir, "judgments.json"),
        })
      )
    );

    expect(total(summary, "fidelity_passed")).toBe(1);
    expect(total(summary, "fidelity_failed")).toBe(1);
    expect(total(summary, "fidelity_pending")).toBe(4);
    expect(total(summary, "preference_wins")).toBe(1);
    expect(total(summary, "preference_losses")).toBe(2);
    expect(total(summary, "preference_ties")).toBe(3);
    expect(total(summary, "preference_eligible")).toBe(6);
    expect(summary.assessment).toEqual({
      assessor: judgments.assessor,
      comprehension_answers_pending: 5,
      comprehension_answers_recorded: 1,
      comprehension_correctness: "not_scored",
      preference_judged_groups: 2,
      preference_pending_groups: 0,
      tie_groups: 1,
    });
  });

  const reviewMutations: [string, (form: Judgments) => void][] = [
    [
      "missing trial",
      (form) => {
        form.trials.pop();
      },
    ],
    [
      "duplicate trial",
      (form) => {
        form.trials.push(defined(form.trials[0]));
      },
    ],
    [
      "unknown trial",
      (form) => {
        defined(form.trials[0]).trial_id = "UNKNOWN";
      },
    ],
    [
      "missing label",
      (form) => {
        delete defined(form.trials[0]).fidelity.A;
      },
    ],
    [
      "extra label",
      (form) => {
        defined(form.trials[0]).fidelity.D = { passed: null, reason: "" };
      },
    ],
    [
      "unknown preference",
      (form) => {
        defined(form.trials[0]).preference = "D";
      },
    ],
    [
      "fidelity without reason",
      (form) => {
        defined(defined(form.trials[0]).fidelity.A).passed = true;
      },
    ],
    [
      "preference without reason",
      (form) => {
        defined(form.trials[0]).preference = "tie";
      },
    ],
  ];

  test.each(reviewMutations)("rejects %s", async (_name, mutate) => {
    const { run, publicDir, decodingPath, judgments } = await packet();
    mutate(judgments);
    await runEffect(
      writeJson(path.join(publicDir, "judgments.json"), judgments)
    );

    const failure = await runEffect(
      Effect.flip(summarize(run, { decoding: decodingPath, path: publicDir }))
    );

    expect(String(failure).length).toBeGreaterThan(0);
    expect(failure.message.startsWith("Error:")).toBe(false);
  });

  const comprehensionMutations: [
    string,
    (form: ComprehensionPacket) => JsonObject,
  ][] = [
    [
      "source injection",
      (form) => ({
        ...form,
        items: [
          { ...defined(form.items[0]), source: "Not allowed" },
          ...form.items.slice(1),
        ],
      }),
    ],
    [
      "missing reader item",
      (form) => {
        form.items.pop();

        return form;
      },
    ],
    [
      "duplicate reader item",
      (form) => {
        form.items.push(defined(form.items[0]));

        return form;
      },
    ],
    [
      "unknown reader item",
      (form) => {
        defined(form.items[0]).item_id = "UNKNOWN";

        return form;
      },
    ],
    [
      "changed question",
      (form) => {
        defined(defined(form.items[0]).questions[0]).question =
          "Different question";

        return form;
      },
    ],
    [
      "changed output",
      (form) => {
        defined(form.items[0]).output = "Different output";

        return form;
      },
    ],
    [
      "wrong reader review",
      (form) => {
        form.review_id = "different-review";

        return form;
      },
    ],
  ];

  test.each(comprehensionMutations)("rejects %s", async (_name, mutate) => {
    const { run, publicDir, decodingPath, comprehension } = await packet();
    await runEffect(
      writeJson(
        path.join(publicDir, "comprehension.json"),
        mutate(comprehension)
      )
    );

    const failure = await runEffect(
      Effect.flip(summarize(run, { decoding: decodingPath, path: publicDir }))
    );

    expect(String(failure).length).toBeGreaterThan(0);
  });

  const decodingMutations: [string, (form: Decoding) => void][] = [
    [
      "swapped labels",
      (form) => {
        const { labels } = defined(form.trials[0]);
        [labels.A, labels.B] = [defined(labels.B), defined(labels.A)];
      },
    ],
    [
      "missing mapping",
      (form) => {
        form.trials.pop();
      },
    ],
    [
      "altered reader mapping",
      (form) => {
        defined(form.comprehension[0]).label = "B";
      },
    ],
    [
      "altered skipped groups",
      (form) => {
        form.skipped.push({
          case_id: "first-case",
          reason: "missing_or_failed_condition",
          repetition: 1,
        });
      },
    ],
  ];

  test.each(decodingMutations)(
    "rejects private decoding with %s",
    async (_name, mutate) => {
      const { run, publicDir, decodingPath, decoding } = await packet();
      mutate(decoding);
      await runEffect(writeJson(decodingPath, decoding));
      expect(
        String(
          await runEffect(
            Effect.flip(
              summarize(run, { decoding: decodingPath, path: publicDir })
            )
          )
        )
      ).toContain("mapping was altered");
    }
  );

  test("binds decoder to the exact run and seed", async () => {
    const { root, run, runPath, publicDir, decodingPath } = await packet();
    await runEffect(
      exportReview({ out: path.join(root, "second"), run: runPath, seed: 9 })
    );
    expect(
      String(
        await runEffect(
          Effect.flip(
            summarize(run, {
              decoding: path.join(root, "second-decoding.json"),
              path: publicDir,
            })
          )
        )
      )
    ).toContain("review IDs");
    const changed = structuredClone(run);
    changed.manifest.run_id = "a-different-run";
    expect(
      String(
        await runEffect(
          Effect.flip(
            summarize(changed, { decoding: decodingPath, path: publicDir })
          )
        )
      )
    ).toContain("does not match");
    const changedOutput = structuredClone(run);
    defined(changedOutput.results[0]).output = "Changed prose";
    expect(
      String(
        await runEffect(
          Effect.flip(
            summarize(changedOutput, {
              decoding: decodingPath,
              path: publicDir,
            })
          )
        )
      )
    ).toContain("does not match");
  });

  test("rejects duplicate results before they inflate counts", async () => {
    const run = sampleRun();
    run.results.push(defined(run.results[0]));
    expect(String(await runEffect(Effect.flip(summarize(run))))).toContain(
      "Duplicate case/condition"
    );
  });

  test.each([
    { anchors_pass: null, error_stage: null },
    { anchors_pass: true, error_stage: "execution" as const },
  ])("rejects an inconsistent failed result %o", async (patch) => {
    const artifact = sampleRun();
    artifact.results[0] = {
      ...defined(artifact.results[0]),
      ...patch,
      error: "executor failed",
      missing_anchors: [],
      output: null,
      status: "error",
    };

    expect(String(await runEffect(Effect.flip(summarize(artifact))))).toContain(
      "Failed result must identify its error"
    );
  });

  test("leaves single-condition successes ineligible for preferences", async () => {
    const run = sampleRun();
    run.manifest.conditions = ["full_skill"];
    run.results = run.results.filter(
      (result) => result.condition === "full_skill"
    );

    const summary = Schema.decodeUnknownSync(SummarySchema)(
      await runEffect(summarize(run))
    );

    expect(summary.paired_groups).toBe(0);
    expect(summary.unpaired_groups).toBe(2);
    expect(total(summary, "successful")).toBe(2);
    expect(total(summary, "preference_eligible")).toBe(0);
    expect(total(summary, "fidelity_pending")).toBe(2);
  });
});
