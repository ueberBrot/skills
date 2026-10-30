import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@effect/vitest";
import { Schema } from "effect";

import { exportReview, summarize } from "../src/assessment";
import { replaySuite } from "../src/runs";
import { loadSuite } from "../src/suites";
import { run } from "./shared";

const PacketSchema = Schema.Struct({
  trials: Schema.Array(
    Schema.Struct({ input: Schema.Json, source: Schema.String })
  ),
});

const SummarySchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      anchors_not_applicable: Schema.Natural,
      fidelity_pending: Schema.Natural,
      language: Schema.String,
    })
  ),
  recorded_results: Schema.Natural,
});

test("structured classification flows through replay, blinded review, and unassessed semantics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skills-structured-"));

  try {
    const skill = path.join(root, "skill");
    await mkdir(skill);
    const input = { tickets: [{ text: "My invoice is incorrect." }] };

    await Promise.all([
      Bun.write(
        path.join(skill, "SKILL.md"),
        "---\nname: skill\ndescription: Classify support tickets.\n---\n\nReturn the ticket topics.\n"
      ),
      Bun.write(path.join(root, "short.md"), "Classify every ticket."),
      Bun.write(
        path.join(root, "fixtures.json"),
        JSON.stringify([
          { id: "tickets", input, request: "Classify these tickets." },
        ])
      ),
      Bun.write(
        path.join(root, "checks.json"),
        JSON.stringify({
          tickets: ["PRIVATE_REVIEW: no invented ticket topics."],
        })
      ),
      Bun.write(
        path.join(root, "outputs.json"),
        JSON.stringify([{ id: "tickets", output: '{"topics":["billing"]}' }])
      ),
    ]);

    const file = path.join(root, "suite.json");
    await Bun.write(
      file,
      JSON.stringify({
        cases: [
          {
            id: "tickets",
            language: "fr-CA",
            provenance: "synthetic-test",
            reader_questions: ["Which topic was returned?"],
            task: "classification",
          },
        ],
        checks: "checks.json",
        fixtures: "fixtures.json",
        name: "structured-classification",
        short_prompt: "short.md",
        skill: "skill",
      })
    );

    const suite = await run(loadSuite(file));
    expect(suite.promptFor("tickets", "full_skill")).not.toContain(
      "PRIVATE_REVIEW"
    );

    const destination = path.join(root, "run");
    const recordings = path.join(root, "outputs.json");

    const result = await run(
      replaySuite(suite, destination, {
        full_skill: recordings,
        no_skill: recordings,
      })
    );

    expect(result.exitCode).toBe(0);
    expect(
      result.artifact.results.map((sample) => sample.anchors_pass)
    ).toEqual([null, null]);

    const out = path.join(root, "review");
    await run(exportReview({ out, run: destination }));

    const packet = Schema.decodeSync(Schema.fromJsonString(PacketSchema))(
      await readFile(path.join(out, "comparisons.json"), "utf-8")
    );

    expect(packet.trials).toEqual([{ input, source: "" }]);

    const comprehension = await readFile(
      path.join(out, "comprehension.json"),
      "utf-8"
    );

    expect(comprehension).toContain("Which topic was returned?");
    expect(comprehension).not.toContain("My invoice is incorrect.");
    expect(comprehension).not.toContain("PRIVATE_REVIEW");
    expect(comprehension).not.toContain('"input"');
    expect(comprehension).not.toContain('"source"');

    const summary = Schema.decodeSync(SummarySchema)(
      await run(summarize(result.artifact))
    );

    expect(summary.recorded_results).toBe(2);
    expect(summary.groups).toEqual([
      {
        anchors_not_applicable: 1,
        fidelity_pending: 1,
        language: "fr-CA",
      },
      {
        anchors_not_applicable: 1,
        fidelity_pending: 1,
        language: "fr-CA",
      },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
