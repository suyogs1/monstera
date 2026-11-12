# Value-for-Credit governance

Use AI credits to create measurable progress, reduce meaningful risk, or improve the product.
Never consume them merely to keep an agent busy. This is a quality-first policy, not a ceiling:
spend freely where it buys correctness, and nothing where it buys only activity.

Tunable limits live in `.kiro/governance.json` (profiles `lean`, `balanced`, `thorough`; the
`active` profile applies). Rules below are the policy; the profile only sets numbers.

## Before substantial execution
State in one or two lines: the outcome, the evidence that will show it, and why an agent (not a
script) is needed. If you cannot name a measurable outcome, do not start.

## Decision rules
1. Batch. Implement, test and document one coherent change together; run the gates once per batch,
   not per edit. Do not re-run a green check without a change that could alter it.
2. Script first. Anything repetitive and deterministic (`monstera gates`, `generate`, `conformance`,
   `validate`) is run, not re-derived by an agent. Do not ask an agent to read what a tool reports.
3. No repeated review without new evidence. Re-review only when new commits touch the findings or a
   new risk appeared. A review that found nothing is not repeated on the same head.
4. Bounded waits. CI, Docker, emulators and network are waited on for a fixed time
   (`ciWaitMinutes`), never polled in a loop by an agent. On timeout, record the state as
   "pending" and switch to work that does not depend on it.
5. Escalate on real risk. Architecture, security, ownership/overwrite safety, determinism and
   cross-platform correctness justify adversarial review and extra passes regardless of profile.
   Cosmetic, naming and wording changes never do.
6. Stop conditions. Stop and report when: the goal is met, a pass produced no new evidence, the
   same approach failed twice (diagnose, do not patch again), or the next step needs an external
   dependency that is unavailable.
7. Do not narrate. Status messages repeat nothing the diff or a log already shows.

## Measurement honesty
Kiro does not expose credit consumption to the project. Never write a credit number, a cost, or a
"credits saved" figure. What can be reported truthfully is effort: wall-clock time, commands run,
retries, waits, review rounds, files and lines changed. `monstera effort` records and summarises
those (`.kiro/workflow-output/effort.jsonl`, git-ignored scratch); it is advisory and never gates.

## Outcome report (end of each coherent milestone)
Five short items: implemented; why it was worth doing; verified (with the command, or "not run");
remaining; whether more AI execution is justified, and why or why not.
`monstera effort report` prints the factual part.
