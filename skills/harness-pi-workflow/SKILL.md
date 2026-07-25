---
name: harness-pi-workflow
description: Route harness-pi agent work through Pilot workflow gates across Codex, Claude Code, and generic agent surfaces while preserving CLAUDE.md architecture boundaries.
---

# Harness-Pi Workflow

Use this skill when working in `harness-pi`. The workflow is surface-neutral:
Codex uses `AGENTS.md`, Claude Code uses `CLAUDE.md`, and both must follow the
same Pilot gates.

## Startup

Read:

1. `AGENTS.md`
2. `AGENT_USAGE.md`
3. `workflow.yaml`
4. `states.yaml`
5. `labels.yaml`
6. `docs/AGENT_SURFACES.md`
7. `docs/AGENT_CODING_RULES.md`
8. `CLAUDE.md`
9. `docs/REVIEW_RUBRIC.md` before advisory review
10. `checks/review_gate.py` when producing review-gate evidence

## Route Choice

Choose one route before editing:

- `triage_issue`
- `write_spec`
- `implement`
- `review_pr`
- `fix_ci`
- `draft_release_note`

Default to `write_spec` for:

- core loop changes;
- hook/plugin/controller/adapter boundary changes;
- first-party tool behavior changes;
- public API changes;
- provider behavior changes;
- workflow policy changes;
- ambiguous product/runtime work.

Do not create Codex-only or Claude-Code-only workflow rules. Surface files are
adapters into the same Pilot contract.

Direct `implement` is acceptable for small mechanical docs, tests, or narrow
fixes when the user explicitly scopes the change and no architecture boundary is
being moved.

## Review Gate

Before handoff to human final review, run the ordered reviewer chain:

1. `/test-review`
2. `/code-review`
3. `/linus-review --tone=civil`

Stage order, required conditions, pass conditions, and blocking ratings come
from `workflow.yaml.review_gate`.

Persist evidence at `review/PR<pr-number>/review-gate.json` and validate it:

```bash
python3 checks/review_gate.py --repo . --evidence review/PR<pr-number>/review-gate.json
```

This gate blocks agent handoff when it fails, but it does not approve, merge, or
replace human final review.

## Coding Discipline

- Read target files, nearby tests, and similar implementations before editing.
- State assumptions and tradeoffs before choosing a design.
- Keep the diff surgical; do not reformat or refactor unrelated code.
- Do not add dependencies or configuration silently.
- Report pre-existing failures separately from failures introduced by the task.

## Harness-Pi Architecture Boundaries

- Do not modify `@earendil-works/pi-ai`.
- Keep `@harness-pi/core` minimal: loop + hook dispatcher.
- Prefer plugin/controller/adapter boundaries over expanding the core.
- Preserve safe tool ordering semantics and cwd containment.
- Keep provider keys out of repo files and persistent shell config.

## Required Verification

For workflow-only changes:

```bash
python3 checks/check_workflow.py --repo . --all-specs
```

For runtime code changes, also follow the existing rule:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

## Stop Conditions

Stop with a clear handoff when:

- a human readiness label or spec approval is missing;
- the route gate returns `needs_human` or `blocked`;
- final approval, merge, release, or security decisions are required.

## Handoff

Include route, state evidence, assumptions, tradeoffs, changed files,
verification commands/results, skipped checks, dependency/config changes, and
remaining human gates.
