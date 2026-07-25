# Review Rubric

Agent review is advisory. It should find risks and missing evidence, not grant
final approval.

Use this rubric for both Codex and Claude Code reviewer passes.

## Ordered Review Gate

Harness-pi uses Pilot's three-stage review gate before human final review:

1. `/test-review` checks test quality and coverage.
2. `/code-review` checks implementation correctness, architecture, security,
   error handling, maintainability, and requirements fit.
3. `/linus-review --tone=civil` checks good taste: removable special cases,
   unnecessary abstraction, bad data-shape choices, and complexity that should
   not exist.

The canonical stage order, required conditions, pass conditions, and blocking
ratings live in `workflow.yaml.review_gate`. `checks/review_gate.py` reads that
policy and validates the evidence file.

Record the result in `review/PR<pr-number>/review-gate.json` and validate it:

```bash
python3 checks/review_gate.py --repo . --evidence review/PR<pr-number>/review-gate.json
```

This gate is advisory. It can block agent handoff, but it cannot approve,
merge, or replace human final review.

## Required Checks

### Workflow Evidence

- Linked issue exists and is in an allowed state.
- Required specs exist when the route needs them.
- Human gates are preserved.
- The PR or handoff states which route was used.

### Scope

- Diff matches the linked issue, spec, and task IDs.
- Unrelated cleanup is absent or explicitly justified.
- Large cascades are escalated instead of hidden.

### Codebase Fit

- Existing patterns were followed.
- Imports and dependencies match project conventions.
- No new dependency was added silently.
- No dead flexibility or one-implementation abstraction was introduced.

### Correctness

- Behavior matches product acceptance criteria.
- Edge cases from the spec are handled or explicitly deferred.
- Error handling is based on real reachable failures.
- Security-sensitive behavior is identified.

### Verification

- Focused tests or checks were run.
- Missing tests are explained.
- Pre-existing failures are separated from new failures.
- Manual verification has concrete evidence when tests are not enough.

### Communication

- Assumptions and tradeoffs are stated.
- Risk and uncertainty are precise.
- Human gates still required are listed.

## Output Shape

Lead with findings, ordered by severity. If there are no findings, say so and
name any residual risk or missing verification.

Do not write:

- "ready to merge";
- "approved for merge";
- "ship it";
- "go ahead and merge";
- any equivalent final-authority phrase.

Final approval belongs to humans.
