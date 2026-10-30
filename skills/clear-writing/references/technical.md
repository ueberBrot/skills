# Technical prose

## Documentation and procedures

Identify whether the passage explains a concept, describes a contract, or guides an action. Match the surrounding document's organization. Explain a prerequisite before the step that needs it. Retain distinctions such as omitted versus null, retry versus re-execution, and authentication versus authorization.

For an unfamiliar concept, first identify what the reader needs to understand. A short explanation tied to the actual system can help more than replacing a technical term with a vague synonym [R2 in evidence.md]. For an expert audience, keep established terms and skip remedial explanations.

For a procedure, preserve action order, prerequisites, expected results, and supplied recovery instructions. A documentation edit does not authorize running operational commands or making the described system changes.

Put a condition before the action it governs when the reader needs it to decide whether to act. Give independently executable actions separate steps when that makes the sequence easier to follow. Keep actions that must occur together connected, and distinguish a step's explanation from an additional instruction. Put an existing warning before the affected action, preserving the prohibited action and its consequence. Retain any required warning format.

Use direct instructions when the reader is the intended actor. Identify the object, location, or responsible role from the source when a step depends on it; do not invent a service name, host, command, or owner to fill a gap. If missing information makes the procedure unusable, identify the gap. Short sentences are useful when they reduce dependencies, but splitting must preserve conditions, timing, and concurrency.

Describe current behavior in reference documentation. Historical rationale remains useful in migration guides, changelogs, decisions, and explanations of compatibility constraints. Retain history when it explains a present constraint; do not remove it solely because it refers to an older version.

Preserve existing source links and uncertainty. Check the implementation when the task asks to verify behavior or when an edit depends on interpreting it. Otherwise report a material inconsistency without silently choosing a new contract.

Example:

> In order to prevent duplicate processing, the client must utilize the same `Idempotency-Key` for retries of the same request. Keys expire after 24 hours.

Possible edit:

> To prevent duplicate processing, reuse the same `Idempotency-Key` when retrying a request. Keys expire after 24 hours.

“Each retry needs a new key” is an error. For readers unfamiliar with idempotency, explain the duplicate-processing consequence using the supplied facts; do not promise behavior after expiry that the source does not specify.

## Code comments and docstrings

Read the nearby code before changing a comment. Edit only the requested prose. Keep runtime code, identifiers, literal values, examples, directives, and machine-readable documentation syntax intact. Preserve formatter/linter directives, license notices, generated markers, and annotations. A docstring can also be runtime data or a doctest: treat executable examples as code.

Useful comments explain a reason, invariant, boundary, surprising behavior, or external constraint. Short implementation descriptions can still help when an algorithm is hard to follow. Remove a redundant restatement only if it adds no useful context. Keep links or ticket keys when they explain a live constraint rather than banning them by shape.

Example:

```python
# We deliberately do not retry here because charging the card twice is possible.
charge(card)
```

Possible edit:

```python
# Do not retry here: a retry could charge the card twice.
charge(card)
```

The negative instruction and possible consequence matter more than brevity. Keep `charge(card)` unchanged.

Finish by checking the diff is limited to intended comment or docstring prose and that it still agrees with the code. Use a language-aware token, AST, or parser comparison when practical to verify executable content stayed unchanged. For edited doctests or generated documentation, run the relevant existing check when the change could affect execution or rendering. Do not run a whole test suite for an ordinary comment edit.

For snippets without file access, return the revised snippet and preserve the executable lines. If the source code and the prose contradict one another, flag the conflict rather than modifying runtime behavior as part of editing.
