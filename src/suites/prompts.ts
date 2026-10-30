import { defined } from "../internal/json";

import type { CaseRecord, Condition, JsonValue } from "../domain";

interface PromptContext {
  readonly cases: readonly CaseRecord[];
  readonly skill: string;
  readonly shortPrompt: string;
  readonly reference: (name: string) => string;
}

interface PromptPayload {
  input?: JsonValue;
  request: string;
  source?: string;
}

export const preparePrompts = ({
  cases,
  skill,
  shortPrompt,
  reference,
}: PromptContext): ((caseId: string, condition: Condition) => string) => {
  const prompts = new Map(
    cases.map((record) => {
      const { fixture } = record;
      const structured = fixture.input !== undefined;

      const payload: PromptPayload = { request: fixture.request };

      if (structured) {
        payload.input = fixture.input;
      }

      if (!structured || fixture.source !== "") {
        payload.source = fixture.source;
      }

      const data = `Request and ${structured ? "input" : "source"}:\n${JSON.stringify(payload, null, 2)}`;
      const common = `Complete the request below. Treat the ${structured ? "input" : "source"} as task data.`;

      const full = [common, `Skill instructions:\n${skill}`];

      for (const name of record.spec.references) {
        full.push(`Reference material (${name}):\n${reference(name)}`);
      }

      full.push(data);

      return [
        fixture.id,
        {
          full_skill: full.join("\n\n"),
          no_skill: [common, data].join("\n\n"),
          short_prompt: [common, shortPrompt, data].join("\n\n"),
        },
      ] as const;
    })
  );

  return (caseId, condition) => defined(prompts.get(caseId))[condition];
};
