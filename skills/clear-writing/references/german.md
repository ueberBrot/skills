# German workplace writing

Read alongside the relevant medium reference. These are editorial choices for German workplace prose, not a universal German house style.

## Register and terminology

Preserve the relationship expressed by `du`, `ihr`, or `Sie`, and keep the speaker's `ich` or `wir`. Match supplied samples and the team's spelling conventions. A request for clearer wording does not authorize a different relationship, new personal opinions, or a more casual personality.

Keep technical terms familiar to the intended reader. `PR`, `Backfill`, `Staging`, `deployen`, or `das Go von Ops` can be natural in an internal developer conversation. Do not translate every English term or expand every abbreviation. For a reader unfamiliar with a term, use an accurate equivalent or a short explanation supported by the source. A client can also be a technical expert; use the stated audience rather than treating every external message as nontechnical.

Keep short Slack messages conversational and professional client emails appropriately courteous. A greeting, thanks, or a phrasing such as “Könnten Sie …?” can serve the relationship. Remove empty setup only when it adds nothing. Do not introduce slang, emojis, stiff business phrasing, or English sentence patterns merely to create a different voice.

## Meaning carried by small words

Protect qualifications such as `noch`, `erst`, `nur`, `bis`, `voraussichtlich`, and `sofern` when they carry timing, limits, dependencies, or uncertainty. Preserve the difference between “noch nicht getestet” and “fehlgeschlagen”, an intended date and a commitment, or a request for review and a request for approval. A shorter version must keep those distinctions even when the exact wording changes.

Untangle long sentences while retaining their connections. Use idiomatic German word order and necessary articles and connective words; concise writing need not become a sequence of fragments. Keep an effective passage unchanged when an edit would only impose another style.

## Einfache Sprache and technical German

For requests for Einfache Sprache or explanations for non-specialists, organize the text around what these readers need to find, understand, and do. Use familiar wording and explain necessary unfamiliar concepts from the supplied facts. Keep standard German and an adult, appropriate register. An expert audience can still need a clearer sentence without needing every technical term explained.

Reduce nested subordinate clauses and long gaps between related verb parts when they make the action hard to follow. Replace noun-heavy constructions with concrete verbs when that clarifies the actor and action. Unpack an unfamiliar compound when it hides the relationship between its parts; retain an established domain term when it is clearer. Keep causes, conditions, and references explicit. For procedures, use the sequencing guidance in [Technical prose](technical.md).

The relevant plain-language references are DIN ISO 24495-1 and the German-specific DIN 8581-1. These practices are local editorial adaptations informed by their publicly described scope, not a reconstruction of the standards or a DIN-compliance check. For technical German, tekom's *Deutsch für die Technische Kommunikation* is a related professional guide, not a German edition of ASD-STE100.

Leichte Sprache is a distinct accessibility approach, addressed by DIN SPEC 33429, with audience, presentation, and production considerations beyond an ordinary rewrite. Use that approach when the user requests it; do not label routine simplification as Leichte Sprache. For a standards-based result, consult the applicable source and check its actual requirements. [Evidence and provenance](evidence.md) records the sources and limits.

Do not translate English-specific word counts, tense restrictions, or modal bans into German. Preserve differences such as `sollte` versus `muss`, `darf` versus `kann`, and `könnte` versus a confirmed fact, including polite requests in the conditional.

## Examples

Internal update:

> Kurzes Update zum aktuellen Stand: Der Backfill läuft noch auf Staging. Ich habe den Abbruchpfad noch nicht geprüft. Könnt ihr den Merge bis dahin zurückhalten?

Possible edit:

> Der Backfill läuft noch auf Staging. Ich habe den Abbruchpfad noch nicht geprüft. Könnt ihr den Merge bis dahin zurückhalten?

The edit retains team vocabulary, the speaker, unfinished work, and the request to hold the merge.

Client email sentence:

> Wir möchten Sie darüber informieren, dass wir Ihnen das Angebot voraussichtlich am Montag schicken können, sofern uns bis Freitag Ihre Angaben vorliegen.

Possible edit:

> Wir können Ihnen das Angebot voraussichtlich am Montag schicken, sofern uns bis Freitag Ihre Angaben vorliegen.

The estimate and dependency remain; it does not become an unconditional promise.
