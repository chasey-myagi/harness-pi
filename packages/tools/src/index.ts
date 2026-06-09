import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type, type HarnessTool, type ToolExecResult } from "@harness-pi/core";
import {
  escapeRegExp,
  globToRegExp,
  hasGlobMagic,
  normalizeDisplayPath,
  resolveToolPath,
  toDisplayPath,
} from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  estimateReadTokens,
  formatSize,
  truncateHead,
  truncateLine,
  truncateTail,
  type TruncationResult,
} from "./truncate.js";

export const toolNames = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export type ToolName = (typeof toolNames)[number];

export const codingToolNames = ["read", "bash", "edit", "write"] as const;
export const readOnlyToolNames = ["read", "grep", "find", "ls"] as const;

export interface ToolsOptions {
  disabled?: ToolName[];
  read?: ReadToolOptions;
  bash?: BashToolOptions;
  edit?: EditToolOptions;
  write?: WriteToolOptions;
  grep?: GrepToolOptions;
  find?: FindToolOptions;
  ls?: LsToolOptions;
}

export interface ReadOperations {
  access(filePath: string): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  detectImageMimeType?(filePath: string): Promise<string | null | undefined>;
}

export interface ReadToolOptions {
  autoResizeImages?: boolean;
  allowOutsideCwd?: boolean;
  operations?: Partial<ReadOperations>;
  maxLines?: number;
  maxBytes?: number;
}

export interface BashExecResult {
  exitCode: number | null;
}

export interface BashExecOptions {
  onData: (data: Buffer) => void;
  timeout?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface BashOperations {
  exec(
    command: string,
    cwd: string,
    options: BashExecOptions,
  ): Promise<BashExecResult>;
}

export interface BashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashToolOptions {
  operations?: Partial<BashOperations>;
  commandPrefix?: string;
  spawnHook?: BashSpawnHook;
  /** Timeout in seconds. Default 120s; set null to disable. */
  defaultTimeout?: number | null;
  env?: NodeJS.ProcessEnv;
  maxLines?: number;
  maxBytes?: number;
}

export interface EditOperations {
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, content: string): Promise<void>;
  access(filePath: string): Promise<void>;
}

export interface EditToolOptions {
  allowOutsideCwd?: boolean;
  operations?: Partial<EditOperations>;
}

export interface WriteOperations {
  mkdir(dirPath: string): Promise<void>;
  writeFile(filePath: string, content: string): Promise<void>;
}

export interface WriteToolOptions {
  allowOutsideCwd?: boolean;
  operations?: Partial<WriteOperations>;
}

export interface GrepOperations {
  isDirectory(targetPath: string): Promise<boolean> | boolean;
  readFile(filePath: string): Promise<string> | string;
  listFiles?(dirPath: string): Promise<string[]> | string[];
}

export interface GrepToolOptions {
  allowOutsideCwd?: boolean;
  operations?: Partial<GrepOperations>;
  defaultLimit?: number;
  maxOutputLines?: number;
  maxOutputBytes?: number;
}

export interface FindOperations {
  exists(targetPath: string): Promise<boolean> | boolean;
  glob(
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ): Promise<string[]> | string[];
}

export interface FindToolOptions {
  allowOutsideCwd?: boolean;
  operations?: Partial<FindOperations>;
  defaultLimit?: number;
  maxOutputLines?: number;
  maxOutputBytes?: number;
}

export interface LsOperations {
  exists(targetPath: string): Promise<boolean> | boolean;
  stat(
    targetPath: string,
  ): Promise<{ isDirectory(): boolean }> | { isDirectory(): boolean };
  readdir(targetPath: string): Promise<string[]> | string[];
}

export interface LsToolOptions {
  allowOutsideCwd?: boolean;
  operations?: Partial<LsOperations>;
  defaultLimit?: number;
  maxOutputLines?: number;
  maxOutputBytes?: number;
}

export interface ReadToolDetails {
  truncation?: TruncationResult | undefined;
}

export interface BashToolDetails {
  truncation?: TruncationResult | undefined;
  fullOutputPath?: string | undefined;
}

export interface EditToolDetails {
  diff: string;
  firstChangedLine?: number | undefined;
}

export interface GrepToolDetails {
  truncation?: TruncationResult | undefined;
  matchLimitReached?: number | undefined;
  linesTruncated?: boolean | undefined;
}

export interface FindToolDetails {
  truncation?: TruncationResult | undefined;
  resultLimitReached?: number | undefined;
}

export interface LsToolDetails {
  truncation?: TruncationResult | undefined;
  entryLimitReached?: number | undefined;
}

export function createReadTool(
  cwd: string,
  options: ReadToolOptions = {},
): HarnessTool {
  const ops: ReadOperations = {
    access: (filePath) => access(filePath),
    readFile: (filePath) => readFile(filePath),
    detectImageMimeType: defaultDetectImageMimeType,
    ...options.operations,
  };

  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
      maxTokens: Type.Optional(Type.Number({ description: "If the estimated token count of the content exceeds this, return a short error instead of content. Re-read a smaller range with offset+limit." })),
    }),
    isConcurrencySafe: () => true,
    async execute(args, _ctx, signal) {
      throwIfAborted(signal);
      const requestedPath = asString(args["path"], "path");
      const target = resolveToolPath(cwd, requestedPath, {
        allowOutsideCwd: options.allowOutsideCwd,
      });
      await ops.access(target);

      const mimeType = await ops.detectImageMimeType?.(target);
      if (mimeType) {
        const data = await ops.readFile(target);
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            {
              type: "image",
              data: data.toString("base64"),
              mimeType,
            },
          ],
        };
      }

      const text = (await ops.readFile(target)).toString("utf8");
      const output = buildReadTextOutput({
        text,
        requestedPath,
        offset: asOptionalPositiveInteger(args["offset"], "offset"),
        limit: asOptionalPositiveInteger(args["limit"], "limit"),
        maxTokens: asOptionalPositiveInteger(args["maxTokens"], "maxTokens"),
        maxLines: options.maxLines,
        maxBytes: options.maxBytes,
      });
      return withOptionalDetails(
        [{ type: "text", text: output.text }],
        detailObject({ truncation: output.truncation }),
      );
    },
  };
}

export function createBashTool(
  cwd: string,
  options: BashToolOptions = {},
): HarnessTool {
  const ops: BashOperations = {
    exec: defaultExec,
    ...options.operations,
  };

  return {
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Timeout is in seconds.`,
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
    }),
    isConcurrencySafe: () => false,
    async execute(args, _ctx, signal) {
      throwIfAborted(signal);
      const rawCommand = asString(args["command"], "command");
      const command = options.commandPrefix
        ? `${options.commandPrefix}\n${rawCommand}`
        : rawCommand;
      const timeout =
        asOptionalPositiveInteger(args["timeout"], "timeout") ??
        (options.defaultTimeout === null ? undefined : options.defaultTimeout ?? 120);
      const output = createRollingOutputBuffer(options.maxBytes ?? DEFAULT_MAX_BYTES);
      const spawnContext = options.spawnHook
        ? options.spawnHook({ command, cwd, env: options.env ?? safeShellEnv() })
        : { command, cwd, env: options.env ?? safeShellEnv() };

      try {
        const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
          onData: (data) => output.push(data),
          ...(timeout !== undefined ? { timeout } : {}),
          signal,
          env: spawnContext.env,
        });
        await output.close();
        const text = output.text();
        if (result.exitCode === null) {
          throw new Error(`Command failed: killed by signal${text ? `\n${text}` : ""}`);
        }
        if (result.exitCode !== 0) {
          throw new Error(
            `${text}${text ? "\n\n" : ""}Command exited with code ${result.exitCode}`,
          );
        }
        const truncation = truncateTail(text, {
          maxLines: options.maxLines,
          maxBytes: options.maxBytes,
        });
        const details: BashToolDetails = {};
        if (truncation.truncated || output.fullOutputPath) {
          details.truncation = truncation;
        }
        if (output.fullOutputPath) {
          details.fullOutputPath = output.fullOutputPath;
        }
        return withOptionalDetails(
          [{ type: "text", text: truncation.content || "(no output)" }],
          detailObject(details),
        );
      } catch (err) {
        await output.close();
        throw err;
      }
    },
  };
}

export function createEditTool(
  cwd: string,
  options: EditToolOptions = {},
): HarnessTool {
  const ops: EditOperations = {
    access: (filePath) => access(filePath),
    readFile: (filePath) => readFile(filePath),
    writeFile: (filePath, content) => writeFile(filePath, content, "utf8"),
    ...options.operations,
  };

  return {
    name: "edit",
    label: "edit",
    description: "Replace a unique text range in an existing file.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to edit" }),
      oldText: Type.String({ description: "Existing text to replace" }),
      newText: Type.String({ description: "Replacement text" }),
    }),
    isConcurrencySafe: () => false,
    async execute(args, _ctx, signal) {
      throwIfAborted(signal);
      const target = resolveToolPath(cwd, asString(args["path"], "path"), {
        allowOutsideCwd: options.allowOutsideCwd,
      });
      const oldText = asString(args["oldText"], "oldText");
      const newText = asString(args["newText"], "newText");
      if (oldText.length === 0) throw new Error("oldText must not be empty");

      await ops.access(target);
      const before = (await ops.readFile(target)).toString("utf8");
      const first = before.indexOf(oldText);
      if (first < 0) throw new Error(`oldText not found in ${toDisplayPath(cwd, target)}`);
      if (before.indexOf(oldText, first + oldText.length) >= 0) {
        throw new Error(`oldText appears multiple times in ${toDisplayPath(cwd, target)}`);
      }

      const after = before.slice(0, first) + newText + before.slice(first + oldText.length);
      await ops.writeFile(target, after);
      const firstChangedLine = countLines(before.slice(0, first)) + 1;
      const displayPath = toDisplayPath(cwd, target);
      return {
        content: [
          { type: "text", text: `File edited successfully: ${displayPath}` },
        ],
        details: {
          diff: simpleDiff(displayPath, oldText, newText, firstChangedLine),
          firstChangedLine,
        } satisfies EditToolDetails,
      };
    },
  };
}

export function createWriteTool(
  cwd: string,
  options: WriteToolOptions = {},
): HarnessTool {
  const ops: WriteOperations = {
    mkdir: (dirPath) => mkdir(dirPath, { recursive: true }).then(() => undefined),
    writeFile: (filePath, content) => writeFile(filePath, content, "utf8"),
    ...options.operations,
  };

  return {
    name: "write",
    label: "write",
    description: "Write a complete file to disk, creating parent directories as needed.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to write" }),
      content: Type.String({ description: "Complete file content" }),
    }),
    isConcurrencySafe: () => false,
    async execute(args, _ctx, signal) {
      throwIfAborted(signal);
      const target = resolveToolPath(cwd, asString(args["path"], "path"), {
        allowOutsideCwd: options.allowOutsideCwd,
      });
      await ops.mkdir(path.dirname(target));
      await ops.writeFile(target, asString(args["content"], "content"));
      return {
        content: [
          { type: "text", text: `File written successfully: ${toDisplayPath(cwd, target)}` },
        ],
      };
    },
  };
}

export function createGrepTool(
  cwd: string,
  options: GrepToolOptions = {},
): HarnessTool {
  const usingCustomOps = !!options.operations;
  const hasCustomListFiles = !!options.operations?.listFiles;
  const ops: GrepOperations = {
    isDirectory: async (targetPath) => (await stat(targetPath)).isDirectory(),
    readFile: (filePath) => readFile(filePath, "utf8"),
    listFiles: (dirPath) => defaultListFiles(dirPath, cwd),
    ...options.operations,
  };

  return {
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to ${options.defaultLimit ?? 100} matches or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
      glob: Type.Optional(Type.String({ description: "Filter files by glob pattern" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex" })),
      context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return" })),
    }),
    isConcurrencySafe: () => true,
    async execute(args, _ctx, signal) {
      throwIfAborted(signal);
      const target = resolveToolPath(cwd, optionalString(args["path"]) ?? ".", {
        allowOutsideCwd: options.allowOutsideCwd,
      });
      const limit = asOptionalPositiveInteger(args["limit"], "limit") ?? options.defaultLimit ?? 100;
      if (limit === 0) return { content: [{ type: "text", text: "No matches found" }] };
      const context = asOptionalPositiveInteger(args["context"], "context") ?? 0;
      const regex = new RegExp(
        args["literal"] ? escapeRegExp(asString(args["pattern"], "pattern")) : asString(args["pattern"], "pattern"),
        args["ignoreCase"] ? "i" : undefined,
      );
      const files = await filesForGrep({
        cwd,
        target,
        glob: optionalString(args["glob"]),
        ops,
        usingCustomOps,
        hasCustomListFiles,
      });
      const matches: GrepMatch[] = [];
      let matchLimitReached: number | undefined;
      for (const file of files) {
        throwIfAborted(signal);
        const content = await safeReadText(ops, file);
        if (content === undefined) continue;
        collectGrepMatches(content, regex, toDisplayPath(cwd, file), limit, matches);
        if (matches.length >= limit) {
          matchLimitReached = limit;
          break;
        }
      }
      if (matches.length === 0) return { content: [{ type: "text", text: "No matches found" }] };

      const formatted = formatGrepMatches(matches, context);
      const truncation = truncateHead(formatted.lines.join("\n"), {
        maxLines: options.maxOutputLines ?? Number.MAX_SAFE_INTEGER,
        maxBytes: options.maxOutputBytes,
      });
      return withOptionalDetails(
        [{ type: "text", text: truncation.content }],
        detailObject({
          truncation: truncation.truncated ? truncation : undefined,
          matchLimitReached,
          linesTruncated: formatted.linesTruncated || undefined,
        } satisfies GrepToolDetails),
      );
    },
  };
}

export function createFindTool(
  cwd: string,
  options: FindToolOptions = {},
): HarnessTool {
  const ops: FindOperations = {
    exists: async (targetPath) => {
      try {
        await access(targetPath);
        return true;
      } catch {
        return false;
      }
    },
    glob: (pattern, root, globOptions) => defaultFindGlob(pattern, root, cwd, globOptions),
    ...options.operations,
  };

  return {
    name: "find",
    label: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the workspace cwd. Output is truncated to ${options.defaultLimit ?? 1_000} results or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern to match files" }),
      path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
    }),
    isConcurrencySafe: () => true,
    async execute(args, _ctx, signal) {
      throwIfAborted(signal);
      const root = resolveToolPath(cwd, optionalString(args["path"]) ?? ".", {
        allowOutsideCwd: options.allowOutsideCwd,
      });
      if (!(await ops.exists(root))) throw new Error(`path not found: ${toDisplayPath(cwd, root)}`);
      const limit = asOptionalPositiveInteger(args["limit"], "limit") ?? options.defaultLimit ?? 1_000;
      const raw = await ops.glob(asString(args["pattern"], "pattern"), root, {
        ignore: ["**/node_modules/**", "**/.git/**"],
        limit: limit + 1,
      });
      const normalized = raw.map((p) => normalizeFindResult(cwd, root, p));
      const resultLimitReached = normalized.length > limit ? limit : undefined;
      const selected = normalized.slice(0, limit);
      if (selected.length === 0) {
        return { content: [{ type: "text", text: "No files found matching pattern" }] };
      }
      const truncation = truncateHead(selected.join("\n"), {
        maxLines: options.maxOutputLines ?? Number.MAX_SAFE_INTEGER,
        maxBytes: options.maxOutputBytes,
      });
      return withOptionalDetails(
        [{ type: "text", text: truncation.content }],
        detailObject({
          truncation: truncation.truncated ? truncation : undefined,
          resultLimitReached,
        } satisfies FindToolDetails),
      );
    },
  };
}

export function createLsTool(
  cwd: string,
  options: LsToolOptions = {},
): HarnessTool {
  const ops: LsOperations = {
    exists: async (targetPath) => {
      try {
        await access(targetPath);
        return true;
      } catch {
        return false;
      }
    },
    stat: (targetPath) => stat(targetPath),
    readdir: (targetPath) => readdir(targetPath),
    ...options.operations,
  };

  return {
    name: "ls",
    label: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Output is truncated to ${options.defaultLimit ?? 500} entries or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return" })),
    }),
    isConcurrencySafe: () => true,
    async execute(args, _ctx, signal) {
      throwIfAborted(signal);
      const target = resolveToolPath(cwd, optionalString(args["path"]) ?? ".", {
        allowOutsideCwd: options.allowOutsideCwd,
      });
      if (!(await ops.exists(target))) throw new Error(`path not found: ${toDisplayPath(cwd, target)}`);
      if (!(await ops.stat(target)).isDirectory()) {
        throw new Error(`path is not a directory: ${toDisplayPath(cwd, target)}`);
      }
      const limit = asOptionalPositiveInteger(args["limit"], "limit") ?? options.defaultLimit ?? 500;
      const rawEntries = (await ops.readdir(target)).sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      );
      const entries: string[] = [];
      let entryLimitReached: number | undefined;
      for (const entry of rawEntries) {
        if (entries.length >= limit) {
          entryLimitReached = limit;
          break;
        }
        try {
          const entryStat = await ops.stat(path.join(target, entry));
          entries.push(`${entry}${entryStat.isDirectory() ? "/" : ""}`);
        } catch {
          continue;
        }
      }
      if (entries.length === 0) return { content: [{ type: "text", text: "(empty directory)" }] };

      const truncation = truncateHead(entries.join("\n"), {
        maxLines: options.maxOutputLines ?? Number.MAX_SAFE_INTEGER,
        maxBytes: options.maxOutputBytes,
      });
      let text = truncation.content;
      if (entryLimitReached) {
        text += `\n\n[${entryLimitReached} entries limit reached. Use limit=${entryLimitReached * 2} for more]`;
      }
      return withOptionalDetails(
        [{ type: "text", text }],
        detailObject({
          truncation: truncation.truncated ? truncation : undefined,
          entryLimitReached,
        } satisfies LsToolDetails),
      );
    },
  };
}

export function createAllTools(
  cwd: string,
  options: ToolsOptions = {},
): Record<ToolName, HarnessTool> {
  return {
    read: createReadTool(cwd, options.read),
    bash: createBashTool(cwd, options.bash),
    edit: createEditTool(cwd, options.edit),
    write: createWriteTool(cwd, options.write),
    grep: createGrepTool(cwd, options.grep),
    find: createFindTool(cwd, options.find),
    ls: createLsTool(cwd, options.ls),
  };
}

export function createCodingTools(
  cwd: string,
  options: ToolsOptions = {},
): HarnessTool[] {
  const all = createAllTools(cwd, options);
  return filterDisabled(codingToolNames.map((name) => all[name]), options.disabled);
}

export function createReadOnlyTools(
  cwd: string,
  options: ToolsOptions = {},
): HarnessTool[] {
  const all = createAllTools(cwd, options);
  return filterDisabled(readOnlyToolNames.map((name) => all[name]), options.disabled);
}

export const readTool = createReadTool(process.cwd());
export const bashTool = createBashTool(process.cwd());
export const editTool = createEditTool(process.cwd());
export const writeTool = createWriteTool(process.cwd());
export const grepTool = createGrepTool(process.cwd());
export const findTool = createFindTool(process.cwd());
export const lsTool = createLsTool(process.cwd());
export const allTools = {
  read: readTool,
  bash: bashTool,
  edit: editTool,
  write: writeTool,
  grep: grepTool,
  find: findTool,
  ls: lsTool,
} as const;
export const codingTools = [readTool, bashTool, editTool, writeTool] as const;
export const readOnlyTools = [readTool, grepTool, findTool, lsTool] as const;

interface ReadTextOutput {
  text: string;
  truncation?: TruncationResult | undefined;
}

interface GrepMatch {
  fileLabel: string;
  lines: string[];
  lineNumber: number;
}

interface GitIgnoreRule {
  pattern: string;
  baseRel: string;
  negated: boolean;
  anchored: boolean;
  dirOnly: boolean;
}

function buildReadTextOutput(opts: {
  text: string;
  requestedPath: string;
  offset?: number | undefined;
  limit?: number | undefined;
  maxTokens?: number | undefined;
  maxLines?: number | undefined;
  maxBytes?: number | undefined;
}): ReadTextOutput {
  const allLines = opts.text.split("\n");
  const totalFileLines = allLines.length;
  const startLine = opts.offset ? Math.max(0, opts.offset - 1) : 0;
  if (opts.offset !== undefined && startLine >= totalFileLines) {
    throw new Error(`Offset ${opts.offset} is beyond end of file (${totalFileLines} lines total)`);
  }
  const startLineDisplay = startLine + 1;
  let selected: string;
  let userLimitedLines: number | undefined;
  if (opts.limit !== undefined) {
    const endLine = Math.min(startLine + opts.limit, totalFileLines);
    selected = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selected = allLines.slice(startLine).join("\n");
  }

  if (opts.maxTokens !== undefined) {
    const estimated = estimateReadTokens(selected, opts.requestedPath);
    if (estimated > opts.maxTokens) {
      throw new Error(
        `Content ~${estimated} tokens exceeds maxTokens=${opts.maxTokens}. Retry with offset+limit to read in smaller chunks.`,
      );
    }
  }

  const truncation = truncateHead(selected, {
    maxLines: opts.maxLines,
    maxBytes: opts.maxBytes,
  });
  if (truncation.firstLineExceedsLimit) {
    const firstLine = allLines[startLine] ?? "";
    const firstLineSize = formatSize(Buffer.byteLength(firstLine, "utf8"));
    return {
      text: `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(truncation.maxBytes)} limit. Use bash: sed -n '${startLineDisplay}p' ${opts.requestedPath} | head -c ${truncation.maxBytes}]`,
      truncation,
    };
  }
  if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    const reason =
      truncation.truncatedBy === "lines"
        ? `Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}`
        : `Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(truncation.maxBytes)} limit)`;
    return {
      text: `${truncation.content}\n\n[${reason}. Use offset=${nextOffset} to continue.]`,
      truncation,
    };
  }
  if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
    const remaining = totalFileLines - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    return {
      text: `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`,
    };
  }
  return { text: truncation.content };
}

function filterDisabled(
  tools: readonly HarnessTool[],
  disabled: ToolName[] | undefined,
): HarnessTool[] {
  if (!disabled || disabled.length === 0) return [...tools];
  const blocked = new Set(disabled);
  return tools.filter((tool) => !blocked.has(tool.name as ToolName));
}

async function defaultDetectImageMimeType(filePath: string): Promise<string | undefined> {
  let header: Buffer;
  try {
    header = await readFile(filePath, { flag: "r" }).then((b) => b.subarray(0, 12));
  } catch {
    return undefined;
  }
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function defaultExec(
  command: string,
  cwd: string,
  options: BashExecOptions,
): Promise<BashExecResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let termination: "abort" | "timeout" | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, {
      cwd,
      detached: process.platform !== "win32",
      shell: true,
      env: options.env ?? safeShellEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (rejectTimer) clearTimeout(rejectTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const terminate = (reason: "abort" | "timeout"): void => {
      if (settled) return;
      termination ??= reason;
      killProcessGroup(child.pid, "SIGTERM");
      killTimer ??= setTimeout(() => {
        killProcessGroup(child.pid, "SIGKILL");
      }, 1_500);
      rejectTimer ??= setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              termination === "timeout" ? `timeout:${options.timeout}` : "aborted",
            ),
          ),
        );
      }, 5_000);
    };
    timeoutTimer =
      options.timeout === undefined || options.timeout <= 0
        ? undefined
        : setTimeout(() => {
            terminate("timeout");
          }, options.timeout * 1_000);
    const onAbort = (): void => {
      terminate("abort");
    };
    if (options.signal?.aborted) {
      terminate("abort");
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer) => options.onData(chunk));
    child.stderr?.on("data", (chunk: Buffer) => options.onData(chunk));
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      finish(() => {
        if (termination === "abort") reject(new Error("aborted"));
        else if (termination === "timeout") reject(new Error(`timeout:${options.timeout}`));
        else resolve({ exitCode: code });
      });
    });
  });
}

function safeShellEnv(): NodeJS.ProcessEnv {
  const blocked = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !blocked.test(key)),
  ) as NodeJS.ProcessEnv;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // best effort
    }
  }
}

function createRollingOutputBuffer(maxBytes: number): {
  fullOutputPath?: string | undefined;
  push(data: Buffer): void;
  text(): string;
  close(): Promise<void>;
} {
  const chunks: Buffer[] = [];
  let chunkBytes = 0;
  let totalBytes = 0;
  let fullOutputPath: string | undefined;
  let stream: WriteStream | undefined;
  const maxBufferedBytes = maxBytes * 2;
  return {
    get fullOutputPath() {
      return fullOutputPath;
    },
    push(data: Buffer) {
      totalBytes += data.length;
      if (totalBytes > maxBytes && !fullOutputPath) {
        fullOutputPath = path.join(
          tmpdir(),
          `harness-pi-bash-${randomBytes(8).toString("hex")}.log`,
        );
        stream = createWriteStream(fullOutputPath);
        for (const chunk of chunks) stream.write(chunk);
      }
      stream?.write(data);
      chunks.push(data);
      chunkBytes += data.length;
      while (chunkBytes > maxBufferedBytes && chunks.length > 1) {
        const removed = chunks.shift();
        if (removed) chunkBytes -= removed.length;
      }
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    close() {
      return new Promise<void>((resolve) => {
        if (!stream) {
          resolve();
          return;
        }
        stream.end(() => resolve());
      });
    },
  };
}

async function filesForGrep(opts: {
  cwd: string;
  target: string;
  glob?: string | undefined;
  ops: GrepOperations;
  usingCustomOps: boolean;
  hasCustomListFiles: boolean;
}): Promise<string[]> {
  if (!(await opts.ops.isDirectory(opts.target))) return [opts.target];
  if (opts.usingCustomOps && !opts.hasCustomListFiles) {
    throw new Error("grep operations override for directories must provide listFiles");
  }
  const files = await opts.ops.listFiles?.(opts.target);
  if (!files) throw new Error("grep directory search requires listFiles");
  const absolute = files.map((file) =>
    path.isAbsolute(file) ? file : path.resolve(opts.target, file),
  );
  if (!opts.glob) return absolute;
  const matcher = matcherForPattern(opts.glob);
  return absolute.filter((file) => matcher(toDisplayPath(opts.cwd, file), path.basename(file)));
}

async function defaultListFiles(root: string, workspaceCwd: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, inheritedRules: GitIgnoreRule[]): Promise<void> {
    const rules = inheritedRules.concat(await loadGitIgnoreRules(dir, workspaceCwd));
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      const relToWorkspace = normalizeDisplayPath(path.relative(workspaceCwd, full));
      if (isIgnored(relToWorkspace, entry.isDirectory(), rules)) continue;
      if (entry.isDirectory()) await walk(full, rules);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(root, await loadAncestorGitIgnoreRules(root, workspaceCwd));
  return out.sort((a, b) => a.localeCompare(b));
}

async function loadAncestorGitIgnoreRules(
  root: string,
  workspaceCwd: string,
): Promise<GitIgnoreRule[]> {
  const workspace = path.resolve(workspaceCwd);
  const target = path.resolve(root);
  const rel = path.relative(workspace, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [];

  const rules: GitIgnoreRule[] = [];
  let current = workspace;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    rules.push(...await loadGitIgnoreRules(current, workspaceCwd));
    current = path.join(current, segment);
  }
  return rules;
}

async function loadGitIgnoreRules(dir: string, workspaceCwd: string): Promise<GitIgnoreRule[]> {
  try {
    const content = await readFile(path.join(dir, ".gitignore"), "utf8");
    const baseRel = normalizeDisplayPath(path.relative(workspaceCwd, dir));
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const negated = line.startsWith("!");
        const raw = negated ? line.slice(1) : line;
        const anchored = raw.startsWith("/");
        const dirOnly = raw.endsWith("/");
        return {
          pattern: raw.replace(/^\//, "").replace(/\/+$/, ""),
          baseRel,
          negated,
          anchored,
          dirOnly,
        };
      })
      .filter((rule) => rule.pattern.length > 0);
  } catch {
    return [];
  }
}

function isIgnored(rel: string, isDir: boolean, rules: GitIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (matchesGitIgnoreRule(rel, isDir, rule)) ignored = !rule.negated;
  }
  return ignored;
}

function matchesGitIgnoreRule(rel: string, isDir: boolean, rule: GitIgnoreRule): boolean {
  const relFromBase = relRelativeToIgnoreBase(rel, rule.baseRel);
  if (relFromBase === undefined) return false;
  const segments = relFromBase.split("/").filter(Boolean);
  const basename = segments[segments.length - 1] ?? relFromBase;

  if (!hasGlobMagic(rule.pattern)) {
    if (rule.anchored || rule.pattern.includes("/")) {
      return pathPatternMatches(relFromBase, rule.pattern, isDir, rule.dirOnly);
    }
    return rule.dirOnly
      ? (isDir && basename === rule.pattern) || segments.slice(0, -1).includes(rule.pattern)
      : segments.includes(rule.pattern);
  }

  const relRegex = globToRegExp(
    rule.anchored || rule.pattern.includes("/") ? rule.pattern : `**/${rule.pattern}`,
  );
  const baseRegex = globToRegExp(rule.pattern);
  const matched =
    relRegex.test(relFromBase) ||
    (!rule.anchored && !rule.pattern.includes("/") && baseRegex.test(basename));
  return rule.dirOnly ? isDir && matched : matched;
}

function relRelativeToIgnoreBase(rel: string, baseRel: string): string | undefined {
  if (!baseRel) return rel;
  if (rel === baseRel) return "";
  if (!rel.startsWith(`${baseRel}/`)) return undefined;
  return rel.slice(baseRel.length + 1);
}

function pathPatternMatches(
  relFromBase: string,
  pattern: string,
  isDir: boolean,
  dirOnly: boolean,
): boolean {
  if (relFromBase === pattern) return !dirOnly || isDir;
  if (relFromBase.startsWith(`${pattern}/`)) return true;
  return false;
}

async function safeReadText(
  ops: Pick<GrepOperations, "readFile">,
  filePath: string,
): Promise<string | undefined> {
  try {
    return await ops.readFile(filePath);
  } catch {
    return undefined;
  }
}

function collectGrepMatches(
  content: string,
  regex: RegExp,
  fileLabel: string,
  limit: number,
  matches: GrepMatch[],
): void {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] ?? "";
    if (!regex.test(line)) continue;
    regex.lastIndex = 0;
    matches.push({ fileLabel, lines, lineNumber: idx + 1 });
    if (matches.length >= limit) return;
  }
}

function formatGrepMatches(
  matches: GrepMatch[],
  context: number,
): { lines: string[]; linesTruncated: boolean } {
  const out: string[] = [];
  let linesTruncated = false;
  for (const match of matches) {
    const start = context > 0 ? Math.max(1, match.lineNumber - context) : match.lineNumber;
    const end = context > 0 ? Math.min(match.lines.length, match.lineNumber + context) : match.lineNumber;
    for (let current = start; current <= end; current++) {
      const raw = match.lines[current - 1] ?? "";
      const truncated = truncateLine(raw, GREP_MAX_LINE_LENGTH);
      if (truncated.wasTruncated) linesTruncated = true;
      out.push(
        current === match.lineNumber
          ? `${match.fileLabel}:${current}: ${truncated.text}`
          : `${match.fileLabel}-${current}- ${truncated.text}`,
      );
    }
  }
  return { lines: out, linesTruncated };
}

async function defaultFindGlob(
  pattern: string,
  root: string,
  workspaceCwd: string,
  options: { ignore: string[]; limit: number },
): Promise<string[]> {
  void options.ignore;
  const matcher = matcherForPattern(pattern);
  const out: string[] = [];
  async function walk(dir: string, inheritedRules: GitIgnoreRule[]): Promise<void> {
    if (out.length >= options.limit) return;
    const rules = inheritedRules.concat(await loadGitIgnoreRules(dir, workspaceCwd));
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= options.limit) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      const rel = normalizeDisplayPath(path.relative(root, full));
      const relToWorkspace = normalizeDisplayPath(path.relative(workspaceCwd, full));
      if (isIgnored(relToWorkspace, entry.isDirectory(), rules)) continue;
      if (matcher(rel, entry.name)) out.push(full + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) await walk(full, rules);
    }
  }
  await walk(root, await loadAncestorGitIgnoreRules(root, workspaceCwd));
  return out.sort((a, b) => a.localeCompare(b));
}

function normalizeFindResult(cwd: string, root: string, resultPath: string): string {
  const hadSlash = resultPath.endsWith("/") || resultPath.endsWith("\\");
  const absolute = path.isAbsolute(resultPath)
    ? resultPath.replace(/[\\/]+$/, "")
    : path.resolve(root, resultPath.replace(/[\\/]+$/, ""));
  const rel = toDisplayPath(cwd, absolute);
  return `${rel}${hadSlash && !rel.endsWith("/") ? "/" : ""}`;
}

function matcherForPattern(pattern: string): (rel: string, basename: string) => boolean {
  if (hasGlobMagic(pattern)) {
    const regex = globToRegExp(pattern.includes("/") ? pattern : `**/${pattern}`);
    const baseRegex = globToRegExp(pattern);
    return (rel, basename) => regex.test(rel) || baseRegex.test(basename);
  }
  return (rel, basename) => basename.includes(pattern) || rel.includes(pattern);
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return Math.floor(value);
}

function withOptionalDetails(
  content: ToolExecResult["content"],
  details: object,
): ToolExecResult {
  const clean = detailObject(details);
  if (Object.keys(clean).length === 0) return { content };
  return { content, details: clean };
}

function detailObject(details: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(
      ([, value]) => value !== undefined && value !== false,
    ),
  );
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length - 1;
}

function simpleDiff(
  filePath: string,
  oldText: string,
  newText: string,
  firstChangedLine: number,
): string {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${firstChangedLine},${oldLines.length} +${firstChangedLine},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("aborted");
}
