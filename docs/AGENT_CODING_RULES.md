# Agent Coding Rules

These rules capture repeated LLM coding failure modes. They are intentionally
practical: each rule exists because agents often fail in that specific way.

## Read Before Writing

Before editing:

- read the files you will modify;
- read nearby tests and examples;
- inspect imports and existing dependencies;
- search for similar patterns with `rg`;
- say when no local pattern is visible.

Do not generate code from memory when the repo already has a pattern.

## Think Before Coding

State assumptions when the request is ambiguous. Name tradeoffs when choosing
between approaches. If the requirement is unclear, stop and ask or record the
assumption explicitly before implementation.

Avoid invisible decisions: auth shape, schema changes, API contracts,
dependencies, persistence, caching, and concurrency behavior must be called out.

## Keep It Simple

Write the minimum design that solves the current problem.

Avoid:

- premature abstraction;
- interfaces with one implementation;
- speculative configuration;
- generic frameworks for one use case;
- error handling for states that cannot occur.

Duplication is cheaper than the wrong abstraction until a second real use case
exists.

## Keep Diffs Surgical

Every changed line should tie back to the selected route and task.

- Do not touch unrelated files.
- Match local style.
- Do not reformat unrelated code.
- Clean up only what your change made stale.
- Stop when a fix cascades beyond the scoped task.

## Verify Behavior

Bug fixes need a failing reproduction before the fix when feasible. New behavior
needs tests or a clear explanation of why testing is not practical.

Always report:

- commands run;
- command results;
- pre-existing failures;
- checks skipped and why.

## Debug By Evidence

Read full error messages and stack traces. Reproduce before changing code.
Change one thing at a time. Do not add workarounds before understanding the root
cause.

## Be Careful With Dependencies

Before adding a dependency:

- check what the project already uses;
- prefer the standard library when reasonable;
- check maintenance and size;
- explain why the dependency is justified.

Silent dependency additions are review risks.

## Communicate Precisely

Handoffs should say:

- what changed;
- why it changed;
- what assumptions were made;
- what was verified;
- what remains risky or unverified;
- which human gates remain.

Do not explain concepts the maintainer already knows. Do not hide uncertainty.

## Common Failure Modes

- Kitchen sink: one request becomes a broad rewrite.
- Wrong abstraction: a generic design for a one-off problem.
- Invisible decision: architecture changed without being named.
- Optimistic path: happy path works, errors do not.
- Knowledge hallucination: API or option does not exist in this repo version.
- Style drift: code follows the agent preference instead of the project.
- Runaway refactor: a fix expands until the original task is no longer clear.
