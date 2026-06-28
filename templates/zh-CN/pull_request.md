# Summary

用 1-3 句话描述本次变更。

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

- [ ] 关联 issue 已有 `ready_to_implement`，或这是一个已说明的小型 bug fix。
- [ ] 需要 product/tech spec 时，已链接 spec。
- [ ] 涉及安全敏感区域时，已走私有流程或获得维护者批准。

## Review Gate

- [ ] `/test-review` 已通过，或已说明不适用原因。
- [ ] `/code-review` 已通过，或已说明不适用原因。
- [ ] `/linus-review --tone=civil` 已通过，或已说明不适用原因。
- [ ] `python3 checks/review_gate.py --repo . --evidence review/PR<pr-number>/review-gate.json` 结果：
- [ ] 已完成 agent first-pass review artifact，或明确说明跳过原因。
- [ ] Review 使用了 `docs/REVIEW_RUBRIC.md`。
- [ ] 已检查 scope drift、dependency changes 和 hidden decisions。
- [ ] 已请求 human final review。
- [ ] 需要 ownership approval 时，已明确 owner。

## Merge Gate

- [ ] 已记录 PR head SHA。
- [ ] CI/check rollup 已完成且通过。
- [ ] 已检查 review threads，未解决的 actionable threads 已处理。
- [ ] merge state 为 clean。
- [ ] merge 前已记录 human merge authorization。
- [ ] `python3 checks/github_pr_evidence.py --github-repo OWNER/REPO --pr <pr-number> --json > pr-evidence.json` 结果：
- [ ] `python3 checks/pr_gate.py --repo . --evidence <evidence.json>` 结果：

## Verification

- [ ] Tests:
- [ ] Manual proof:
- [ ] Pre-existing failures:
- [ ] Not run, with reason:
- [ ] 用户可见变更附 screenshots 或 logs:

## Dependencies And Configuration

- [ ] 无 dependency 或 config 变更。
- [ ] Dependency/config 变更说明：

## Release Notes

- [ ] 需要 changelog 或 release note。
- [ ] 非用户可见。

## Agent Disclosure

- [ ] No agent was used.
- [ ] Agent assisted; human author reviewed the full diff.
