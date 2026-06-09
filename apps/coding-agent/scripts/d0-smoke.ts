/**
 * D0 (#44): 真 DashScope provider smoke —— 把成熟度从「机制已实现」推到「provider 已验证」。
 *
 * 不进 `pnpm test`(真 API 外呼 + 花费)。手动跑(key 经 env 注入,不硬编码、不落盘):
 *   DASHSCOPE_API_KEY=$(security find-generic-password -a "$USER" -s DASHSCOPE_API_KEY -w) \
 *     pnpm --filter @harness-pi/coding-agent exec tsx scripts/d0-smoke.ts
 *   # 可选:D0_MODEL=qwen-turbo(更便宜)覆盖默认 qwen-plus
 *
 * 验证目标(本仓刚发的修复在真 provider 下成立):
 *   A. streaming + tool call 端到端:reason=done、真 streaming delta、tool 往返。
 *   A'. X1/X2 估算校准:estimateRequestTokens(turn-0 含 tool schema) vs 真 usage.input 偏差。
 *   B. provider error(坏 apiKey):#53 —— 真 401 → reason=error(不再静默 done)、不误判 overflow。
 *   C. 容忍型 provider 探针:大(但 < 窗口)prompt 正常完成、不误 fire overflow(记录为何真 overflow 不便宜)。
 */
import { AgentSession, type HarnessTool } from "@harness-pi/core";
import { estimateRequestTokens } from "@harness-pi/plugins";
import { Type } from "@earendil-works/pi-ai";
import { resolveDashScopeModel } from "../src/providers/dashscope.js";

const MODEL_ID = process.env.D0_MODEL ?? "qwen-plus";
const key = process.env.DASHSCOPE_API_KEY;
if (!key) {
  console.error(
    "[D0] 缺 DASHSCOPE_API_KEY。跑法:DASHSCOPE_API_KEY=$(security find-generic-password -a \"$USER\" -s DASHSCOPE_API_KEY -w) pnpm --filter @harness-pi/coding-agent exec tsx scripts/d0-smoke.ts",
  );
  process.exit(2);
}

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

const addTool: HarnessTool = {
  name: "add",
  description: "Add two integers and return the sum.",
  parameters: Type.Object({
    a: Type.Number({ description: "first integer" }),
    b: Type.Number({ description: "second integer" }),
  }),
  isConcurrencySafe: () => true,
  async execute(args) {
    const a = Number((args as { a: number }).a);
    const b = Number((args as { b: number }).b);
    return { content: [{ type: "text", text: String(a + b) }] };
  },
};

async function testA(): Promise<void> {
  console.log(`\n[A] streaming + tool call + 估算校准 (model=${MODEL_ID})`);
  const { model, llmOptions } = resolveDashScopeModel(MODEL_ID, {
    DASHSCOPE_API_KEY: key,
  });
  const systemPrompt =
    "You are a calculator. When asked to add numbers, you MUST call the add tool, then reply with only the resulting number.";
  const userPrompt = "What is 2 + 3? Use the add tool, then give me just the number.";

  let deltaCount = 0;
  let toolCalled = false;
  let firstRealInput: number | undefined;

  const session = new AgentSession({
    model,
    tools: [addTool],
    systemPrompt,
    llmOptions,
    maxTurns: 6,
    consoleSink: () => {},
    hooks: [
      {
        name: "d0-probe",
        // 记 turn-0 真实 prompt token(第一次 LLM 调用的 usage.input)。
        onLlmEnd: (input) => {
          if (firstRealInput === undefined) {
            firstRealInput = input.msg.usage?.input;
          }
        },
      },
    ],
  });
  session.on("text_delta", () => deltaCount++);
  session.on("message_end", (e) => {
    const msg = e.message as { content?: Array<{ type: string }> } | undefined;
    if (msg?.content?.some((b) => b.type === "toolCall")) toolCalled = true;
  });

  const summary = await session.run(userPrompt);
  const finalText = ((summary.lastMessage?.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  check("reason === 'done'", summary.reason === "done", `reason=${summary.reason}`);
  check("tool 'add' 被调用", toolCalled);
  check("streaming delta > 0(真流式)", deltaCount > 0, `deltas=${deltaCount}`);
  check("最终回答含 '5'", finalText.includes("5"), `final="${finalText.slice(0, 60)}"`);

  // X1/X2 校准:turn-0 请求级估算(含 tool schema)vs 真 usage.input。
  const est = estimateRequestTokens({
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: 0 }],
    tools: [addTool],
    systemPrompt,
  });
  if (firstRealInput && firstRealInput > 0) {
    const ratio = firstRealInput / est;
    console.log(
      `  · 估算校准:estimateRequestTokens(turn-0)=${est}  vs  真 usage.input=${firstRealInput}  → 真/估=${ratio.toFixed(2)}x`,
    );
    // X1 修复前是纯 char 估算、~7x 低估(真/估 ≫ 1)。修复后应锁进一个合理带:
    // 上界 3x 防低估(危险侧:阈值触发偏晚),下界 0.5x 防 estimator 朝过高方向漂移。
    check(
      "估算锁进合理区间(0.5x ≤ 真/估 ≤ 3x)",
      ratio >= 0.5 && ratio <= 3,
      `真/估=${ratio.toFixed(2)}x(X1 修复前约 7x)`,
    );
  } else {
    // 校准是本 smoke 的头条卖点;provider 不回 usage.input = 校准根本没跑,
    // 计为失败,别让 exit0「全部 ✓」假绿。
    check("provider 回传 usage.input(估算校准前提)", false, "未回传 usage.input,校准未执行");
  }
  console.log(`  · 真 usage: input=${summary.usage.input} output=${summary.usage.output} total=${summary.usage.totalTokens}`);
}

async function testB(): Promise<void> {
  console.log(`\n[B] provider error(坏 apiKey)→ #53 提级 reason=error`);
  // 坏 key 经 resolveDashScopeModel 透传进返回的 llmOptions —— 直接用它,不再手写重复魔法字符串。
  const { model, llmOptions } = resolveDashScopeModel(MODEL_ID, {
    DASHSCOPE_API_KEY: "sk-deliberately-invalid-key-for-d0",
  });
  let overflowFired = false;
  let onErrorFired = false;
  const session = new AgentSession({
    model,
    tools: [],
    llmOptions,
    consoleSink: () => {},
    hooks: [
      { name: "ovf-watch", onContextOverflow: () => { overflowFired = true; } },
      { name: "err-watch", onError: () => { onErrorFired = true; } },
    ],
  });
  const summary = await session.run("hello");
  check(
    "reason === 'error'(#53:不再静默 done)",
    summary.reason === "error",
    `reason=${summary.reason}`,
  );
  check("summary.error 有错误信息", !!summary.error, summary.error?.message?.slice(0, 80) ?? "");
  check("未误判为 overflow(onContextOverflow 不 fire)", !overflowFired);
  check("onError 已 fire(可观测)", onErrorFired);
}

async function testC(): Promise<void> {
  console.log(`\n[C] 容忍型 provider 探针(大 prompt 正常完成、不误 fire overflow)`);
  const { model, llmOptions } = resolveDashScopeModel(MODEL_ID, {
    DASHSCOPE_API_KEY: key,
  });
  // ~几千 token 的填充(远低于 Qwen 1M 窗口)——证明大输入正常完成、不会误触发 overflow。
  const filler = "The quick brown fox jumps over the lazy dog. ".repeat(400);
  let overflowFired = false;
  const session = new AgentSession({
    model,
    tools: [],
    llmOptions,
    maxTurns: 2,
    consoleSink: () => {},
    hooks: [{ name: "ovf-watch", onContextOverflow: () => { overflowFired = true; } }],
  });
  const summary = await session.run(
    `Here is some text:\n${filler}\nReply with exactly the word: ok`,
  );
  check("reason === 'done'(大 prompt 正常完成)", summary.reason === "done", `reason=${summary.reason}`);
  check("未误 fire overflow", !overflowFired);
  console.log(`  · 真 usage.input=${summary.usage.input}(远低于 1M 窗口)`);
  console.log(
    "  · 说明:Qwen 是容忍型 provider + 1M 窗口,真正 >1M 的 reactive overflow 强行触发成本过高;",
  );
  console.log(
    "    overflow 机制本身由确定性测试(context-overflow.test.ts)覆盖;此发现正是 C3 走主动压缩(X1/X2)的依据。",
  );
}

async function main(): Promise<void> {
  console.log(`=== D0 真 provider smoke (DashScope ${MODEL_ID}) ===`);
  try {
    await testA();
  } catch (err) {
    failures++;
    console.error("  ✗ [A] 抛异常:", err instanceof Error ? err.message : err);
  }
  try {
    await testB();
  } catch (err) {
    failures++;
    console.error("  ✗ [B] 抛异常:", err instanceof Error ? err.message : err);
  }
  try {
    await testC();
  } catch (err) {
    failures++;
    console.error("  ✗ [C] 抛异常:", err instanceof Error ? err.message : err);
  }
  console.log(`\n=== D0 smoke 结束:${failures === 0 ? "全部 ✓" : `${failures} 项 ✗`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
