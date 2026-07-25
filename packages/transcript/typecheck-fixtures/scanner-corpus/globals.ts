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
