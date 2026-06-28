# AGENTS.md

This repo uses a Pilot-style workflow contract for agent work across Codex,
Claude Code, and generic agent runners.

Surface-specific files are adapters. `AGENTS.md` and `CLAUDE.md` point to the
same workflow contract; neither file grants separate readiness, review, merge,
release, or security authority.

## Read Order

Before changing code, read:

1. `AGENTS.md`
2. `CLAUDE.md` when using Claude Code
3. `AGENT_USAGE.md`
4. `workflow.yaml`
5. `states.yaml`
6. `labels.yaml`
7. `docs/AGENT_SURFACES.md`
8. `docs/AGENT_CODING_RULES.md`
9. `docs/REVIEW_RUBRIC.md` before advisory review
10. `checks/review_gate.py` when running review-gate evidence
11. `skills/harness-pi-workflow/SKILL.md`

`CLAUDE.md` remains the repository-specific architecture guide. The workflow
files decide whether a route may proceed; `CLAUDE.md` decides how code should
fit the harness-pi architecture.

When instructions conflict, resolve them in this order: explicit human
instruction, `workflow.yaml`, `AGENTS.md`, `CLAUDE.md`, repo-local skill.

## Route Before Work

Choose one route before acting:

- `triage_issue`
- `write_spec`
- `implement`
- `review_pr`
- `fix_ci`
- `draft_release_note`

Default to `write_spec` before `implement` for architecture, public API,
cross-package, workflow-policy, provider-behavior, or product-facing changes.

Direct implementation is allowed only for small mechanical changes or work with
accepted specs and trusted readiness evidence.

## Coding Discipline

Before editing:

- read target files and nearby tests;
- inspect existing patterns and imports;
- state assumptions and tradeoffs when ambiguous;
- avoid speculative abstractions and silent dependencies;
- keep diffs surgical.

After editing:

- run focused verification;
- report pre-existing failures separately;
- state what was not run and why;
- list remaining human gates.

## Review Gate

For PR review or handoff, run the ordered gate:

1. `/test-review`
2. `/code-review`
3. `/linus-review --tone=civil`

Persist stage evidence in `review/PR<pr-number>/review-gate.json` and validate
it with `python3 checks/review_gate.py --repo . --evidence review/PR<pr-number>/review-gate.json`.

## Human Gates

Agents may propose, draft, implement scoped tasks, review, diagnose, and
summarize. Agents must not:

- final-approve;
- merge;
- force-push;
- bypass readiness labels;
- publish security disclosures;
- change repository permissions.

## Repository Rules

- Preserve the branch flow in `CLAUDE.md`: feature branches target `dev`; releases go `dev -> main`.
- Build before typecheck/test when public package output may be stale.
- Treat `.harness-pi/` as sensitive local runtime state.
- Keep human-facing Chinese text in Chinese when the requester writes Chinese.
- Keep state names, labels, commands, JSON keys, and task IDs in English.

## Validation

Run:

```bash
python3 checks/check_workflow.py --repo . --all-specs
```
