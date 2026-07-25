/**
 * `@harness-pi/transcript` —— 双轨事件的 browser-safe 投影层。
 *
 * 本 issue（#153）只落地契约：内核事件镜像 + 透传水位 + 快照信封。
 * L1 store 与 L2 幂等 op 随 #166、双轨投影器随 #167 追加进 `src/contract/` 与 `src/`。
 */
export * from "./contract/index.js";
