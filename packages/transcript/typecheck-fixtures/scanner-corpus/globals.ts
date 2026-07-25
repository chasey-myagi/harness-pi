export const bare = process.env;
export const buf = Buffer.alloc(1);
export const viaGlobalThis = globalThis.process.pid;
export const viaElementAccess = globalThis["Buffer"];
export const dir = __dirname;
export const file = __filename;
