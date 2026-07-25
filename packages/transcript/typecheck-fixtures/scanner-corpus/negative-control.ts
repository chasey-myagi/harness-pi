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
