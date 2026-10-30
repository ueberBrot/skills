import { expect, it, test } from "@effect/vitest";
import { Effect } from "effect";

import {
  answerPrompt,
  comparisonPrompt,
  decodeAnswers,
  decodeComparison,
  decodeFidelity,
  decodeScores,
  fidelityPrompt,
  scoringPrompt,
} from "../src/assessment/grading-prompts";
import { defined } from "../src/internal/json";
import { sampleRun } from "./review-fixtures";

const record = defined(sampleRun().cases[0]);
const question = "How long should I wait?";

const reference = {
  answer: "24 hours.",
  question,
  reference_answer: "Wait 24 hours before retrying.",
};

it.effect(
  "rejects omitted, substituted, duplicate, and reordered expectations",
  () =>
    Effect.gen(function* gradingContract() {
      const item = {
        checks: ["Retain 24 hours.", "Retain the retry condition."],
        fixture: record.fixture,
        spec: record.spec,
      };

      const expectations = item.checks.map((text) => ({
        evidence: "The output says to wait 24 hours before retrying.",
        passed: true,
        text,
      }));

      const encode = (values: typeof expectations) =>
        JSON.stringify({
          eval_feedback: [],
          expectations: values,
          unsupported_claims: [],
        });

      expect(yield* decodeFidelity(encode(expectations), item)).toMatchObject({
        expectations,
      });

      for (const values of [
        expectations.slice(0, 1),
        expectations.toReversed(),
        [...expectations, defined(expectations[0])],
        [
          { ...defined(expectations[0]), text: "A different requirement." },
          defined(expectations[1]),
        ],
      ]) {
        expect(
          yield* Effect.result(decodeFidelity(encode(values), item))
        ).toMatchObject({
          _tag: "Failure",
        });
      }
    })
);

it.effect(
  "requires evidence and rejects extra grading fields or fenced JSON",
  () =>
    Effect.gen(function* gradingContract() {
      const response = {
        eval_feedback: [],
        expectations: record.checks.map((text) => ({
          evidence: " ",
          passed: true,
          text,
        })),
        unsupported_claims: [],
      };

      expect(
        yield* Effect.result(decodeFidelity(JSON.stringify(response), record))
      ).toMatchObject({ _tag: "Failure" });

      for (const text of [
        JSON.stringify({ preference: "tie", reason: "Equivalent.", score: 1 }),
        '```json\n{"preference":"tie","reason":"Equivalent."}\n```',
        JSON.stringify({ preference: "A", reason: "\n" }),
      ]) {
        expect(yield* Effect.result(decodeComparison(text))).toMatchObject({
          _tag: "Failure",
        });
      }

      expect(
        yield* decodeComparison(
          JSON.stringify({
            preference: "inconclusive",
            reason: "The request does not establish the intended register.",
          })
        )
      ).toMatchObject({ preference: "inconclusive" });
    })
);

it.effect("matches every answer and score to its question position", () =>
  Effect.gen(function* gradingContract() {
    const questions = [question, "Can I retry now?"];

    const answers = questions.map((value) => ({
      answer: "No.",
      question: value,
    }));

    expect(yield* decodeAnswers(JSON.stringify(answers), questions)).toEqual(
      answers
    );
    expect(
      yield* Effect.result(
        decodeAnswers(JSON.stringify(answers.toReversed()), questions)
      )
    ).toMatchObject({ _tag: "Failure" });

    const repeated = [defined(answers[0]), defined(answers[0])];

    expect(
      yield* decodeAnswers(JSON.stringify(repeated), [question, question])
    ).toEqual(repeated);

    const score = {
      question,
      reason: "The answer retains the 24-hour wait.",
      score: "correct",
    };

    expect(yield* decodeScores(JSON.stringify([score]), [reference])).toEqual([
      score,
    ]);
    expect(
      yield* Effect.result(decodeScores(JSON.stringify([]), [reference]))
    ).toMatchObject({ _tag: "Failure" });
    expect(
      yield* Effect.result(
        decodeScores(JSON.stringify([{ ...score, score: "pass" }]), [reference])
      )
    ).toMatchObject({ _tag: "Failure" });
  })
);

test("prompts isolate output-only answers and conceal generation provenance", () => {
  const run = sampleRun();
  const current = defined(run.cases[0]);
  const output = "OUTPUT_SENTINEL";
  const answers = answerPrompt(output, [question]);

  expect(answers).toContain(output);
  expect(answers).toContain(question);
  expect(answers).not.toContain(current.fixture.source);
  expect(answers).not.toContain(reference.reference_answer);
  expect(answers).not.toContain(defined(current.checks[0]));

  for (const prompt of [
    fidelityPrompt(current, output),
    comparisonPrompt(current, "FIRST_SENTINEL", "SECOND_SENTINEL"),
  ]) {
    expect(prompt).toContain(current.fixture.source);
    expect(prompt).not.toContain(current.fixture.id);
    expect(prompt).not.toContain(
      run.manifest.requested_model ?? "missing-model"
    );
    expect(prompt).not.toContain(run.manifest.skill_name);
    expect(prompt).not.toContain("no_skill");
    expect(prompt).not.toContain("full_skill");
    expect(prompt).toContain("untrusted quoted task data");
  }

  const scoring = scoringPrompt(
    [reference],
    {
      correct: "Retain the waiting period.",
    },
    output
  );

  expect(scoring).toContain(reference.reference_answer);
  expect(scoring).toContain(reference.answer);
});
