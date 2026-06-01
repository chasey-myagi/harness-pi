// SessionStore 适配器：在内核的 SessionStore 协议之上提供具体落盘实现（docs/09 §4.5）。
export { JsonlSessionStore } from "./jsonl-session-store.js";
export {
  PostgresSessionStore,
  POSTGRES_SESSION_STORE_DDL,
} from "./postgres-session-store.js";
export type { PgClient } from "./postgres-session-store.js";

// Event Bus → transport 适配器（§4.6）。
export { EventPump } from "./event-pump.js";
export type {
  TransportEnvelope,
  TransportSink,
  EventPumpOptions,
} from "./event-pump.js";
