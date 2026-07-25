# Tasks: Pilot Workflow Adoption

Linked issue: GH0

## Implementation Tasks

- [ ] `SP0-T1` Owner: agent. Done when: root workflow files are present. Verify: inspect `AGENTS.md`, `AGENT_USAGE.md`, `workflow.yaml`, `states.yaml`, and `labels.yaml`.
- [ ] `SP0-T2` Owner: agent. Done when: deterministic workflow gates are present. Verify: inspect `checks/check_workflow.py` and `checks/route_gate.py`.
- [ ] `SP0-T3` Owner: agent. Done when: repo-local workflow skill is present. Verify: inspect `skills/harness-pi-workflow/SKILL.md`.
- [ ] `SP0-T4` Owner: agent. Done when: workflow validation passes. Verify: `python3 checks/check_workflow.py --repo . --all-specs`.
- [ ] `SP0-T5` Owner: agent. Done when: ordered review-gate evidence is supported. Verify: `python3 checks/review_gate.py --repo . --evidence checks/fixtures/review-gate-pass.json --allow-fixture-artifacts`.
- [ ] `SP0-T6` Owner: human. Done when: a real GitHub issue is selected for the first end-to-end route. Verify: issue has a trusted readiness label.

## Verification

```bash
python3 checks/check_workflow.py --repo . --all-specs
```

## Handoff Notes

GH0 is a bootstrap adoption packet, not a real product issue. Replace it with a
real issue number for the first live workflow trial.
