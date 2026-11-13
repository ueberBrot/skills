# Select critics

Use for requested models, reasoning settings or panels. Keep the selected roster
fixed across rounds; create new sessions each round.

1. Discover enabled providers, child models, supported settings, fresh-context
   support and concurrency limits through the host's tools. A catalog entry or
   installed binary does not establish availability. Do not read credentials or
   install or launch agents for discovery.
2. Honor explicit choices. If unavailable, explain and ask for a supported
   alternative before dependent work; never substitute silently.
3. For an unspecified diverse panel, choose up to three critics, preferring
   distinct model families across enabled providers. Use fewer if necessary and
   disclose the roster. Multiple models from one provider are not provider diversity.
4. Inherit current settings for the default critic. Otherwise use requested
   settings or exposed host defaults; do not guess equivalent effort labels.
   Distinguish requested settings from actual settings and leave unknowns unset.
5. Prefer supported native delegation; otherwise use the host's delegation tool.
   Follow its isolation, waiting and cancellation rules. Queue critics when
   concurrency is limited. Each gets the same frozen artifact without other
   verdicts. A failed seat prevents acceptance.

In T3 Code, call `orchestrator_capabilities` before the first `delegate_task`.
Use native delegation for supported inherited-provider/model tasks with no
extra settings. Use `delegate_task` for other providers, user-requested settings
or isolated checkouts. Put settings in `target.options` using catalog IDs and
values. Create child tasks, not top-level threads; follow returned `next`
instructions. Supply the exact snapshot since a checkout may omit uncommitted work.

Retain critic attribution when merging findings. Resolve disagreements through
verification rather than selecting the favorable review.
