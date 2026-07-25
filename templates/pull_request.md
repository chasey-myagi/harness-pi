# Summary

Describe the change in 1-3 sentences.

## Linked Work

- Issue:
- Spec packet:
- Route:
- Agent surface: Codex / Claude Code / other / none

## Assumptions And Tradeoffs

- Assumptions:
- Tradeoffs:
- Out of scope:

## Readiness Gate

- [ ] Linked issue has `ready_to_implement`, or this is a documented small bug fix.
- [ ] Product/tech spec is linked when required.
- [ ] Security-sensitive changes were routed privately or approved by maintainers.

## Review Gate

- [ ] `/test-review` passed, or was marked not applicable with reason.
- [ ] `/code-review` passed, or was marked not applicable with reason.
- [ ] `/linus-review --tone=civil` passed, or was marked not applicable with reason.
- [ ] `python3 checks/review_gate.py --repo . --evidence review/PR<pr-number>/review-gate.json` result:
- [ ] Agent first-pass review artifact completed or explicitly skipped with reason.
- [ ] Review used `docs/REVIEW_RUBRIC.md`.
- [ ] Scope drift, dependency changes, and hidden decisions were checked.
- [ ] Human final review requested.
- [ ] Owner approval identified when ownership rules apply.

## Merge Gate

- [ ] PR head SHA recorded.
- [ ] CI/check rollup is complete and passing.
- [ ] Review threads were checked and unresolved actionable threads are addressed.
- [ ] Merge state is clean.
- [ ] Human merge authorization is recorded before merge.
- [ ] `python3 checks/github_pr_evidence.py --github-repo OWNER/REPO --pr <pr-number> --json > pr-evidence.json` result:
- [ ] `python3 checks/pr_gate.py --repo . --evidence <evidence.json>` result:

## Verification

- [ ] Tests:
- [ ] Manual proof:
- [ ] Pre-existing failures:
- [ ] Not run, with reason:
- [ ] Screenshots or logs when user-visible:

## Dependencies And Configuration

- [ ] No dependency or config changes.
- [ ] Dependency/config changes are explained:

## Release Notes

- [ ] Changelog or release note needed.
- [ ] Not user-visible.

## Agent Disclosure

- [ ] No agent was used.
- [ ] Agent assisted; human author reviewed the full diff.
