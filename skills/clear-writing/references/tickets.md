# Tickets

Use for descriptions, bug reports, tasks, and acceptance criteria. These are editorial and engineering conventions, not experimentally validated ticket templates.

## Decisions

Match the team's existing template when available in the task context. An edit to one sentence stays an edit to one sentence. Create only sections the reader needs; a small task may need a paragraph and a checklist.

For a bug, make the symptom searchable. Distinguish observed behavior, expected behavior, reproduction conditions, and suspected cause. Keep exact error text and relevant versions. A title should not assert an unverified diagnosis.

For planned work, state the problem and intended outcome. Carry over supplied implementation constraints, scope, and testable acceptance conditions. Do not turn a wording task into requirements design. Proposed new criteria must be identified as proposals, not silently added to the ticket.

For acceptance criteria, preserve the logical contract: actor, trigger, result, limits, exceptions, and timing. Keep `and` versus `or`, inclusive versus exclusive limits, and the difference between retrying automatically and offering a retry. Gherkin is useful when the team uses it; it is not compulsory.

Completion means a reader can identify what was observed or requested, the boundaries of the work, and how existing acceptance conditions decide completion. Where the source lacks one of these, leave the gap visible without inventing content or filling the ticket with empty sections.

## Example: symptom and uncertainty

Input:

> It has come to our attention that in version 4.2, when users double-click Save, two invoices can sometimes be created. We suspect the retry handler, but this has not been confirmed. Only the web client is affected.

Possible edit:

> In version 4.2, double-clicking Save can create two invoices in the web client. Other clients are not affected. The retry handler is a suspected cause; this is unconfirmed.

The version, intermittent behavior, affected client, and uncertainty all survive. If “only” is merely an assumption rather than an observation in the surrounding context, preserve that qualification too.

## Example: acceptance condition

Input:

> It is essential that users are not permitted to submit the form unless both the email address has been verified and the terms have been accepted.

Possible edit:

> Users can submit the form only if the email address has been verified and the terms have been accepted.

Keep both prerequisites and the verified/accepted states. Replacing “and” with “or” changes the requirement. Do not assign these actions to the user when the source leaves the actor unspecified.
