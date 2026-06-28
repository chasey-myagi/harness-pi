# Product Spec: Pilot Workflow Adoption

Linked issue: GH0

## Goals

- Make `harness-pi` agent work explicit and repeatable.
- Give agents a route-selection contract before implementation, PR review, CI diagnosis, or release note drafting.
- Support Codex, Claude Code, and generic agent runners without forking workflow policy.
- Keep `CLAUDE.md` as the Claude Code architecture adapter while adding workflow gates around it.
- Add shared agent coding rules and review rubric.
- Add ordered review-gate evidence for `/test-review`, `/code-review`, and `/linus-review`.
- Preserve human control over readiness, final review, merge, release, and security decisions.

## Non-Goals

- No runtime source changes in this adoption pass.
- No automatic label writes.
- No automatic PR approval or merge.
- No replacement of existing CI.
- No Codex-only or Claude-Code-only workflow authority.

## User Stories

- As a maintainer, I can see whether an agent is allowed to implement a change.
- As an agent, I can identify when a spec is required before coding.
- As a Claude Code user, I can use `CLAUDE.md` while still following the same Pilot gates.
- As a reviewer, I can inspect checked-in workflow artifacts instead of relying on chat-only process memory.

## Acceptance Criteria

- Root workflow files exist: `AGENTS.md`, `AGENT_USAGE.md`, `workflow.yaml`, `states.yaml`, `labels.yaml`.
- Surface/coding/review docs exist: `docs/AGENT_SURFACES.md`, `docs/AGENT_CODING_RULES.md`, `docs/REVIEW_RUBRIC.md`.
- Local gates exist under `checks/`.
- `checks/review_gate.py` validates ordered review-gate evidence.
- Templates exist under `templates/`.
- A repo-local workflow skill exists at `skills/harness-pi-workflow/SKILL.md`.
- `python3 checks/check_workflow.py --repo . --all-specs` passes.

## Open Questions

- Which real GitHub issue should be the first non-GH0 end-to-end trial?
- Should comment-only GitHub automation be enabled after one manual run?
