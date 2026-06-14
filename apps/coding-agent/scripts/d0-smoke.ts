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
 *   D. budget-bound continuation(#82):小预算下 autoCompaction(X2)真触发,真 provider 吃压缩后视图续跑
 *      到 reason=done,且早期事实跨压缩存活。容忍型 provider 测不了 reactive overflow(见 C),改测这条
 *      provider-无关的等价路径——这是 #82 的真 provider 缺口所在。
 */
import { AgentSession, type HarnessTool } from "@harness-pi/core";
import { autoCompaction, estimateRequestTokens } from "@harness-pi/plugins";
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

// pi-ai 的 Message.content 可能是 string(user prompt)或 block 数组(assistant);两种都取出纯文本。
function textOf(m: { content?: unknown } | undefined): string {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .filter((b) => b && b.type === "text")
      .map((b) => b.text ?? "")
      .join(" ");
  }
  return "";
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

async function testD(): Promise<void> {
  console.log(`\n[D] budget-bound continuation:小预算下真 provider 跨自动压缩续跑 (model=${MODEL_ID})`);
  const { model, llmOptions } = resolveDashScopeModel(MODEL_ID, {
    DASHSCOPE_API_KEY: key,
  });

  const SECRET = "ZEBRA-42";
  let compactions = 0;
  let viewHadSummary = false;

  const session = new AgentSession({
    model,
    tools: [],
    systemPrompt: "You are a terse assistant. Always obey the user's reply-format instruction exactly.",
    llmOptions,
    maxTurns: 2,
    consoleSink: () => {},
    hooks: [
      // 小预算自动压缩(X2 #57):估算 token > maxContextTokens*triggerRatio 即把早期消息压成
      // 一条 summary + 保留 recent tail(view-only,不改 session.messages、不破坏 lineage)。
      autoCompaction({
        maxContextTokens: 900,
        triggerRatio: 0.6,
        keepRecent: 2,
        summarize: (early) => {
          compactions++;
          // 确定性 summary(不额外烧 LLM):保留早期 user 文本原文 → 秘密词随之进入压缩视图,
          // 用来验证「事实跨压缩存活 + 真 provider 接受压缩视图」。
          const earlyText = early.map((m) => textOf(m)).join(" ");
          return `[COMPACTED] earlier conversation preserved verbatim: ${earlyText}`;
        },
      }),
      // 观测哨兵:压缩触发后,真正发给 provider 的视图里应能看到 [COMPACTED]。
      // 注册在 autoCompaction 之后 → transform 管线里后跑 → 看到的是压缩后视图。
      {
        name: "d0-view-probe",
        transformMessagesBeforeLlm: (messages) => {
          if (messages.some((m) => textOf(m).includes("[COMPACTED]"))) {
            viewHadSummary = true;
          }
          return messages;
        },
      },
    ],
  });

  // 多轮纯文本 user turn(无 tool → 压缩切片不会切断 tool_use/tool_result 对):
  // turn-1 埋事实 → turn-2/3 灌填充把累计估算顶过预算阈值触发压缩 → 末轮要求跨压缩回忆。
  const filler = "Background note: the maintenance log records routine readings with no anomalies. ".repeat(40);
  const r1 = await session.run(`Remember this secret word: ${SECRET}. Reply with only: ok`);
  const r2 = await session.run(`${filler}\nReply with only: ok`);
  const r3 = await session.run(`${filler}\nReply with only: ok`);
  const rF = await session.run(
    "What was the secret word I told you at the very start? Reply with just that word, nothing else.",
  );
  const finalText = textOf(rF.lastMessage);

  // compactions===0 = 填充没顶过阈值、压缩根本没跑 → 这条 smoke 啥也没验,计为失败别假绿。
  check("autoCompaction 真触发(summarize 被调用)", compactions > 0, `compactions=${compactions}`);
  check("真 provider 收到的是压缩后视图([COMPACTED] 哨兵可见)", viewHadSummary);
  check("turn-1 reason=done", r1.reason === "done", `r1=${r1.reason}`);
  check("turn-2 reason=done(压缩中续跑)", r2.reason === "done", `r2=${r2.reason}`);
  check("turn-3 reason=done(压缩后续跑)", r3.reason === "done", `r3=${r3.reason}`);
  check("末轮 reason=done(跨压缩续跑收敛)", rF.reason === "done", `rF=${rF.reason}`);
  check(
    `秘密词跨压缩存活(最终回答含 ${SECRET})`,
    finalText.toUpperCase().includes("ZEBRA"),
    `final="${finalText.slice(0, 60)}"`,
  );
  console.log(`  · 末轮真 usage: input=${rF.usage.input} output=${rF.usage.output}`);
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
  try {
    await testD();
  } catch (err) {
    failures++;
    console.error("  ✗ [D] 抛异常:", err instanceof Error ? err.message : err);
  }
  console.log(`\n=== D0 smoke 结束:${failures === 0 ? "全部 ✓" : `${failures} 项 ✗`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
