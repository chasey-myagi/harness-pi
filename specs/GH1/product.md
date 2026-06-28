# Product Spec: Agent Loop Development Workflow

Linked issue: GH1

## Goals

- Define how to use agent loops to develop `harness-pi` itself.
- Separate repo workflow authority from loop execution.
- Support Codex, Claude Code, and generic agent runners as equal surfaces.
- Use `harness-pi` primitives to dogfood a bounded maker-verifier development loop.
- Use Pilot's ordered review-gate before handoff to human final review.
- Keep final review, merge, release, and security decisions as human gates.

## Non-Goals

- Do not create a new product `/goal` command in this pass.
- Do not modify `@harness-pi/core` for workflow-specific behavior.
- Do not auto-merge or auto-approve PRs.
- Do not replace `CLAUDE.md` or existing CI.
- Do not create surface-specific workflow policy for Codex or Claude Code.

## User Stories

- As a maintainer, I can start a development loop from a spec task and know which gates still require a human.
- As an agent, I can implement a scoped `harness-pi` task and receive forced reviewer feedback before stopping.
- As a Claude Code user, I can enter through `CLAUDE.md` and still get the same route gates and reviewer rubric.
- As a reviewer, I can inspect the spec, diff, verification output, and reviewer verdict separately.

## Acceptance Criteria

- The architecture distinguishes outer repo workflow from inner maker-verifier execution.
- The loop uses `turnEndGuard` for mandatory verification, not optional maker-called review.
- The design specifies maker inputs, reviewer inputs, deterministic gates, stop conditions, and human gates.
- The design separates inner maker-verifier checks from `/test-review` -> `/code-review` -> `/linus-review` PR review-gate.
- The design names Codex and Claude Code as surface adapters into one workflow contract.
- The first implementation target is an example or recipe, not a core runtime feature.

## Open Questions

- Should the first executable slice live under `examples/06-repo-development-loop` or `apps/coding-agent/src/dev-loop`?
- Which real issue should be used as the first end-to-end dogfood task after GH1?
- Should reviewer models be configurable separately from maker models in the first slice?
