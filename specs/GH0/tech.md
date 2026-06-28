# Technical Spec: Pilot Workflow Adoption

Linked issue: GH0

## Proposed Design

Add a minimal Pilot workflow surface to the repository:

- `AGENTS.md` for agent entry;
- `CLAUDE.md` as the Claude Code native adapter;
- `AGENT_USAGE.md` for route selection and gate usage;
- `workflow.yaml`, `states.yaml`, and `labels.yaml` for machine-readable policy;
- `docs/AGENT_SURFACES.md`, `docs/AGENT_CODING_RULES.md`, and `docs/REVIEW_RUBRIC.md`;
- `checks/` for deterministic local validation;
- `checks/review_gate.py` for `/test-review` -> `/code-review` -> `/linus-review` evidence;
- `templates/` for spec, task, issue, and PR artifacts;
- `skills/harness-pi-workflow/SKILL.md` for repo-local workflow routing;
- `.github/workflows/workflow-check.yml` for CI validation;
- `specs/GH0/` as a bootstrap adoption packet.

## Integration Points

- Existing `.github/workflows/ci.yml` remains the runtime build/test gate.
- `workflow-check.yml` validates workflow scaffolding only.
- `CLAUDE.md` remains the source of harness-pi architecture rules and points back to the shared Pilot gates.

## Test Plan

```bash
python3 checks/check_workflow.py --repo . --all-specs
python3 checks/route_gate.py --repo . --route write_spec --issue 0 --state ready_to_spec
python3 checks/route_gate.py --repo . --route implement --issue 0 --state ready_to_implement
python3 checks/review_gate.py --repo . --evidence checks/fixtures/review-gate-pass.json --allow-fixture-artifacts
```

## Rollback Plan

Remove the workflow scaffolding files added in this adoption pass. Runtime
packages are not modified.
