import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  createReadStream,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildSync } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';

// Coordinator lab: a live board of every chat in one worktree, read straight
// from the app's local chat store. See docs/coordinator-lab.md.
const configDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(configDir, '../../../..');
const rendererDir = configDir;
// The app's own read-only helpers: its data folder, chat labels, transcript
// reader and delta-journal replay (a format 3 scope commits to
// `delta-journal.log` and only rewrites its index and transcript files at a
// checkpoint). They are bundled once for Node the way
// tests/electron/readChatStorage.mjs does, so there is no second copy of the
// journal format here. They never write the scope.
let replayModule: Record<string, unknown> | null = null;

function loadReplayModule(): Record<string, unknown> {
  if (replayModule) return replayModule;
  const directory = mkdtempSync(join(tmpdir(), 'coordinator-lab-replay-'));
  process.once('exit', () =>
    rmSync(directory, { recursive: true, force: true }),
  );
  const main = join(repoRoot, 'apps/desktop-app/src/main/lib');
  const from = (file: string): string => JSON.stringify(join(main, file));
  const outfile = join(directory, 'replay.cjs');
  buildSync({
    stdin: {
      contents: [
        `export { openReplayedChatScope } from ${from('chat-delta-journal/reader.ts')};`,
        `export { readDeltaJournal, readCheckpointState, assertJournalCovers, recordsAfter, replayIndexMetadata } from ${from('chat-delta-journal/replay.ts')};`,
        `export { assertChatStorageIndexes } from ${from('chat-storage-v2.ts')};`,
        `export { ChatTranscriptLog } from ${from('chat-transcript-log.ts')};`,
        `export { getCanopyDataDir } from ${JSON.stringify(join(repoRoot, 'packages/desktop-shared/src/canopy-paths.ts'))};`,
        `export { chatDisplayLabel } from ${JSON.stringify(join(repoRoot, 'packages/protocol/src/chat-title.ts'))};`,
      ].join('\n'),
      resolveDir: repoRoot,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: join(repoRoot, 'tsconfig.base.json'),
    logLevel: 'silent',
  });
  const helpers: Record<string, unknown> = createRequire(import.meta.url)(
    outfile,
  );
  replayModule = helpers;
  return helpers;
}

function replayFunction(name: string): (...args: unknown[]) => unknown {
  const fn = loadReplayModule()[name];
  if (typeof fn !== 'function')
    throw new Error(`Replay helper ${name} missing`);
  return (...args) => fn(...args);
}

// The app's data folder, with its runtime, brand and CANOPY_DATA_DIR rules.
// The helper falls back to NODE_ENV, which the Vite dev server sets to
// development; the board reads the installed app unless CANOPY_ENV says
// otherwise, in dev and preview alike.
const dataRoot = ((): string => {
  const previous = process.env.CANOPY_ENV;
  process.env.CANOPY_ENV = previous ?? 'production';
  try {
    return resolve(String(replayFunction('getCanopyDataDir')()));
  } finally {
    if (previous === undefined) delete process.env.CANOPY_ENV;
  }
})();
const insideDataRoot = (path: string): boolean =>
  path === dataRoot || path.startsWith(`${dataRoot}${sep}`);
const realDataRoot = ((): string => {
  try {
    return realpathSync(dataRoot);
  } catch {
    return dataRoot;
  }
})();
/** A file the lab may serve: inside the data folder once links resolve. */
function servableFile(path: string): boolean {
  if (!insideDataRoot(path)) return false;
  try {
    const real = realpathSync(path);
    return (
      (real === realDataRoot || real.startsWith(`${realDataRoot}${sep}`)) &&
      statSync(real).isFile()
    );
  } catch {
    return false;
  }
}
// The workspace and worktree whose chats the board shows. The worktree
// defaults to this checkout's folder name, which is its worktree id.
const workspaceDir = resolve(
  process.env.COORDINATOR_WORKSPACE ?? join(dataRoot, 'workspaces/canopy'),
);
const worktreeId = process.env.COORDINATOR_WORKTREE ?? basename(repoRoot);
const storeDir = join(workspaceDir, 'chat-storage-v2', worktreeId);
const manifestFile = join(
  workspaceDir,
  'chat-storage-manifests',
  `${worktreeId}.json`,
);
const journalFile = join(storeDir, 'delta-journal.log');
const transcriptsDir = join(storeDir, 'transcripts');
const attachmentsDir = join(workspaceDir, 'attachments', worktreeId);
// The coordinator's own notes: labels, open questions, merges and its log.
// The real file is personal, so it lives in the data folder, outside every
// checkout; the committed sample stands in without it.
const localNotesFile = join(dataRoot, 'coordinator-lab', `${worktreeId}.json`);
const sampleNotesFile = join(configDir, 'coordinator-lab.sample.json');
const notesFile = resolve(
  process.env.COORDINATOR_NOTES ??
    (existsSync(localNotesFile) ? localNotesFile : sampleNotesFile),
);
const selectedBrandId = process.env.CANOPY_BRAND ?? 'canopy';

const LAB_PORTS = new Set([5195, 5196]);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

const FS_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8',
};

// The chat store and notes are read as untyped JSON and narrowed field by
// field, so a format change shows up as missing data instead of a crash.
type Json = Record<string, unknown>;
const isJson = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isJson(v) ? v : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const time = (v: unknown): number | null =>
  num(v) ?? (Date.parse(str(v) ?? '') || null);

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

function readJson(path: string): Json {
  try {
    return obj(parseJson(readFileSync(path, 'utf8')));
  } catch {
    return {};
  }
}

type Message = {
  timestamp: number;
  sub: boolean;
  role: string;
  blocks: Json[];
};

/** A transcript row, either a bare message or a `{ kind: 'message' }` row. */
function toMessage(value: unknown): Message | null {
  const row = obj(value);
  const msg = row.kind === 'message' ? obj(row.message) : row;
  if (!Array.isArray(msg.blocks)) return null;
  return {
    timestamp: Number(msg.timestamp) || 0,
    // Subagent rows link to their parent by either field.
    sub: Boolean(msg.parentBlockId ?? msg.parentToolUseId),
    role: str(msg.role) ?? '',
    blocks: msg.blocks.filter(isJson),
  };
}

type Activity = {
  at: number;
  kind: string;
  text: string;
  sub?: boolean;
  described?: boolean;
};

function summarizeTool(name: string, rawInput: unknown): string {
  let input: unknown = rawInput;
  if (typeof rawInput === 'string') {
    input = parseJson(rawInput) ?? { text: rawInput };
  }
  if (!isJson(input)) return name;
  const pick =
    input.description ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.query ??
    input.prompt ??
    input.command ??
    obj(input.action).type ??
    input.text ??
    '';
  return (typeof pick === 'string' ? pick : JSON.stringify(pick))
    .replace(/\s+/g, ' ')
    .slice(0, 140);
}

const MEDIA_EXT_SRC = 'png|jpe?g|gif|webp|mp4|webm|mov';
// Paths a chat names under the data folder, the only one this lab serves.
const HOME_SRC = dataRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Absolute paths anywhere in a chat: replies, tool inputs and tool output.
const ABS_MEDIA_RE = new RegExp(
  `(${HOME_SRC}/[^\\s"'\`()<>\\]\\\\|,;]+?\\.(?:${MEDIA_EXT_SRC}))(?![\\w])`,
  'gi',
);
// Relative names (`demo/x.mp4`, `x-dark.png`), resolved against the chat's own
// `.playwright/<slug>` folders.
const REL_MEDIA_RE = new RegExp(
  `(?<![\\w/.~-])((?:[\\w.-]+/){0,3}[\\w.-]+\\.(?:${MEDIA_EXT_SRC}))(?![\\w])`,
  'gi',
);
const PLAYWRIGHT_DIR_RE = new RegExp(
  `(${HOME_SRC}/[^\\s"'\`()<>\\]\\\\|,;]*?/\\.playwright/[\\w.-]+)`,
  'g',
);
const MAX_SCAN_STRING = 200_000;
// Report pages a chat made or showed: interactive review surfaces.
const REPORT_RE = new RegExp(
  `(${HOME_SRC}/[^\\s"'\`()<>\\]\\\\|,;]*?/\\.playwright/[^\\s"'\`()<>\\]\\\\|,;]+?\\.html)(?![\\w])`,
  'g',
);
// Live labs and previews on this machine.
const LAB_RE =
  /(https?:\/\/(?:localhost|127\.0\.0\.1):\d{4,5}(?:\/[^\s"'`()<>\]\\|,;]*)?)/g;

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.length <= MAX_SCAN_STRING && !value.includes('"base64"'))
      out.push(value);
    else if (value.length > MAX_SCAN_STRING)
      out.push(value.slice(0, MAX_SCAN_STRING));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

function blockStrings(block: Json): string[] {
  const out: string[] = [];
  if (block.type === 'text' && typeof block.text === 'string')
    out.push(block.text);
  else if (block.type === 'tool_use') {
    const input = block.input;
    collectStrings(
      typeof input === 'string' ? (parseJson(input) ?? input) : input,
      out,
    );
  } else if (block.type === 'tool_result')
    collectStrings(block.output ?? block.content, out);
  // Pictures attached to the chat as image blocks.
  else if (block.type === 'image') {
    const path = str(block.path);
    if (path) out.push(path);
  }
  return out;
}

function indexDir(
  dir: string,
  depth: number,
  into: Map<string, string[]>,
): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && !e.name.startsWith('.') && e.name !== 'node_modules')
        indexDir(full, depth - 1, into);
    } else {
      const list = into.get(e.name) ?? [];
      list.push(full);
      into.set(e.name, list);
    }
  }
}

type ChatCache = { key: string; data: ChatScan };
const cache = new Map<string, ChatCache>();

function fileKey(...paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const s = statSync(p);
        return `${s.size}:${s.mtimeMs}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

type Shot = { path: string; at: number };
type ChatLinks = {
  mentioned: ReadonlyMap<string, number>;
  relative: ReadonlyMap<string, number>;
  playwrightDirs: ReadonlySet<string>;
  relativeSlugs: ReadonlySet<string>;
  worktrees: string[];
  reports: ReadonlyMap<string, number>;
  lastText: string;
};
type ChatMedia = {
  reports: Shot[];
  replyMedia: string[];
  screenshots: Shot[];
  videos: Shot[];
};
type ChatScan = { links: ChatLinks; summary: ChatSummary };
type ChatSummary = {
  labs: string[];
  firstUserText: string;
  lastText: string;
  lastTextAt: number;
  toolCount: number;
  messageCount: number;
  activity: Activity[];
  currentStep: string;
  worktree: string;
};

// A worktree-relative mention of a capture folder, as in `.playwright/<slug>`.
const REL_PLAYWRIGHT_DIR_RE = /(?<![\w/~-])\.playwright\/([\w.-]+)/g;

/**
 * A relative link names its file with every folder it gives, so
 * `desktop/after.png` never matches `web/after.png`.
 */
const matchesRelative = (full: string, rel: string): boolean =>
  full.endsWith(`/${rel.replace(/^\.\//, '')}`);

/** Checkouts a chat worked in: this worktree and any it named by path. */
function chatWorktreeRoots(names: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const name of [worktreeId, ...names]) {
    roots.add(join(workspaceDir, 'worktrees', name));
    roots.add(
      join(workspaceDir, 'worktrees', worktreeId, '.claude', 'worktrees', name),
    );
  }
  return Array.from(roots).filter((root) => existsSync(root));
}

function analyzeChat(messages: Message[]): ChatScan {
  const activity: Activity[] = [];
  const mentioned = new Map<string, number>();
  const relative = new Map<string, number>();
  const playwrightDirs = new Set<string>();
  const relativeSlugs = new Set<string>();
  const worktrees = new Map<string, number>();
  let lastText = '';
  let lastTextAt = 0;
  const reports = new Map<string, number>();
  let firstUserText = '';
  let toolCount = 0;

  for (const msg of messages) {
    const at = msg.timestamp;
    const sub = msg.sub;
    for (const block of msg.blocks) {
      const text = str(block.text);
      if (block.type === 'text' && text !== null) {
        if (msg.role === 'user' && !firstUserText) firstUserText = text;
        if (msg.role === 'assistant' && !sub && text.trim()) {
          lastText = text;
          lastTextAt = at;
          activity.push({
            at,
            kind: 'said',
            text: text.replace(/\s+/g, ' ').slice(0, 160),
          });
        }
      } else if (block.type === 'tool_use') {
        toolCount += 1;
        const raw = str(block.input) ?? JSON.stringify(block.input ?? {});
        const toolName = str(block.toolName) ?? '';
        for (const m of raw.matchAll(/\/worktrees\/([a-z0-9][a-z0-9-]*)\//gi))
          worktrees.set(m[1], at);
        const described = /"description"\s*:/.test(raw);
        activity.push({
          at,
          kind: toolName || 'tool',
          text: summarizeTool(toolName, block.input),
          sub,
          described,
        });
      }
      for (const text of blockStrings(block)) {
        for (const m of text.matchAll(ABS_MEDIA_RE)) mentioned.set(m[1], at);
        for (const m of text.matchAll(PLAYWRIGHT_DIR_RE))
          playwrightDirs.add(m[1]);
        for (const m of text.matchAll(REL_MEDIA_RE)) relative.set(m[1], at);
        for (const m of text.matchAll(REL_PLAYWRIGHT_DIR_RE))
          relativeSlugs.add(m[1]);
        if (block.type !== 'tool_result') {
          for (const m of text.matchAll(REPORT_RE)) {
            if (!m[1].includes('/.playwright/coordinator/'))
              reports.set(m[1], at);
          }
        }
      }
    }
  }

  const main = activity.filter((a) => !a.sub);
  const currentStep =
    (
      main.reverse().find((a) => a.kind === 'said' || a.described) ??
      activity[activity.length - 1]
    )?.text ?? '';

  const mainWorktree =
    [...worktrees.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? worktreeId;

  const labs = [
    ...new Set(
      [...lastText.matchAll(LAB_RE)].map((m) => m[1].replace(/[.)\]]+$/, '')),
    ),
  ]
    .filter((u) => {
      // Never this lab itself: its own page in a card could read its routes.
      try {
        return !LAB_PORTS.has(Number(new URL(u).port));
      } catch {
        return false;
      }
    })
    .slice(0, 3);

  return {
    links: {
      mentioned,
      relative,
      playwrightDirs,
      relativeSlugs,
      worktrees: Array.from(worktrees.keys()),
      reports,
      lastText,
    },
    summary: {
      labs,
      firstUserText: firstUserText.slice(0, 600),
      lastText,
      lastTextAt,
      toolCount,
      messageCount: messages.length,
      activity: activity.slice(-14).reverse(),
      currentStep,
      worktree: mainWorktree,
    },
  };
}

/**
 * The files a chat links to, looked up on every build rather than cached with
 * its transcript: agents often write captures after their reply.
 */
function resolveMedia(links: ChatLinks): ChatMedia {
  const mentioned = new Map(links.mentioned);
  const playwrightDirs = new Set(links.playwrightDirs);
  const { relative, relativeSlugs, reports, lastText, worktrees } = links;
  // Resolve relative names against the chat's own `.playwright/<slug>`
  // folders: ones it named by absolute path, and worktree-relative ones
  // (`.playwright/<slug>/x.png`) in the worktrees it worked in.
  for (const root of chatWorktreeRoots(worktrees)) {
    for (const slug of relativeSlugs)
      playwrightDirs.add(join(root, '.playwright', slug));
  }
  if (relative.size > 0 && playwrightDirs.size > 0) {
    const byName = new Map<string, string[]>();
    for (const dir of playwrightDirs) indexDir(dir, 3, byName);
    for (const [rel, at] of relative) {
      const name = rel.split('/').pop() ?? rel;
      for (const full of byName.get(name) ?? []) {
        if (matchesRelative(full, rel))
          mentioned.set(full, Math.max(at, mentioned.get(full) ?? 0));
      }
    }
  }

  const media = [...mentioned.keys()]
    .filter(insideDataRoot)
    .flatMap((path) => {
      try {
        const st = statSync(path);
        return st.isFile() && st.size > 0 ? [{ path, at: st.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.at - a.at);
  const isVideo = (p: string): boolean =>
    VIDEO_EXT.has(extname(p).toLowerCase());
  const screenshots = media.filter((m) => !isVideo(m.path));
  const videos = media.filter((m) => isVideo(m.path));

  // Only pages the /fs route serves, so a card never opens on a 404. The
  // latest mentioned come first; each carries its file time, so a page the
  // agent rewrites reloads in the card.
  const reportList = [...reports.entries()]
    .filter(([p]) => insideDataRoot(p))
    .sort((a, b) => b[1] - a[1])
    .flatMap(([path]) => {
      try {
        const st = statSync(path);
        return st.isFile() ? [{ path, at: st.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .slice(0, 4);
  // What the latest reply points at: the pictures and labs to look at now.
  const replyMedia = new Set<string>();
  for (const m of lastText.matchAll(ABS_MEDIA_RE)) replyMedia.add(m[1]);
  for (const m of lastText.matchAll(REL_MEDIA_RE)) {
    for (const s of media)
      if (matchesRelative(s.path, m[1])) replyMedia.add(s.path);
  }

  return {
    reports: reportList,
    replyMedia: [...replyMedia],
    screenshots,
    videos,
  };
}

// Images in any worktree's `.playwright/<slug>` folder, newest first.
function agentReportImages(slug: unknown): { path: string; at: number }[] {
  if (typeof slug !== 'string' || !/^[\w.-]+$/.test(slug)) return [];
  const roots = [
    join(workspaceDir, 'worktrees'),
    join(workspaceDir, 'worktrees', worktreeId, '.claude', 'worktrees'),
  ];
  const out: { path: string; at: number }[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(root, name, '.playwright', slug);
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!IMAGE_EXT.has(extname(f).toLowerCase())) continue;
        const path = join(dir, f);
        try {
          out.push({ path, at: statSync(path).mtimeMs });
        } catch {
          /* removed while listing */
        }
      }
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 120);
}

function agentReportPages(slug: unknown): { path: string; at: number }[] {
  if (typeof slug !== 'string' || !/^[\w.-]+$/.test(slug)) return [];
  const roots = [
    join(workspaceDir, 'worktrees'),
    join(workspaceDir, 'worktrees', worktreeId, '.claude', 'worktrees'),
  ];
  const out: { path: string; at: number }[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root, name, '.playwright', slug, 'index.html');
      try {
        out.push({ path, at: statSync(path).mtimeMs });
      } catch {
        /* no report yet */
      }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

// The notes file keys a chat by its full id or an id prefix (`chat-4f427114`).
// Every matching entry applies, later keys over earlier ones; a merged PR,
// once recorded under any key, stays merged.
function notesFor(byKey: unknown, id: string): Json {
  const matches = Object.entries(obj(byKey))
    .filter(([k]) => k === id || (k.length >= 10 && id.startsWith(k)))
    .map(([, v]) => obj(v));
  const out: Json = Object.assign({}, ...matches);
  const merged = matches
    .map((m) => m.merged)
    .filter(Boolean)
    .pop();
  if (merged) out.merged = merged;
  return out;
}

// ChatRuntimeStatus in @canopy/desktop-shared/types; anything else reads idle.
const RUNTIME_STATUSES = new Set([
  'idle',
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const runtimeStatus = (v: unknown): string => {
  const status = str(v);
  return status && RUNTIME_STATUSES.has(status) ? status : 'idle';
};

// A recorded merge is a PR list such as "#1234, #1240", or true.
const mergedValue = (v: unknown): string | boolean | null =>
  str(v) ?? (v === true ? true : null);

type ChatData = ChatSummary & ChatMedia;

type BoardChat = ChatData & {
  id: string;
  title: string;
  rawTitle: string;
  model: string;
  createdAt: number | null;
  status: string;
  turnStartedAt: number | null;
  lastActivityAt: number | null;
  queued: string[];
  isCoordinator: boolean;
  needsYou: string | null;
  note: string | null;
  merged: string | boolean | null;
};

type BoardState = {
  now: number;
  worktreeId: string;
  chats: BoardChat[];
  attachments: Shot[];
  log: { at: string; text: string }[];
  notesUpdatedAt: string | null;
};

const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof v === 'object' &&
  v !== null &&
  typeof Reflect.get(v, Symbol.asyncIterator) === 'function';

const usesDeltaJournal = (): boolean =>
  readJson(manifestFile).version === 3 && existsSync(journalFile);

// A checkpoint can land between a replay's reads; each file is replaced
// atomically, so a short retry sees a consistent set.
async function withRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

type LiveState = {
  live: Json;
  /** Chats with journal records after the checkpoint. */
  journaled: Set<string>;
};

/**
 * The live index with every journal record applied. Metadata only: this
 * takes milliseconds, so it runs on every poll.
 */
async function readLiveState(): Promise<LiveState> {
  if (!usesDeltaJournal())
    return {
      live: obj(readJson(join(storeDir, 'live-index.json'))),
      journaled: new Set(),
    };
  return withRetry(async () => {
    const assertIndexes = loadReplayModule().assertChatStorageIndexes;
    const journal = await replayFunction('readDeltaJournal')(
      storeDir,
      worktreeId,
    );
    const checkpoint = await replayFunction('readCheckpointState')(
      storeDir,
      assertIndexes,
    );
    replayFunction('assertJournalCovers')(journal, checkpoint);
    const records = replayFunction('recordsAfter')(
      journal,
      obj(checkpoint).revision,
    );
    const metadata = obj(
      replayFunction('replayIndexMetadata')(
        obj(checkpoint).indexes,
        records,
        assertIndexes,
      ),
    );
    const touched = metadata.touched;
    return {
      live: obj(obj(metadata.indexes).live),
      journaled: new Set(
        touched instanceof Set
          ? Array.from(touched).flatMap((v) => str(v) ?? [])
          : [],
      ),
    };
  });
}

// The checkpoint's transcript files, read the way the app reads them: every
// sidecar version, committed rows and the active turn.
let canonicalLog: Json | null = null;
async function readCheckpointMessages(chatId: string): Promise<Message[]> {
  // A chat created after the last checkpoint has no files yet, and one
  // unreadable chat must not take the whole board down: both read as empty
  // until the replay or a later checkpoint fills them in.
  try {
    return await readCanonicalLog(chatId);
  } catch {
    return [];
  }
}

function readCanonicalLog(chatId: string): Promise<Message[]> {
  if (!canonicalLog) {
    const Log = loadReplayModule().ChatTranscriptLog;
    if (typeof Log !== 'function') throw new Error('Transcript log missing');
    canonicalLog = obj(
      Reflect.construct(Log, [transcriptsDir, undefined, { readOnly: true }]),
    );
  }
  return readLogMessages(canonicalLog, chatId);
}

async function readLogMessages(log: Json, chatId: string): Promise<Message[]> {
  const out: Message[] = [];
  const seen = new Set<unknown>();
  const rows: unknown =
    typeof log.iterate === 'function' ? log.iterate(chatId) : null;
  if (isAsyncIterable(rows)) {
    for await (const row of rows) {
      seen.add(obj(row).id);
      const message = toMessage(row);
      if (message) out.push(message);
    }
  }
  const active: unknown =
    typeof log.activeMessages === 'function'
      ? await log.activeMessages(chatId)
      : [];
  for (const row of list(active)) {
    if (seen.has(obj(row).id)) continue;
    const message = toMessage(row);
    if (message) out.push(message);
  }
  return out;
}

// A journaled chat's transcript needs the full replay view, which copies the
// chat's files and applies its records: seconds for a long chat. It runs in
// the background at most every FULL_REPLAY_MS; until it lands, the card keeps
// its last analysis.
const FULL_REPLAY_MS = 15_000;
let transcriptRefresh: Promise<void> | null = null;
let lastFullReplayAt = 0;

function refreshJournaledChats(due: Map<string, string>): void {
  if (transcriptRefresh || due.size === 0) return;
  if (Date.now() - lastFullReplayAt < FULL_REPLAY_MS) return;
  transcriptRefresh = (async (): Promise<void> => {
    const open = replayFunction('openReplayedChatScope');
    const view: unknown = await withRetry(async () =>
      open(
        { directory: storeDir, scopeId: worktreeId },
        loadReplayModule().assertChatStorageIndexes,
      ),
    );
    const scope = obj(view);
    const transcript = scope.transcript;
    const dispose = scope.dispose;
    try {
      if (typeof transcript !== 'function')
        throw new Error('Unexpected replay view');
      for (const [id, key] of due) {
        try {
          const log = obj(transcript.call(view, id));
          cache.set(id, {
            key,
            data: analyzeChat(await readLogMessages(log, id)),
          });
        } catch {
          // Keep the card's last analysis; the next refresh tries again.
        }
      }
      lastState = null;
    } finally {
      if (typeof dispose === 'function') await dispose.call(view);
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      transcriptRefresh = null;
      lastFullReplayAt = Date.now();
    });
}

async function buildState(): Promise<BoardState> {
  const { live, journaled } = await readLiveState();
  const runtimeByChatId = obj(live.runtimeByChatId);
  const due = new Map<string, string>();
  const notes = readJson(notesFile);
  const chats: BoardChat[] = [];
  for (const tab of list(live.tabs).map(obj)) {
    const id = str(tab.id);
    // File tabs share the tab list but are not chats.
    if (!id || tab.kind === 'file') continue;
    // The app's own label: a rename, then the auto-generated name, then the
    // title.
    const title =
      str(
        replayFunction('chatDisplayLabel')({
          customTitle: str(tab.customTitle) ?? undefined,
          description: str(tab.description) ?? undefined,
          title: str(tab.title) ?? undefined,
          fallback: 'New chat',
        }),
      ) ?? 'New chat';
    const runtime = obj(runtimeByChatId[id]);
    const index = readJson(join(transcriptsDir, `${id}.index.json`));
    // Journaled commits reach the runtime entry and the journal before the
    // chat's files, including commits that only change the transcript.
    const key = `${fileKey(
      join(transcriptsDir, `${id}.jsonl`),
      join(transcriptsDir, `${id}.active.json`),
    )}|${JSON.stringify(runtime)}|${journaled.has(id) ? fileKey(journalFile) : ''}`;
    let entry = cache.get(id);
    if (!entry || entry.key !== key) {
      if (journaled.has(id)) {
        // Show the checkpoint until the replay brings the journaled rows.
        due.set(id, key);
        entry ??= {
          key: '',
          data: analyzeChat(await readCheckpointMessages(id)),
        };
      } else {
        entry = { key, data: analyzeChat(await readCheckpointMessages(id)) };
      }
      cache.set(id, entry);
    }
    const note = notesFor(notes.chats, id);
    chats.push({
      id,
      title: str(note.label) ?? title,
      rawTitle: title,
      model: str(tab.model) ?? '',
      createdAt: time(tab.createdAt),
      status: runtimeStatus(runtime.status),
      turnStartedAt: time(obj(runtime.activeTurn).startedAt),
      lastActivityAt: time(runtime.lastActivityAt) ?? time(index.lastMessageAt),
      queued: list(runtime.queuedMessages).map((q) =>
        (str(obj(obj(q).request).text) ?? '').slice(0, 200),
      ),
      isCoordinator: id === live.activeTabId && /coordinator/i.test(title),
      needsYou: str(note.needsYou),
      note: str(note.note),
      merged: mergedValue(note.merged),
      ...entry.data.summary,
      ...resolveMedia(entry.data.links),
    });
  }

  const attachments = existsSync(attachmentsDir)
    ? readdirSync(attachmentsDir)
        .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
        .map((f) => {
          const path = join(attachmentsDir, f);
          return { path, at: statSync(path).mtimeMs };
        })
        .sort((a, b) => b.at - a.at)
    : [];

  // Background agents aren't app chats; the coordinator lists them in
  // its notes file and their report folders supply the pictures.
  const agentChats = list(notes.agents)
    .map(obj)
    .map((a): BoardChat => {
      const title = str(a.title) ?? '';
      const running = a.status === 'running';
      return {
        id: `agent-${str(a.id) ?? title}`,
        title: `${title} · background agent`,
        rawTitle: title,
        model: 'opus',
        createdAt: time(a.startedAt),
        status: running
          ? 'streaming'
          : a.status === 'failed'
            ? 'failed'
            : 'idle',
        turnStartedAt: running ? time(a.startedAt) : null,
        lastActivityAt: time(a.updatedAt) ?? time(a.startedAt),
        queued: [],
        isCoordinator: false,
        needsYou: str(a.needsYou),
        note: str(a.note),
        merged: mergedValue(a.merged),
        firstUserText: title,
        lastText: str(a.summary) ?? '',
        lastTextAt: time(a.updatedAt) ?? 0,
        toolCount: 0,
        messageCount: 0,
        activity: [],
        currentStep: str(a.step) ?? '',
        screenshots: agentReportImages(a.reportSlug),
        videos: [],
        reports: agentReportPages(a.reportSlug),
        replyMedia: [],
        labs: [],
        worktree: str(a.worktree) ?? '',
      };
    });

  const log = list(notes.log)
    .map(obj)
    .flatMap((l) => {
      const at = str(l.at);
      const text = str(l.text);
      return at && text ? [{ at, text }] : [];
    });

  refreshJournaledChats(due);

  return {
    now: Date.now(),
    worktreeId,
    chats: [...chats, ...agentChats],
    attachments,
    log,
    notesUpdatedAt: str(notes.updatedAt),
  };
}

// Polls overlap while a replay runs; they share one build. When no store,
// notes or attachment file changed, the last board is reused for a while, so
// an idle store is not replayed every 2 seconds. Report folders in other
// worktrees are not watched; the age limit picks those up.
const REUSE_MS = 10_000;
let pendingState: Promise<BoardState> | null = null;
let lastState: { key: string; state: BoardState } | null = null;

const stateKey = (): string =>
  fileKey(
    manifestFile,
    journalFile,
    join(storeDir, 'live-index.json'),
    transcriptsDir,
    notesFile,
    attachmentsDir,
  );

function currentState(): Promise<BoardState> {
  const key = stateKey();
  if (
    lastState &&
    lastState.key === key &&
    Date.now() - lastState.state.now < REUSE_MS
  )
    return Promise.resolve(lastState.state);
  pendingState ??= buildState()
    .then((state) => {
      lastState = { key, state };
      return state;
    })
    .finally(() => {
      pendingState = null;
    });
  return pendingState;
}

const DEV_MODULE_EXT = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.css',
  '.json',
  '.woff2',
  '.woff',
  '.map',
]);
const devModulePath = (path: string): boolean =>
  DEV_MODULE_EXT.has(extname(path).toLowerCase());
const DOCUMENT_RE = /\.(?:html?|xhtml|svg|xml)$/i;
const BOARD_DOCUMENTS = new Set(['/index.html', '/coordinator-lab.html']);

/** The decoded request path, or null when it is malformed or climbs out. */
function decodedPath(pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (path.includes('\\') || path.includes('\0')) return null;
  return path.split('/').includes('..') ? null : path;
}

/**
 * Streams a file that was checked a moment ago. It can vanish or be replaced
 * before it opens (captures are rewritten often); that ends this response,
 * never the server.
 */
function sendFile(
  res: ServerResponse,
  file: string,
  range?: { start: number; end: number },
): void {
  const stream = createReadStream(file, range);
  stream.on('error', () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.statusCode = 404;
    res.removeHeader('content-length');
    res.end();
  });
  // A cancelled request (a video seek, a closed viewer) releases the file.
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const BOARD_PAGE = '/coordinator-lab.html';
const SANDBOX_POLICY = 'sandbox allow-scripts allow-popups allow-forms';

// Only this machine's loopback names. Vite's own host check runs after these
// routes, so they check the Host header themselves against DNS rebinding.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const loopbackHost = (req: IncomingMessage): boolean =>
  LOOPBACK_HOSTS.has((req.headers.host ?? '').replace(/:\d+$/, ''));

function api(): Plugin {
  const handler = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!loopbackHost(req)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    // Every route is judged by its decoded path, the one Vite serves. The
    // only documents on this origin are the board itself and the sandboxed
    // /fs route: a report document anywhere else would run its script here.
    // Through /@fs/ only the module and asset types the page loads pass.
    // Routes use the raw request path, the one Vite resolves: a target that
    // starts with `//` (or isn't a path) would parse as a host and hide its
    // real path.
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    const path =
      rawPath.startsWith('/') && !rawPath.startsWith('//')
        ? decodedPath(rawPath)
        : null;
    // Every response but the board itself carries the sandbox policy, so a
    // document reached any other way (a Vite fallback, an extensionless or
    // directory route) runs in an opaque origin. Scripts, styles and data
    // ignore it.
    if (path !== BOARD_PAGE)
      res.setHeader('content-security-policy', SANDBOX_POLICY);
    // The notes are personal: only the board's state API reads them, never
    // a static or /@fs/ request, whatever folder an override points at.
    if (
      path === null ||
      basename(path) === basename(notesFile) ||
      basename(path) === basename(localNotesFile) ||
      (path.startsWith('/@fs/')
        ? !devModulePath(path)
        : DOCUMENT_RE.test(path) &&
          !BOARD_DOCUMENTS.has(path) &&
          !path.startsWith('/fs/'))
    ) {
      res.statusCode = 403;
      res.end();
      return;
    }
    // The design system preloads its fonts by repo path; serve them in preview.
    if (path.startsWith('/packages/') && path.endsWith('.woff2')) {
      const font = resolve(repoRoot, `.${path}`);
      if (font.startsWith(`${repoRoot}${sep}`) && existsSync(font)) {
        res.setHeader('content-type', 'font/woff2');
        sendFile(res, font);
        return;
      }
    }
    if (path === '/' || path === '/index.html') {
      res.statusCode = 302;
      res.setHeader('location', '/coordinator-lab.html');
      res.end();
      return;
    }
    if (path === '/api/state') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      currentState().then(
        (state) => res.end(JSON.stringify(state)),
        (error: unknown) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(error) }));
        },
      );
      return;
    }
    // Any file under ~/.canopy by its absolute path, so report pages shown in a
    // card keep their relative links.
    if (path.startsWith('/fs/')) {
      const file = resolve(path.slice(3));
      const ext = extname(file).toLowerCase();
      const type = FS_MIME[ext] ?? MIME[ext];
      let ok = false;
      try {
        ok = statSync(file).isFile();
      } catch {
        ok = false;
      }
      if (!servableFile(file) || !type || !ok) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-type', type);
      res.setHeader('cache-control', 'no-store');
      // The sandbox policy set above keeps a report's or an SVG's script
      // in an opaque origin, in a card's frame or opened on its own.
      sendFile(res, file);
      return;
    }
    if (path === '/api/file') {
      const path = resolve(url.searchParams.get('path') ?? '');
      const ext = extname(path).toLowerCase();
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        size = -1;
      }
      if (!servableFile(path) || !MIME[ext] || size < 0) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-type', MIME[ext]);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('accept-ranges', 'bytes');
      // Byte ranges, so a <video> can seek and read its duration.
      const range = /^bytes=(\d*)-(\d*)$/.exec(
        String(req.headers.range ?? '').trim(),
      );
      if (range && (range[1] || range[2])) {
        let start = range[1]
          ? Number(range[1])
          : Math.max(0, size - Number(range[2]));
        let end = range[1] && range[2] ? Number(range[2]) : size - 1;
        end = Math.min(end, size - 1);
        if (start > end || start >= size) {
          res.statusCode = 416;
          res.setHeader('content-range', `bytes */${size}`);
          res.end();
          return;
        }
        start = Math.max(0, start);
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
        res.setHeader('content-length', String(end - start + 1));
        if (req.method === 'HEAD') return void res.end();
        sendFile(res, path, { start, end });
        return;
      }
      res.setHeader('content-length', String(size));
      if (req.method === 'HEAD') return void res.end();
      sendFile(res, path);
      return;
    }
    next();
  };
  return {
    name: 'coordinator-api',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    // The built page is served by `vite preview`, which doesn't watch the
    // repo, so other chats' edits can't stall it.
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  root: configDir,
  appType: 'spa',
  publicDir: false,
  plugins: [api()],
  esbuild: { jsx: 'automatic' },
  css: { postcss: resolve(repoRoot, 'postcss.config.cjs') },
  build: {
    outDir: resolve(repoRoot, '.cache/coordinator-lab'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(configDir, 'coordinator-lab.html') },
  },
  // No cross-origin reads: a page on another localhost port can't fetch the
  // board's data or files.
  preview: { host: '127.0.0.1', port: 5195, strictPort: true, cors: false },
  server: {
    host: '127.0.0.1',
    port: 5196,
    strictPort: true,
    cors: false,
    // Only the sources, packages and dependencies the page imports; never
    // the checkout's .playwright reports.
    fs: {
      allow: [
        resolve(repoRoot, 'apps/desktop-app'),
        resolve(repoRoot, 'packages'),
        resolve(repoRoot, 'node_modules'),
        resolve(repoRoot, '.cache/brand'),
      ],
    },
    watch: {
      ignored: [
        '**/coordinator-lab.*.json',
        '**/*.png',
        '**/out*/**',
        '**/.playwright/**',
        '**/.cache/**',
        '**/tests/**',
        '**/apps/web/**',
        '**/public/**',
      ],
    },
  },
  // The real design system: the desktop renderer's globals, tokens and
  // shared components, resolved from source the way the app does.
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${resolve(rendererDir, 'src')}/` },
      {
        find: '@canopy/protocol',
        replacement: resolve(repoRoot, 'packages/protocol/src'),
      },
      {
        find: '@canopy/app-core',
        replacement: resolve(repoRoot, 'packages/app-core/src'),
      },
      {
        find: '@canopy/app-state',
        replacement: resolve(repoRoot, 'packages/app-state/src'),
      },
      {
        find: '@canopy/desktop-shared',
        replacement: resolve(repoRoot, 'packages/desktop-shared/src'),
      },
      {
        find: '@canopy/desktop-instrumentation',
        replacement: resolve(repoRoot, 'packages/desktop-instrumentation/src'),
      },
      {
        find: '@canopy/ui-shared',
        replacement: resolve(repoRoot, 'packages/ui-shared/src'),
      },
      {
        find: '@canopy/ui-rich',
        replacement: resolve(repoRoot, 'packages/ui-rich/src'),
      },
      {
        find: '@canopy/ui-app',
        replacement: resolve(repoRoot, 'packages/ui-app/src'),
      },
      {
        find: '@canopy/brand/current',
        replacement: resolve(
          repoRoot,
          '.cache/brand',
          selectedBrandId,
          'desktop-brand.ts',
        ),
      },
      {
        find: '@canopy/brand/web',
        replacement: resolve(repoRoot, '.cache/brand/web-brands.ts'),
      },
      {
        find: '@repo/package.json',
        replacement: resolve(repoRoot, 'package.json'),
      },
    ],
  },
});
