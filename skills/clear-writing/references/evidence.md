# Evidence and provenance

Research reviewed 7 September 2026. English and German workplace guidance updated 18 September 2026. This skill is informed by research; it has no university endorsement and no demonstrated general performance advantage. The studies below did not evaluate this skill, current agent models, or Jira/email/code-comment workflows.

Plain-language and technical-language source scopes reviewed 21 October 2026. Public descriptions were reviewed; full DIN standards and the tekom guide were not reviewed.

## R1: Preserve answerability and check coverage separately

Sweta Agrawal and Marine Carpuat (2024), **Do Text Simplification Systems Preserve Meaning? A Human Evaluation via Reading Comprehension**, TACL 12, 432–448. Affiliations listed: Instituto de Telecomunicações and University of Maryland; the paper notes work done at Maryland.

[Paper and DOI](https://aclanthology.org/2024.tacl-1.24/) · [Full text](https://aclanthology.org/2024.tacl-1.24.pdf)

- **Finding:** Human reading-comprehension evaluation exposed meaning losses in outputs from nine simplification systems. Even strong systems left at least 14% of questions unanswerable from their outputs.
- **Basis reviewed:** Full text, especially sections 3, 6, and 8. The material is adapted news text, not workplace correspondence.
- **Adaptation:** Check whether the rewrite still supports answers to the reader's practical questions, then review the remaining claims separately.
- **Limit:** The paper explicitly says its questions sample information and do not measure completeness. Our claim-by-claim check is an engineering safeguard, not a validated consequence of the study.

## R2: Explain unfamiliar concepts in context

Sumit Asthana, Hannah Rashkin, Elizabeth Clark, Fantine Huot, and Mirella Lapata (2024), **Evaluating LLMs for Targeted Concept Simplification for Domain-Specific Texts**, EMNLP, 6208–6226. Affiliations listed: University of Michigan and Google DeepMind.

[Paper and DOI](https://aclanthology.org/2024.emnlp-main.357/) · [Full text](https://aclanthology.org/2024.emnlp-main.357.pdf)

- **Finding:** Human raters favored contextual explanations over simple substitutions for difficult concepts. Models traded off ease of understanding and meaning preservation; automatic metrics correlated weakly with judgments.
- **Basis reviewed:** Full text, especially sections 6–7 and limitations. Three raters assessed each selected example; the main evaluation used 120 WikiDomains and 60 SciDef examples, not every entry of the larger dataset.
- **Adaptation:** Keep precise terms and add a supported contextual explanation when the reader needs one. Assess comprehension and fidelity separately.
- **Limit:** Definition rewriting is narrower than document editing. This supports a strategy to try, not a mandate to lengthen every passage or teach experts their own vocabulary.

## R3: Reduce unnecessary jargon for non-specialists

Olivia M. Bullock, Daniel Colón Amill, Hillary C. Shulman, and Graham N. Dixon (2019), **Jargon as a barrier to effective science communication: Evidence from metacognition**, Public Understanding of Science. Ohio State University.

[DOI](https://doi.org/10.1177/0963662519865687) · [University-hosted full text](https://comm.osu.edu/sites/comm.osu.edu/files/PUS%202019-%20Bullock%20et%20al..pdf)

- **Finding:** In a randomized online experiment with 650 US adults, jargon reduced self-reported processing fluency. Providing mouseover definitions did not remove the effect.
- **Basis reviewed:** Full text, especially methods, results, and discussion. Messages concerned three emerging technologies; word count was held constant.
- **Adaptation:** Use familiar, accurate language for non-specialists; integrate necessary explanations into the text.
- **Limit:** Comprehension was not measured directly. The sample was non-representative and the messages lacked normal context. Do not describe this as proof that removing technical terms improves expert comprehension or that shorter is always better.

## Professional guidance, not experimental evidence

- **G1, Google developer documentation:** [Voice and tone](https://developers.google.com/style/tone), [highlights](https://developers.google.com/style/highlights), [code samples](https://developers.google.com/style/code-samples). Useful conventions include audience-aware explanations, direct language, and useful comments. Our scoped-diff and semantic-code-preservation checks are engineering choices, not measured findings from the guide.
- **G2, Microsoft:** [Brand voice: simple and human](https://learn.microsoft.com/en-us/style-guide/brand-voice-above-all-simple-human). Supports a practical tone that combines warmth and clarity. It is a house style, not evidence for a universal personality or email template.
- **G3, ASD-STE100:** The official [overview](https://www.asd-ste100.org/about.html) describes a controlled language developed for maintenance documentation, with writing rules, a dictionary, and provision for technical terms. The [download page](https://www.asd-ste100.org/STE_downloads.html) identifies Issue 9, January 2025. Official search-indexed page text was available during this review; direct page and PDF retrieval returned HTTP 403. This supports the scope distinction, not an audit of the full standard. This skill borrows the purpose of unambiguous technical prose without claiming STE compliance.
- **G4, DIN ISO 24495-1:2024-03:** [Official title and introduction](https://www.dinmedia.de/de/norm/din-iso-24495-1/375008622). The public introduction emphasizes the intended readers' needs and whether they can find, understand, and use information, rather than readability formulas. This supports audience-aware plain-language goals across languages; it does not validate this skill's implementation.
- **G5, DIN 8581-1:2024-05:** [Official title and introduction](https://www.dinmedia.de/de/norm/din-8581-1/377238273). German-specific guidance for nonfiction in Einfache Sprache based on DIN ISO 24495-1; its scope distinguishes it from Leichte Sprache. The detailed German editing practices here are local choices, not claimed quotations or clause-level requirements.
- **G6, DIN SPEC 33429:2025-03:** [Official title and introduction](https://www.dinmedia.de/de/technische-regel/din-spec-33429/387728031), *Empfehlungen für Deutsche Leichte Sprache*. Its publicly described scope includes language, presentation, media, production, and readers with learning difficulties. This supports keeping an explicit Leichte Sprache request distinct from ordinary workplace simplification. No accessibility or standards conformity is established by a text edit alone.
- **G7, tekom:** [*Deutsch für die Technische Kommunikation: Regelbasiertes Schreiben*, third revised edition, 2026](https://www.tekom.de/services-unsere-angebote/publikationen/fachbuecher/detail/deutsch-fuer-technische-kommunikation-regeln-und-ihre-anwendung). The publisher describes structured, consistent technical writing and translation considerations. This is a related professional German resource, not a German translation of STE; no individual rule is attributed to its unreviewed full text.

## Local design choices

The following are configurable editorial or engineering choices: returning only the final text; leaving effective passages unchanged; no fixed sentence length, reduction percentage, punctuation quota, reading grade, or AI score; preserving exact technical anchors; keeping ticket logic and code behavior intact. They address workplace writing needs and foreseeable editing errors. They are not attributed to university research.

The exclusion of em dashes from authored and rewritten prose is a local style preference. It is not an AI-authorship signal or a research-backed measure of writing quality. Exact quotations and technical literals retain their punctuation.

The PR and German workplace references are also local editorial choices. They address validation scope, review intent, register, technical vocabulary, and meaningful qualifications. The studies above do not establish their effectiveness for German prose or PR review.

The plain-language guidance selectively adapts ideas examined in the `simple-english` skill, version 2.1.1: audience-aware explanations, explicit terminology, and usable procedure sequences. It is not a runtime dependency. This package does not adopt its blanket modal or tense restrictions, automatic word substitutions, fixed length limits, or chat-format restrictions. Such rules can change the source's meaning or impose a style unrelated to the task. The English reference, procedure details, and German readability practices remain editorial choices, not experimentally established benefits or a full language-standard implementation.

Assess naturalness through idiomatic wording, coherent explanations, and audience and register fit. None of the cited studies validates an AI-authorship detector or a universal blacklist. Preserve linguistic variety and appropriate formality instead of diagnosing authorship from prose.

## Authoring provenance

Created using OpenAI's local `skill-creator` guidance and Matt Pocock's [writing-for-agents](https://www.skills.sh/mattpocock/skills/writing-for-agents), including its [skill mechanics](https://github.com/mattpocock/skills/blob/HEAD/skills/productivity/writing-for-agents/SKILL-MECHANICS.md). Matt's skill was read for authoring, not installed or made a runtime dependency.

Applied authoring choices: compact discovery description, shared safeguards in the entrypoint, branch-specific references, explicit completion criteria, and one source of truth for each rule. OpenAI's current metadata and automatic-discovery conventions govern the package. These are authoring methods, not scientific evidence about prose quality.

## Updating the evidence

Before adding a rule attributed to research, read the original methods and limitations. Record the task, population, measured outcome, proposed adaptation, and where transfer is uncertain. Distinguish observed comprehension from perceived ease, correlations from experimental effects, and component tests from skill performance. Add a relevant evaluation case when the rule changes behavior. Preserve conflicting findings and narrow a rule when evidence does not generalize. Never label this package validated solely because the citations or tests exist.
