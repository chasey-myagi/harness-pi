/**
 * 提交路由（纯函数，可测）——决定一条用户输入该 run / steer / 忽略。
 * 放弃 P0 的"运行中忽略"：运行中提交改走 steering（session.steer 插进下一 turn）。
 */

export type SubmitRoute =
  | { kind: "ignore" }
  | { kind: "run"; text: string } // 空闲：新开一轮 runStreaming
  | { kind: "steer"; text: string }; // 运行中：park 进 steering inbox

export function routeSubmit(text: string, running: boolean): SubmitRoute {
  const t = text.trim();
  if (t.length === 0) return { kind: "ignore" };
  return running ? { kind: "steer", text: t } : { kind: "run", text: t };
}
