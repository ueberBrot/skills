# Pull requests and review comments

Use for drafting or editing PR descriptions and code review comments. These are editorial conventions, not a mandatory PR template.

## PR descriptions

Lead with the concrete problem and resulting behavior. A trigger and before/after example can help explain a behavioral change. Keep supplied rationale and compatibility constraints that reviewers need; avoid replacing them with a list of files or generic claims about quality.

When drafting from code, read the relevant diff and enough surrounding code to support the explanation. When editing an existing description, preserve its claims and distinguish any separately requested verification. Do not infer successful checks, production outcomes, or performance improvements from the implementation alone.

Report validation at its actual scope: what was checked, where, and the observed result. A local reproduction, a passing unit test, and a completed CI run support different claims. Preserve checks known to be pending, failed, or not run, along with supplied reasons. If validation is unknown, do not relabel it as either passed or not run; mention the gap when it matters to the requested description.

Follow the repository template when supplied. Otherwise use enough structure for the change: a small PR may need two sentences and a validation note. Include relevant risks, rollout constraints, or open decisions when supported. Do not manufacture sections, fixed bullet counts, or a closing summary.

## Review comments

Make the concern, its consequence, and the requested action understandable from the supplied evidence. Preserve a concrete trigger, code location, or example when given. Keep a suspected problem or question uncertain; do not turn it into a confirmed defect.

Preserve the writer's intent and urgency. A required fix should remain required; a suggestion or stylistic preference should remain optional. Use the team's blocker, suggestion, or nit labels when helpful or requested, without assigning severity the source does not support. Keep disagreement specific to the code and retain appropriate courtesy.

## Example: validation scope

Input:

> This PR makes an improvement to job locking by holding the lock until the transaction commits, so another worker cannot pick up the pending job in that window. I reproduced the race locally before the change and could not reproduce it afterward. CI is still running.

Possible edit:

> Hold the job lock until the transaction commits so another worker cannot pick up the pending job in that window. I reproduced the race locally before the change and could not reproduce it afterward. CI is still running.

The local observation does not become proof that the race is impossible in every environment or that CI passed.
