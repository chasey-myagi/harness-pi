export const bare = process.env;
export const buf = Buffer.alloc(1);
export const viaGlobalThis = globalThis.process.pid;
export const viaElementAccess = globalThis["Buffer"];
export const dir = __dirname;
export const file = __filename;
// 经 cast 绕过：父表达式是 AsExpression，裸 Identifier 判据看不见它；而 browser 门也管不着
// （类型是 any）。这恰恰是 node 全局真实混进浏览器包的经典写法。
export const viaCast = (globalThis as unknown as { process: { pid: number } }).process.pid;
export const viaParens = (globalThis).Buffer;
// 简写属性：`{ process }` 的 name 位承载的是**值引用**，不是声明名。
export const shorthandLeak = { process, Buffer };
// 从 cast 后的宿主全局解构：同时溜过扫描器与 browser 门（类型是 unknown），
// 是 viaCast 那条注释所说「经典写法」的解构形态。
const { process: fromGlobalRenamed } = globalThis as unknown as { process: unknown };
const { Buffer: fromGlobalShorthand } = globalThis as unknown as { Buffer: unknown };
export { fromGlobalRenamed, fromGlobalShorthand };
