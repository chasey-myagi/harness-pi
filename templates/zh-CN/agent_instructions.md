# Agent Instruction Adapter

当需要为某个 agent surface 增加专属入口文件时使用这个模板，例如
`CLAUDE.md`，或为同时支持多个 agent surface 的 repo 调整 `AGENTS.md`。

## Purpose

这个文件是 surface adapter，不覆盖 repo workflow contract。

## Read Order

1. `AGENTS.md`
2. 当前 surface 是 Claude Code 时读取 `CLAUDE.md`
3. `workflow.yaml`
4. `states.yaml`
5. `labels.yaml`
6. `AGENT_USAGE.md`
7. `docs/AGENT_SURFACES.md`
8. `docs/AGENT_CODING_RULES.md`
9. repo-local skills

## Coding Rules

- 写之前先读代码。
- 明确 assumptions 和 tradeoffs。
- 保持设计简单。
- 保持 diff surgical。
- 验证行为。
- 基于证据调试。
- 不静默新增 dependencies。
- 说明不确定性和剩余 human gates。

## Workflow Rules

- 先选择 route，再行动。
- 有 issue 或 PR evidence 时，先跑对应 route gate。
- ambiguous、architecture、product、public API、cross-module、workflow-policy work 需要先写 spec。
- 遇到 human gates 就停止。
- 不 approve、merge、force-push、公开 security disclosure 或修改 permissions。

## Verification

```bash
python3 checks/check_workflow.py --repo . --all-specs
```
