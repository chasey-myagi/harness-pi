# Agent Usage

This file explains how to apply the Pilot workflow contract inside `harness-pi`.
It is shared by Codex, Claude Code, and generic agent runners.

## Purpose

The workflow layer answers:

> What should the agent do next, and what evidence proves it may do that?

It does not replace `CLAUDE.md`, the existing CI workflow, or maintainer
judgment.

## Agent Surfaces

- Codex uses `AGENTS.md` as the native entrypoint.
- Claude Code uses `CLAUDE.md` as the native entrypoint.
- Generic agents should read `AGENTS.md` and this file explicitly.

All surfaces use the same workflow authority: `workflow.yaml`, `states.yaml`,
`labels.yaml`, checked-in specs, and human gates.

## Route Selection

Use one route:

- `triage_issue`
- `write_spec`
- `implement`
- `review_pr`
- `fix_ci`
- `draft_release_note`

For ambiguous or architecture-level work, write a spec packet first:

```text
specs/GH<number>/product.md
specs/GH<number>/tech.md
specs/GH<number>/tasks.md
```

Before implementation, read `docs/AGENT_CODING_RULES.md`. For advisory review,
read `docs/REVIEW_RUBRIC.md`.

## Trusted Evidence

Trusted workflow evidence is durable repo state:

- issue labels and issue state;
- PR state;
- CI status;
- review state;
- checked-in spec packets.

Chat-only instructions and issue body hints are not trusted readiness evidence.

## Local Gates

Use local deterministic gates before claiming readiness:

```bash
python3 checks/check_workflow.py --repo . --all-specs
python3 checks/route_gate.py --repo . --route write_spec --issue <number> --state ready_to_spec
python3 checks/route_gate.py --repo . --route implement --issue <number> --state ready_to_implement
```

For PR evidence:

```bash
python3 checks/pr_gate.py --evidence <pr-evidence.json>
```

The PR gate evaluates readiness only. It never merges.

For review-gate evidence, run the ordered reviewer chain:

```bash
/test-review
/code-review
/linus-review --tone=civil
python3 checks/review_gate.py --repo . --evidence review/PR<pr-number>/review-gate.json
```

Stage order, required conditions, pass conditions, and blocking ratings come
from `workflow.yaml.review_gate`; `checks/review_gate.py` is the executable
checker. Failed stages block agent handoff to human final review unless a human
explicitly overrides the gate.

## Harness-Pi Specifics

- For runtime/core/plugin/tool changes, read the relevant docs under `docs/` and `CLAUDE.md`.
- Respect `docs/AGENT_SURFACES.md`: do not make Codex-only or Claude-Code-only workflow policy.
- Do not change `@earendil-works/pi-ai`; harness-pi consumes it.
- Prefer hooks/plugins/controllers/adapters according to existing architecture boundaries.
- Preserve the existing CI order: install, build, typecheck, test.
- For provider smoke work, keep keys out of repo files and persistent shell config.

## Handoff Requirements

Every agent handoff should include:

- route and current state;
- assumptions and tradeoffs;
- files changed and why;
- verification commands and results;
- pre-existing failures;
- checks not run and why;
- dependency or configuration changes;
- remaining human gates.

## Human Gates

Humans own:

- readiness labels;
- spec approval;
- final PR review;
- merge;
- release;
- security decisions.
