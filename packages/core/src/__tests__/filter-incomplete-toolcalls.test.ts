import { describe, expect, it } from "vitest";
import { filterIncompleteToolCalls, type Message } from "../index.js";

// filterIncompleteToolCalls 只读 role / content / toolCallId / block.type / block.id，
// 故用最小构造（其余 provider/usage/stopReason 等字段无关，cast 掉）。
const user = (t: string): Message =>
  ({ role: "user", content: t, timestamp: 0 }) as unknown as Message;
const toolCall = (id: string) => ({ type: "toolCall", id, name: "read", arguments: {} });
const text = (t: string) => ({ type: "text", text: t });
const asst = (blocks: unknown[]): Message =>
  ({ role: "assistant", content: blocks, timestamp: 0 }) as unknown as Message;
const toolResult = (toolCallId: string): Message =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [],
    isError: false,
    timestamp: 0,
  }) as unknown as Message;

describe("filterIncompleteToolCalls", () => {
  it("丢掉含未被 result 的 toolCall 的 assistant（悬挂 tool_use）", () => {
    const msgs = [user("hi"), asst([text("calling"), toolCall("tc1")])];
    expect(filterIncompleteToolCalls(msgs)).toEqual([msgs[0]]);
  });

  it("保留所有 toolCall 都有 result 的 assistant", () => {
    const msgs = [user("hi"), asst([toolCall("tc1")]), toolResult("tc1")];
    expect(filterIncompleteToolCalls(msgs)).toHaveLength(3);
  });

  it("partial batch：整条 assistant 被丢 + 随之产生的 orphan result 也被丢", () => {
    // tc1 有 result、tc2 悬挂 → 整条 assistant 丢 → tc1 的 result 变 orphan → 丢
    const msgs = [
      user("hi"),
      asst([toolCall("tc1"), toolCall("tc2")]),
      toolResult("tc1"),
    ];
    expect(filterIncompleteToolCalls(msgs)).toEqual([msgs[0]]);
  });

  it("丢掉本就存在的 orphan toolResult（result 无对应 toolCall）", () => {
    const msgs = [user("hi"), toolResult("ghost")];
    expect(filterIncompleteToolCalls(msgs)).toEqual([msgs[0]]);
  });

  it("无悬挂时返回内容等价的新数组（始终 copy）", () => {
    const msgs = [user("hi"), asst([text("done")])];
    const out = filterIncompleteToolCalls(msgs);
    expect(out).toEqual(msgs);
    expect(out).not.toBe(msgs);
  });

  it("non-assistant 与纯文本 assistant 原样保留", () => {
    const msgs = [user("a"), asst([text("t")]), user("b")];
    expect(filterIncompleteToolCalls(msgs)).toEqual(msgs);
  });

  it("多 toolCall 全部 resolved 的 assistant 保留，其 result 不被误删", () => {
    const msgs = [
      user("hi"),
      asst([toolCall("tc1"), toolCall("tc2")]),
      toolResult("tc1"),
      toolResult("tc2"),
    ];
    expect(filterIncompleteToolCalls(msgs)).toHaveLength(4);
  });
});
