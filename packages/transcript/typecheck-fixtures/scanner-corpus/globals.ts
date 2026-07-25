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

// ── 第五轮 review 补：以下分支此前零标本，把实现退化成单层也能让测试全绿 ──

// `bindingSourceIsHostGlobal` 的**嵌套** binding pattern 出口。docstring 早就宣称支持
// 「`const { a: { process } } = globalThis`」，但没有任何标本钉住——把函数退化成
// `element.parent.parent` 的单层实现，原有两个标本照过。
const { nested: { process: fromNested } } = globalThis as unknown as {
  nested: { process: unknown };
};
// 它的 **ArrayBindingPattern** 出口。注意这里是「经数组元素再取属性名」——
// `const [process] = globalThis` 是按下标取值、**不是**一次 `.process` 读取，
// 那种形态不该被算作全局访问，所以标本写成嵌套形式。
const { list: [{ Buffer: fromArrayElement }] } = globalThis as unknown as {
  list: Array<{ Buffer: unknown }>;
};
// 它的 **Parameter** 出口（参数默认值形态）。
export function fromParam(
  { process: viaParam } = globalThis as unknown as { process: unknown },
): unknown {
  return viaParam;
}
// `unwrap` 的 NonNullExpression 分支（此前只有 Parenthesized 与 As 有标本）。
export const viaNonNull = globalThis!.Buffer;
// 元素访问的**模板字面量**形态：`isStringLiteral` 对它为假，修复前零命中。
export const viaTemplateKey = globalThis[`process`];
export { fromNested, fromArrayElement };
