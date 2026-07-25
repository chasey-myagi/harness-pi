// 以下形态必须**不**被误报：它们只是同名的属性/字段，不是宿主全局访问。
interface Shaped { process: string; Buffer: number }
declare const shaped: Shaped;
export const prop = shaped.process;
export const assigned = { process: 1, Buffer: 2 };
export const sig: Shaped = assigned as unknown as Shaped;
export type Qualified = Shaped["Buffer"];
