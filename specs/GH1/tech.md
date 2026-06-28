# Technical Spec: Agent Loop Development Workflow

Linked issue: GH1

## Proposed Design

Build the development workflow as a repo-aware maker-verifier loop:

- Pilot route gates decide whether work may start.
- A `DevelopmentWorkItem` is derived from `specs/GH<number>/tasks.md`, `workflow.yaml`, `AGENTS.md`, and `CLAUDE.md`.
- `docs/AGENT_SURFACES.md` prevents Codex/Claude Code policy drift.
- `docs/AGENT_CODING_RULES.md` defines maker coding discipline.
- `docs/REVIEW_RUBRIC.md` defines reviewer checks.
- `checks/review_gate.py` validates ordered `/test-review` -> `/code-review` -> `/linus-review` PR handoff evidence.
- A maker `AgentSession` performs scoped repo work with coding tools.
- Deterministic gates run before LLM review.
- A reviewer `AgentSession` runs inside `turnEndGuard.check` when maker wants to stop.
- Reviewer PASS allows handoff; reviewer FAIL is fed back to maker as a blocking message.
- After inner reviewer PASS, the outer Pilot review-gate runs before human final review.

## Components

### DevelopmentWorkItem

```ts
export interface DevelopmentWorkItem {
  issue: number;
  taskId: string;
  route: "implement" | "fix_ci" | "review_pr";
  productSpecPath?: string;
  techSpecPath?: string;
  tasksPath: string;
  allowedPaths?: string[];
  requiredCommands: string[];
  successCriteria: string[];
  humanGates: string[];
}
```

### Maker

The maker uses `apps/coding-agent` assembly rather than a bespoke runtime:

- project instructions from `CLAUDE.md` / `AGENTS.md`;
- first-party coding tools;
- `permissionGate`;
- `sessionLog`, `metrics`, `costTracker`, `toolStats`;
- `tokenBudget`, `emptyRunGuard`, `repeatedCallGuard`.

### Reviewer

The reviewer is an independent `AgentSession`:

- no edit/write/bash tools;
- input is spec excerpt, task, diff, command output, and architecture constraints;
- output is exactly `PASS` or `FAIL: <gap>`;
- provider errors and non-`done` summaries surface as gate errors.

### Ordered Review Gate

The PR handoff gate is outside the maker-verifier loop:

1. `/test-review` for test adequacy;
2. `/code-review` for implementation quality;
3. `/linus-review --tone=civil` for good taste and removable special cases;
4. `python3 checks/review_gate.py --repo . --evidence review/PR<pr-number>/review-gate.json`.

This gate can block agent handoff, but it cannot approve or merge.

## Test Plan

Design verification:

```bash
python3 checks/check_workflow.py --repo . --spec-dir specs/GH1
python3 checks/route_gate.py --repo . --route write_spec --issue 1 --state ready_to_spec
python3 checks/review_gate.py --repo . --evidence checks/fixtures/review-gate-pass.json --allow-fixture-artifacts
```

Future implementation verification:

```bash
pnpm --filter @harness-pi-example/06-repo-development-loop test
pnpm --filter @harness-pi-example/06-repo-development-loop start
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

## Rollback Plan

The current pass is design-only. Remove `docs/12-agent-loop-development-workflow.md`
and `specs/GH1/` to roll back.
