# Agent Instruction Adapter

Use this template when adding a surface-specific instruction file such as
`CLAUDE.md`, or when adapting `AGENTS.md` for a repo that supports multiple
agent surfaces.

## Purpose

This file is a surface adapter. It does not override the repo workflow contract.

## Read Order

1. `AGENTS.md`
2. `CLAUDE.md` when this is the Claude Code native entrypoint
3. `workflow.yaml`
4. `states.yaml`
5. `labels.yaml`
6. `AGENT_USAGE.md`
7. `docs/AGENT_SURFACES.md`
8. `docs/AGENT_CODING_RULES.md`
9. repo-local skills

## Coding Rules

- Read before writing.
- State assumptions and tradeoffs.
- Keep the design simple.
- Keep diffs surgical.
- Verify behavior.
- Debug by evidence.
- Do not add dependencies silently.
- Communicate uncertainty and remaining gates.

## Workflow Rules

- Choose a route before acting.
- Run the relevant route gate when issue or PR evidence exists.
- Use specs for ambiguous, architecture, product, public API, cross-module, or workflow-policy work.
- Stop at human gates.
- Do not approve, merge, force-push, publish security disclosures, or change permissions.

## Verification

```bash
python3 checks/check_workflow.py --repo . --all-specs
```
