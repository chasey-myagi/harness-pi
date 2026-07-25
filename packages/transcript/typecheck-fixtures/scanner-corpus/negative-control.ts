// 以下形态必须**不**被误报：它们只是同名的属性/方法/成员，不是宿主全局访问。
interface Shaped { process: string; Buffer: number }
declare const shaped: Shaped;
export const prop = shaped.process;
export const assigned = { process: 1, Buffer: 2 };
export const sig: Shaped = assigned as unknown as Shaped;
export type Qualified = Shaped["Buffer"];

// QualifiedName：`N.process` 里的 process 是 namespace 成员名，不是全局。
declare namespace N { const process: string; type Buffer = number }
export type ViaQualifiedName = N.Buffer;
export declare const viaQualifiedValue: typeof N.process;

// 方法名 / 类字段名 / enum 成员 / 解构重命名——#166 的真运行时代码很可能写到这些。
export interface WithMethods { process(e: string): void }
export class Projector { process(_e: string): void {} Buffer = 0 }
export enum Kind { process = "process", Buffer = "buffer" }
export const { process: renamed } = assigned;

// 从**非**宿主全局解构：`assigned` 是普通对象，这两条必须**不**被误报。
const { process: fromPlainRenamed } = assigned;
const { Buffer: fromPlainShorthand } = assigned;
export { fromPlainRenamed, fromPlainShorthand };

// ── 与 globals.ts 新增标本一一对应的负向对照：源对象是**普通对象**，必须不被误报 ──
declare const plainNested: { nested: { process: string }; list: Array<{ Buffer: number }> };
const { nested: { process: plainFromNested } } = plainNested;
const { list: [{ Buffer: plainFromArrayElement }] } = plainNested;
export function plainFromParam({ process: p } = assigned): unknown { return p; }
export { plainFromNested, plainFromArrayElement };

// ── 与 GLOBAL_OBJECTS 标本对应的负向对照：源对象**不是**宿主全局，必须不被误报 ──
// 少了这条，把 isHostGlobalObject 写成恒 true 也能让正向那几条通过。
declare const notAHostGlobal: { process: string; Buffer: number };
export const notViaHostGlobal = (notAHostGlobal as unknown as { process: unknown }).process;
export const notViaHostGlobalElem = notAHostGlobal["Buffer"];
