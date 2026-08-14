<!--
写 `Fixes #NN` 会在合并时关票；只关联写 `Related to #NN`。
非 Draft 的实现型 PR 至少引用一个同仓库 Issue。
冻结期内实现 `reserved_internal` / 设计输入票，先在 #178 声明。
完整 Pilot 清单（agent 路由）见 templates/pull_request.md。
-->

Related to #

<details>
<summary>变更与验证</summary>

- 变更（用户或调用方能察觉的）：
- 验证（命令 + 结果）：
- 未跑的检查及原因：
- 改了哪份现状契约 / Agent Note（没有就写无）：

</details>

<details>
<summary>门禁（按需）</summary>

- [ ] 关联 issue 允许这条路（`ready_to_implement`，或已说明的小修复 / 文档卫生）
- [ ] 需要 spec 时已链 `specs/GH<n>/`
- [ ] 实现型 PR：review-gate 已跑或注明不适用
- [ ] 无顺手改动；新依赖已说明
- [ ] 已请求人类终审（agent 不能 merge）

</details>
