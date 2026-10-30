import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { RunArtifactSchema, comparisonKey, sampleKey } from "../domain";
import { HarnessError } from "../errors";
import { writeJson } from "../internal/json";
import { inspectRun, loadRun } from "../runs";
import { loadJudgments } from "./judgments";
import { pairedGroups } from "./plan";

import type { Condition, JsonObject, Result, RunArtifact } from "../domain";
import type { RunView } from "../runs";
import type { ReviewInput } from "./judgments";

interface Group {
  condition: Condition;
  language: string;
  task: string;
  split: "development" | "held_out";
  expected: number;
  recorded: number;
  successful: number;
  execution_errors: number;
  evaluation_errors: number;
  missing_results: number;
  anchors_checked: number;
  anchors_passed: number;
  anchors_failed: number;
  anchors_not_applicable: number;
  fidelity_passed: number;
  fidelity_failed: number;
  fidelity_pending: number;
  preference_wins: number;
  preference_losses: number;
  preference_ties: number;
  preference_pending: number;
  preference_eligible: number;
}

type Preference = Condition | "tie" | null;

const countSuccessful = (
  row: Group,
  result: Result,
  judgment: boolean | null | undefined,
  preference: Preference | undefined,
  eligible: boolean
): void => {
  row.successful += 1;

  if (result.anchors_pass === null) {
    row.anchors_not_applicable += 1;
  } else {
    row.anchors_checked += 1;

    if (result.anchors_pass) {
      row.anchors_passed += 1;
    } else {
      row.anchors_failed += 1;
    }
  }

  if (judgment === undefined || judgment === null) {
    row.fidelity_pending += 1;
  } else if (judgment) {
    row.fidelity_passed += 1;
  } else {
    row.fidelity_failed += 1;
  }

  if (!eligible) {
    return;
  }

  row.preference_eligible += 1;

  if (preference === undefined || preference === null) {
    row.preference_pending += 1;
  } else if (preference === "tie") {
    row.preference_ties += 1;
  } else if (preference === row.condition) {
    row.preference_wins += 1;
  } else {
    row.preference_losses += 1;
  }
};

const countResult = (
  row: Group,
  result: Result | undefined,
  fidelity: ReadonlyMap<string, boolean | null>,
  preferences: ReadonlyMap<string, Preference>,
  eligible: boolean
): void => {
  row.expected += 1;

  if (result === undefined) {
    row.missing_results += 1;

    return;
  }

  row.recorded += 1;

  if (result.status === "error") {
    if (result.error_stage === "evaluation") {
      row.evaluation_errors += 1;
    } else {
      row.execution_errors += 1;
    }

    return;
  }

  const preferenceKey = comparisonKey(result.case_id, result.repetition);
  countSuccessful(
    row,
    result,
    fidelity.get(
      sampleKey(result.case_id, result.repetition, result.condition)
    ),
    preferences.get(preferenceKey),
    eligible
  );
};

const assessRun = Effect.fn("assessRun")(function* assessRun(
  view: RunView,
  review?: ReviewInput
) {
  const run = view.artifact;
  const { cases, results } = view;

  const accepted =
    review === undefined
      ? {
          assessor: null,
          comprehensionAnswered: 0,
          conditions: run.manifest.conditions,
          fidelity: new Map<string, boolean | null>(),
          inputs: [],
          preferences: new Map<string, Preference>(),
        }
      : yield* loadJudgments(view, review);

  const { fidelity, preferences, comprehensionAnswered } = accepted;
  const { complete, skipped } = pairedGroups(view, accepted.conditions);

  const pairedKeys = new Set(
    complete.map(({ record, repetition }) =>
      comparisonKey(record.fixture.id, repetition)
    )
  );

  const comprehensionPending =
    complete.reduce(
      (total, group) =>
        total +
        group.record.spec.reader_questions.length * group.results.length,
      0
    ) - comprehensionAnswered;

  const groups = new Map<string, Group>();

  for (const record of cases.values()) {
    for (const condition of run.manifest.conditions) {
      const key = JSON.stringify([
        condition,
        record.spec.language,
        record.spec.task,
        record.spec.split,
      ]);

      const row = groups.get(key) ?? {
        anchors_checked: 0,
        anchors_failed: 0,
        anchors_not_applicable: 0,
        anchors_passed: 0,
        condition,
        evaluation_errors: 0,
        execution_errors: 0,
        expected: 0,
        fidelity_failed: 0,
        fidelity_passed: 0,
        fidelity_pending: 0,
        language: record.spec.language,
        missing_results: 0,
        preference_eligible: 0,
        preference_losses: 0,
        preference_pending: 0,
        preference_ties: 0,
        preference_wins: 0,
        recorded: 0,
        split: record.spec.split,
        successful: 0,
        task: record.spec.task,
      };

      groups.set(key, row);

      for (
        let repetition = 1;
        repetition <= run.manifest.repetitions;
        repetition += 1
      ) {
        const result = results.get(
          sampleKey(record.fixture.id, repetition, condition)
        );

        countResult(
          row,
          result,
          fidelity,
          preferences,
          accepted.conditions.includes(condition) &&
            pairedKeys.has(comparisonKey(record.fixture.id, repetition))
        );
      }
    }
  }

  const judged = [...preferences.values()].filter(
    (value) => value !== null
  ).length;

  const assessment: JsonObject = {
    assessor: accepted.assessor,
    comprehension_answers_pending: comprehensionPending,
    comprehension_answers_recorded: comprehensionAnswered,
    comprehension_correctness: "not_scored",
    preference_judged_groups: judged,
    preference_pending_groups: complete.length - judged,
    tie_groups: [...preferences.values()].filter((value) => value === "tie")
      .length,
  };

  if (accepted.conditions.length !== run.manifest.conditions.length) {
    assessment.compared_conditions = [...accepted.conditions];
  }

  const summary = {
    assessment,
    expected_results:
      cases.size * run.manifest.conditions.length * run.manifest.repetitions,
    groups: [...groups.values()].map((group) => ({ ...group })),
    limitations: [
      ...run.manifest.limitations,
      "Literal-anchor passes do not establish semantic fidelity.",
      "Unassessed judgments are not failures or zero scores.",
      "Preference counts include only complete successful comparison groups.",
    ],
    mode: run.manifest.mode,
    paired_groups: complete.length,
    recorded_results: results.size,
    run_id: run.manifest.run_id,
    unpaired_groups: skipped.length,
  } satisfies JsonObject;

  return { inputs: accepted.inputs, summary };
});

export const summarize = Effect.fn("summarize")(function* summarize(
  artifact: RunArtifact,
  review?: ReviewInput
) {
  const run = yield* Schema.decodeEffect(RunArtifactSchema)(artifact, {
    onExcessProperty: "error",
  });

  const view = yield* Effect.try({
    catch: (error) => new HarnessError({ message: String(error) }),
    try: () => inspectRun(run),
  });

  return (yield* assessRun(view, review)).summary;
});

const protectInputs = Effect.fnUntraced(function* protectInputs(
  output: string,
  inputs: readonly string[]
) {
  const fs = yield* FileSystem.FileSystem;
  const outputPath = yield* fs.realPath(output);
  const outputInfo = yield* fs.stat(output);

  for (const input of inputs) {
    // stat follows raw parent traversal; realPath may normalize it first.
    const inputInfo = yield* fs.stat(input);

    const sameFile =
      Option.isSome(outputInfo.ino) && Option.isSome(inputInfo.ino)
        ? outputInfo.dev === inputInfo.dev &&
          outputInfo.ino.value === inputInfo.ino.value
        : (yield* fs.realPath(input)) === outputPath;

    if (sameFile) {
      return yield* new HarnessError({
        message: "Report output would overwrite an input artifact",
      });
    }
  }

  return yield* Effect.void;
});

export const writeReport = Effect.fn("writeReport")(
  function* writeReport(options: {
    readonly run: string;
    readonly review?: ReviewInput;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const loaded = yield* loadRun(options.run);
    const { summary, inputs } = yield* assessRun(loaded.view, options.review);
    const output = path.join(loaded.directory, "summary.json");

    if (yield* fs.exists(output)) {
      yield* protectInputs(output, [...loaded.inputs, ...inputs]);
    }

    yield* writeJson(output, summary);

    return summary;
  }
);
