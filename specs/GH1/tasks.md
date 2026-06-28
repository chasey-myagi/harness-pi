# Tasks: Agent Loop Development Workflow

Linked issue: GH1

## Implementation Tasks

- [ ] `SP1-T1` Owner: agent. Done when: development-loop architecture doc exists. Verify: inspect `docs/12-agent-loop-development-workflow.md`.
- [ ] `SP1-T2` Owner: agent. Done when: GH1 product and tech specs describe outer workflow, inner maker-verifier loop, multi-surface adapters, gates, and non-goals. Verify: inspect `specs/GH1/product.md` and `specs/GH1/tech.md`.
- [ ] `SP1-T3` Owner: agent. Done when: workflow validation passes for GH1. Verify: `python3 checks/check_workflow.py --repo . --spec-dir specs/GH1`.
- [ ] `SP1-T4` Owner: agent. Done when: surface/coding/review docs and ordered review-gate are referenced by the loop design. Verify: inspect `docs/AGENT_SURFACES.md`, `docs/AGENT_CODING_RULES.md`, `docs/REVIEW_RUBRIC.md`, and `checks/review_gate.py`.
- [ ] `SP1-T5` Owner: human. Done when: implementation location is selected. Verify: choose `examples/06-repo-development-loop` or `apps/coding-agent/src/dev-loop`.
- [ ] `SP1-T6` Owner: agent. Done when: first executable slice is implemented after human approval. Verify: targeted package tests plus `pnpm -r build && pnpm -r typecheck && pnpm -r test` when scope requires.

## Verification

```bash
python3 checks/check_workflow.py --repo . --spec-dir specs/GH1
python3 checks/route_gate.py --repo . --route write_spec --issue 1 --state ready_to_spec
python3 checks/review_gate.py --repo . --evidence checks/fixtures/review-gate-pass.json --allow-fixture-artifacts
```

## Handoff Notes

This is a design packet. It intentionally stops before adding a new product
command or changing runtime packages.
