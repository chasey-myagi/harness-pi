/**
 * lark-bot 运行配置。全部从环境变量读，给足默认值——零配置也能起（只要有
 * DEEPSEEK_API_KEY + 一个已就绪的飞书 bot 身份）。
 */

export type Identity = "bot" | "user";

type Env = Record<string, string | undefined>;

export interface BotConfig {
  /** pi-ai 模型 spec：`provider:modelId`。默认 deepseek-v4-flash。 */
  modelSpec: string;
  /** 订阅的事件 key。默认接收 IM 消息。 */
  eventKey: string;
  /** 事件消费 + 默认回复的身份。bot（机器人是对话里的实体）。 */
  identity: Identity;
  /** lark_cli 工具默认身份。user = 代表主人本人访问其私有数据（消息/文档/日历/邮件/任务）。
   *  agent 可按调用覆盖（如以 bot 名义发消息）。 */
  toolIdentity: Identity;
  /** 仅响应该 open_id（ou_…）发来的消息；设了即过滤其他发件人。user 身份代表主人操作，
   *  必须锁定本人，否则别人 DM 也会被以主人身份执行。空 = 不限制（仅自用时可空）。 */
  ownerOpenId: string | undefined;
  /** 观测/评测数据落盘目录（sessionLog trace + metrics NDJSON）。 */
  dataDir: string;
  /** 是否挂观测插件（sessionLog/metrics/costTracker/toolStats）。默认 true。 */
  telemetry: boolean;
  /** lark-cli 可执行文件名/路径。 */
  larkCliBin: string;
  /** 系统提示词——只管人设/性格/身份。"怎么做" 不写死，靠交互 + 记忆沉淀涌现。 */
  systemPrompt: string;
  /** 自生长记忆文件（markdown）。bot 用 remember 工具往里沉淀，每轮注入回 prompt。可手动编辑。 */
  memoryFile: string;
  /** 单轮对话最大 turn 数（防失控）。 */
  maxTurns: number;
  /** 是否响应群消息。v1 默认 false（只回私聊，避免群里刷屏 + 回环）。 */
  respondInGroups: boolean;
  /** 去重窗口容量（按 event_id 去重，飞书会重投）。 */
  dedupCapacity: number;
  /** 缓存的会话数上限（按 chat 维度，LRU 淘汰，控内存）。 */
  maxSessions: number;
  /** 单次 lark-cli 调用超时（ms）。 */
  toolTimeoutMs: number;
  /** 工具输出回灌给 LLM 的字符上限（防 context 爆）。 */
  toolOutputCap: number;
  /** 允许 lark_cli 工具调用的命令家族白名单（首 token）。 */
  allowedFamilies: string[];
  /** 是否允许破坏性命令（默认 false：撞 destructivePatterns 直接拦）。 */
  allowDestructive: boolean;
  /** 破坏性命令子串黑名单（小写匹配整条 args）。 */
  destructivePatterns: string[];
}

/** bot 身份可安全驱动的命令家族（读 + 编排 + 发送）。刻意不含 auth/event/config 等
 *  会动到 bot 自身管线或凭证的家族。 */
const DEFAULT_ALLOWED_FAMILIES = [
  "im",
  "docx",
  "docs",
  "sheets",
  "base",
  "calendar",
  "mail",
  "task",
  "wiki",
  "drive",
  "contact",
  "vc",
  "minutes",
  "approval",
  "board",
  "whiteboard",
  "okr",
  "attendance",
  "slides",
  "search",
];

const DEFAULT_DESTRUCTIVE = [
  "delete",
  "disband",
  "recall",
  "remove",
  "logout",
  "revoke",
  "--purge",
];

/**
 * 人设 prompt——**只**定义"我是谁、什么性格"，不写"该怎么做"的细则（资源在哪、命令怎么拼、
 * 失败怎么兜底都不写）。这些靠日常交互 + 记忆沉淀涌现。能力只点到为止，让它自己探、自己记。
 */
const DEFAULT_SYSTEM_PROMPT = [
  "你是 Chasey（叶炜鸿）的私人飞书助手——他「Agent OS」的对话门面。跑在 harness-pi 内核上，大脑是 deepseek-v4-flash。",
  "",
  "你的本事：一套 lark-cli 全家桶工具，可用 `user` 身份代表主人操作他的飞书（消息、文档、日历、邮件、任务、多维表、知识库…），或 `bot` 身份以助手名义行事；还能用 `remember` 把学到的东西记下来。",
  "",
  "你的性格与做事方式：",
  "- 中文，简洁，先给结论。",
  "- 诚实第一：不知道、没查到、没权限，就直说，绝不编。",
  "- 不熟的事先自己探查飞书（搜文档、列日程、看 `--help`），别张口就猜。",
  "- 被主人纠正、或摸清了某类事该怎么查/怎么做，就用 `remember` 沉淀下来——下次直接照做，越用越懂主人。",
].join("\n");

function readNumber(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function loadConfig(env: Env = process.env): BotConfig {
  const identityRaw = env.LARK_BOT_IDENTITY?.trim();
  const toolIdentityRaw = env.LARK_BOT_TOOL_IDENTITY?.trim();
  const dataDir = env.LARK_BOT_DATA_DIR?.trim() || "data";
  const families = env.LARK_BOT_ALLOWED_FAMILIES?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    modelSpec: env.LARK_BOT_MODEL?.trim() || "deepseek:deepseek-v4-flash",
    eventKey: env.LARK_BOT_EVENT_KEY?.trim() || "im.message.receive_v1",
    identity: identityRaw === "user" ? "user" : "bot",
    toolIdentity: toolIdentityRaw === "bot" ? "bot" : "user",
    ownerOpenId: env.LARK_BOT_OWNER_OPEN_ID?.trim() || undefined,
    dataDir,
    telemetry: readBool(env, "LARK_BOT_TELEMETRY", true),
    larkCliBin: env.LARK_BOT_CLI?.trim() || "lark-cli",
    systemPrompt: env.LARK_BOT_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
    memoryFile: env.LARK_BOT_MEMORY_FILE?.trim() || `${dataDir}/memory.md`,
    maxTurns: readNumber(env, "LARK_BOT_MAX_TURNS", 24),
    respondInGroups: readBool(env, "LARK_BOT_GROUPS", false),
    dedupCapacity: readNumber(env, "LARK_BOT_DEDUP", 2000),
    maxSessions: readNumber(env, "LARK_BOT_MAX_SESSIONS", 50),
    toolTimeoutMs: readNumber(env, "LARK_BOT_TOOL_TIMEOUT_MS", 60_000),
    toolOutputCap: readNumber(env, "LARK_BOT_TOOL_OUTPUT_CAP", 12_000),
    allowedFamilies: families && families.length > 0 ? families : DEFAULT_ALLOWED_FAMILIES,
    allowDestructive: readBool(env, "LARK_BOT_ALLOW_DESTRUCTIVE", false),
    destructivePatterns: DEFAULT_DESTRUCTIVE,
  };
}
