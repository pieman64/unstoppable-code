/**
 * Chat-scoped record of Claude code-graph orientation. A successful graph tool
 * call orients its chat until the worktree graph or a graph repository HEAD
 * changes, so later turns and later SDK or terminal invocations of the same
 * chat skip the graph-first steering gate.
 *
 * Identity is the graph's current repository set with each repository's
 * resolved HEAD, the `dev:ino` of the graph database, and its last build
 * stamp, read in the code-graph read worker after every graph tool call,
 * before a graph tool whose answer does not report the stamp, and after the
 * database or WAL `stat` changed. The `stat` only detects activity; the stamp
 * identifies the build. Electron main never opens the graph database here,
 * and HEADs are read from `.git` files without spawning git.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  getCanonicalCanopyToolKey,
  type CanopyInjectedToolKey,
} from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { getWorktreeCodeGraphDbPath } from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import { readCodeGraphBuildStampUncached } from './code-graph-worktree-fingerprint';
import { resolveWorktreeCwd } from './resolve-worktree';
import { resolveWorktreeCodeGraphRepositories } from './worktree-repo-entries';

export interface ClaudeCodeGraphOrientationScope {
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
  /**
   * Identifies the current user turn. An orientation whose identity cannot be
   * read holds only within the turn that recorded it.
   */
  turn: object;
}

export interface ClaudeCodeGraphOrientationReaders {
  resolveRepositoryRoots: (
    projectId: string,
    worktreeRoot: string,
  ) => Promise<readonly string[]>;
  /** `'absent'` when no graph exists; `null` when it cannot be read. */
  readGraphIdentity: (
    projectId: string,
    worktreeId: string,
  ) => Promise<GraphIdentity | 'absent' | null>;
  readHeadIdentity: (repositoryRoot: string) => Promise<string | null>;
  /** Off-main read of the database's last build stamp; `null` if unreadable. */
  readBuildStamp: (
    projectId: string,
    worktreeId: string,
  ) => Promise<string | null>;
}

export interface GraphIdentity {
  /** `dev:ino` of graph.db: a rename-published database is a new instance. */
  instance: string;
  /** mtime and size of graph.db and its WAL. */
  content: string;
}

interface StampedGraph {
  graph: GraphIdentity;
  stamp: string;
}

/** The graph observed by `stat` alone, before a tool that reports its stamp. */
interface UnstampedGraph {
  graph: GraphIdentity;
  stamp: null;
}

/**
 * One consistent observation of the graph: `'absent'` when no graph exists,
 * `null` when it cannot be read.
 */
type GraphState = StampedGraph | 'absent' | null;

interface OrientationEntry {
  graph: GraphIdentity | null;
  /** The last build stamp the chat oriented on. */
  stamp: string | null;
  heads: string | null;
  /** The graph's repository set; `null` when it could not be resolved. */
  membership: string | null;
  turn: object;
}

/**
 * Bounds the process-wide map. Eviction is conservative: an evicted chat
 * must reorient even when its graph is still valid.
 */
const MAX_ORIENTED_CHATS = 256;
const COMMIT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const orientations = new Map<string, OrientationEntry>();
/** Graph and HEAD identity taken before each in-flight graph tool call. */
const pendingCalls = new Map<string, CallSnapshot>();
const MAX_PENDING_CALLS = 64;

interface SharedStampRead {
  /** The graph identity the read started from. */
  startedOn: GraphIdentity;
  result: Promise<GraphState>;
}

/** The in-flight revalidation stamp read of each graph. */
const sharedStampReads = new Map<string, SharedStampRead>();

function graphKey(scope: ClaudeCodeGraphOrientationScope): string {
  return `${scope.projectId}\0${scope.worktreeId}`;
}

function orientationKey(scope: ClaudeCodeGraphOrientationScope): string {
  return `${graphKey(scope)}\0${scope.chatId}`;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function readGraphIdentity(
  projectId: string,
  worktreeId: string,
): Promise<GraphIdentity | 'absent' | null> {
  try {
    const dbPath = getWorktreeCodeGraphDbPath(projectId, worktreeId);
    const database = await stat(dbPath, { bigint: true }).catch(
      (error: unknown): 'absent' | null =>
        isMissingFileError(error) ? 'absent' : null,
    );
    if (database === null || database === 'absent') return database;
    // A checkpoint can stop short of copying a build out of the WAL, so the
    // WAL is part of the identity; `-shm` changes on reads and is not. An
    // empty WAL holds no frames: a read-only open recreates one after a
    // writer's clean close deleted it.
    const wal = await stat(`${dbPath}-wal`, { bigint: true }).then(
      (stats) =>
        stats.size === BigInt(0)
          ? 'absent'
          : `${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.size}`,
      (error: unknown) => {
        if (isMissingFileError(error)) return 'absent';
        throw error;
      },
    );
    return {
      instance: `${database.dev}:${database.ino}`,
      content: `${database.mtimeNs}:${database.size}/${wal}`,
    };
  } catch {
    return null;
  }
}

function isGraphIdentity(
  value: GraphIdentity | 'absent' | null,
): value is GraphIdentity {
  return value !== null && value !== 'absent';
}

function isStampedGraph(
  value: GraphState | UnstampedGraph,
): value is StampedGraph {
  return value !== null && value !== 'absent' && value.stamp !== null;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return (await readFile(filePath, 'utf8')).trim();
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function resolveGitDirectory(repositoryRoot: string): Promise<string> {
  const dotGit = path.join(repositoryRoot, '.git');
  const dotGitStats = await stat(dotGit);
  if (dotGitStats.isDirectory()) return dotGit;
  const pointer = /^gitdir:\s*(.+)$/i.exec(
    (await readFile(dotGit, 'utf8')).trim(),
  );
  const target = pointer?.[1]?.trim();
  if (!target) {
    throw new Error('Git worktree pointer did not contain a gitdir');
  }
  return path.resolve(repositoryRoot, target);
}

function isSafeRefName(ref: string): boolean {
  return (
    ref.startsWith('refs/') &&
    !ref.split('/').some((segment) => segment === '' || segment === '..')
  );
}

function packedRefCommit(packedRefs: string, ref: string): string | null {
  for (const line of packedRefs.split('\n')) {
    const [commit, name] = line.trim().split(' ');
    if (name === ref && commit && COMMIT_ID_PATTERN.test(commit)) {
      return commit;
    }
  }
  return null;
}

async function resolveCommonDirectory(gitDirectory: string): Promise<string> {
  const pointer = await readOptionalText(path.join(gitDirectory, 'commondir'));
  return pointer ? path.resolve(gitDirectory, pointer) : gitDirectory;
}

async function readRefCommit(
  gitDirectory: string,
  ref: string,
): Promise<string | null> {
  const commonDirectory = await resolveCommonDirectory(gitDirectory);
  // Reftable keeps refs out of loose files and packed-refs; an unreadable
  // ref must never look like a stable unborn branch.
  const usesReftable = await stat(path.join(commonDirectory, 'reftable')).then(
    () => true,
    () => false,
  );
  if (usesReftable) return null;
  const refDirectories =
    commonDirectory === gitDirectory
      ? [gitDirectory]
      : [gitDirectory, commonDirectory];
  for (const directory of refDirectories) {
    const loose = await readOptionalText(path.join(directory, ref));
    if (loose !== null) {
      return COMMIT_ID_PATTERN.test(loose) ? loose : null;
    }
  }
  const packedRefs = await readOptionalText(
    path.join(commonDirectory, 'packed-refs'),
  );
  return (packedRefs ? packedRefCommit(packedRefs, ref) : null) ?? 'unborn';
}

async function readHeadIdentity(
  repositoryRoot: string,
): Promise<string | null> {
  try {
    const gitDirectory = await resolveGitDirectory(repositoryRoot);
    const head = await readOptionalText(path.join(gitDirectory, 'HEAD'));
    if (!head) return null;
    if (COMMIT_ID_PATTERN.test(head)) return head;
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (!ref || !isSafeRefName(ref)) return null;
    const commit = await readRefCommit(gitDirectory, ref);
    return commit === null ? null : `${ref}=${commit}`;
  } catch {
    return null;
  }
}

/**
 * The worktree checkout root. A chat scoped to one repository of a multi-repo
 * workspace runs in that child checkout, but the graph and its custom
 * languages config belong to the workspace worktree root.
 */
export function resolveClaudeCodeGraphWorktreeRoot(
  projectId: string,
  worktreeId: string,
  cwd: string,
): string {
  try {
    return resolveWorktreeCwd(projectId, worktreeId);
  } catch {
    return cwd;
  }
}

async function resolveRepositoryRoots(
  projectId: string,
  worktreeRoot: string,
): Promise<readonly string[]> {
  const repositories = await resolveWorktreeCodeGraphRepositories(
    projectId,
    worktreeRoot,
  );
  return repositories.map((repository) => repository.rootPath);
}

const defaultReaders: ClaudeCodeGraphOrientationReaders = {
  resolveRepositoryRoots,
  readGraphIdentity,
  readHeadIdentity,
  readBuildStamp: (projectId, worktreeId) =>
    readCodeGraphBuildStampUncached(
      getWorktreeCodeGraphDbPath(projectId, worktreeId),
      `${projectId}/${worktreeId}`,
    ),
};

let readers: ClaudeCodeGraphOrientationReaders = defaultReaders;

interface RepositoryIdentity {
  heads: string | null;
  membership: string | null;
}

interface OrientationIdentity extends RepositoryIdentity {
  graph: GraphIdentity | 'absent' | null;
}

/** Graph state, repository set and HEADs taken before a graph tool call. */
interface CallSnapshot extends RepositoryIdentity {
  graph: GraphState | UnstampedGraph;
}

async function readHeads(
  repositoryRoots: readonly string[],
): Promise<string | null> {
  const heads = await Promise.all(
    repositoryRoots.map((root) => readers.readHeadIdentity(root)),
  );
  return repositoryRoots.length === 0 || heads.some((head) => head === null)
    ? null
    : repositoryRoots
        .map((root, index) => `${root}@${heads[index]}`)
        .join('\n');
}

async function readOrientationIdentity(
  scope: ClaudeCodeGraphOrientationScope,
): Promise<OrientationIdentity> {
  const [graph, repositories] = await Promise.all([
    readers.readGraphIdentity(scope.projectId, scope.worktreeId),
    readRepositoryIdentity(scope),
  ]);
  return { graph, ...repositories };
}

/**
 * The graph's current repository set, sorted so it compares as a set, and its
 * HEADs. Membership is compared on its own: a known change invalidates even
 * when a HEAD cannot be read. A failed lookup leaves both unreadable.
 */
async function readRepositoryIdentity(
  scope: ClaudeCodeGraphOrientationScope,
): Promise<RepositoryIdentity> {
  const roots = await readers
    .resolveRepositoryRoots(
      scope.projectId,
      resolveClaudeCodeGraphWorktreeRoot(
        scope.projectId,
        scope.worktreeId,
        scope.cwd,
      ),
    )
    .then(
      (resolved) => Array.from(new Set(resolved)).sort(),
      (): null => null,
    );
  if (roots === null) return { heads: null, membership: null };
  return { heads: await readHeads(roots), membership: JSON.stringify(roots) };
}

function changed(recorded: string | null, current: string | null): boolean {
  return recorded !== null && current !== null && recorded !== current;
}

function sameGraph(left: GraphIdentity, right: GraphIdentity): boolean {
  return left.instance === right.instance && left.content === right.content;
}

/**
 * The graph identity and its build stamp from one consistent observation:
 * the identity is read before and after the stamp, and a write landing in
 * between is retried once. `observed`, when given, is a fresh identity that
 * stands in for the first read before the stamp. `'absent'` when no graph
 * exists; `null` when no consistent stamp could be read.
 */
async function readStampedGraph(
  scope: ClaudeCodeGraphOrientationScope,
  observed?: GraphIdentity,
): Promise<GraphState> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before =
      attempt === 0 && observed !== undefined
        ? observed
        : await readers.readGraphIdentity(scope.projectId, scope.worktreeId);
    if (!isGraphIdentity(before)) return before;
    const stamp = await readers.readBuildStamp(
      scope.projectId,
      scope.worktreeId,
    );
    if (stamp === null) return null;
    const after = await readers.readGraphIdentity(
      scope.projectId,
      scope.worktreeId,
    );
    if (isGraphIdentity(after) && sameGraph(before, after)) {
      return { graph: after, stamp };
    }
  }
  return null;
}

/**
 * A revalidation probe's stamped graph. Concurrent probes of one graph that
 * observed the same identity share one stamp read started from it; a probe
 * that observed another identity reads on its own. Graph tool calls never
 * share a read.
 */
function readStampedGraphForProbe(
  scope: ClaudeCodeGraphOrientationScope,
  observed: GraphIdentity,
): Promise<GraphState> {
  const key = graphKey(scope);
  const inFlight = sharedStampReads.get(key);
  if (inFlight !== undefined && sameGraph(inFlight.startedOn, observed)) {
    return inFlight.result;
  }
  const read: SharedStampRead = {
    startedOn: observed,
    result: readStampedGraph(scope, observed).finally(() => {
      if (sharedStampReads.get(key) === read) sharedStampReads.delete(key);
    }),
  };
  sharedStampReads.set(key, read);
  return read.result;
}

/** The graph's `stat` identity, without a stamp read. */
async function readUnstampedGraph(
  scope: ClaudeCodeGraphOrientationScope,
): Promise<UnstampedGraph | 'absent' | null> {
  const graph = await readers.readGraphIdentity(
    scope.projectId,
    scope.worktreeId,
  );
  return isGraphIdentity(graph) ? { graph, stamp: null } : graph;
}

function remember(key: string, entry: OrientationEntry): void {
  orientations.delete(key);
  orientations.set(key, entry);
  if (orientations.size > MAX_ORIENTED_CHATS) {
    const leastRecent = orientations.keys().next().value;
    if (leastRecent !== undefined) orientations.delete(leastRecent);
  }
}

function pendingCallKey(
  scope: ClaudeCodeGraphOrientationScope,
  toolUseId: string,
): string {
  return `${orientationKey(scope)}\0${toolUseId}`;
}

/** Graph tools whose answer reports the build stamp (`lastBuildAt`). */
const BUILD_STAMP_REPORTING_TOOL_KEYS: ReadonlySet<CanopyInjectedToolKey> =
  new Set<CanopyInjectedToolKey>([
    'get_code_graph_context',
    'build_or_update_code_graph',
    'detect_changed_symbols',
    'compare_change_impact',
    'get_review_context',
  ]);

function reportsBuildStamp(toolName: string | undefined): boolean {
  const key = getCanonicalCanopyToolKey(toolName);
  return key !== null && BUILD_STAMP_REPORTING_TOOL_KEYS.has(key);
}

/**
 * Snapshots the graph (or its absence) and HEAD identity before a graph tool
 * runs, so the PostToolUse record can tell whether the state it reads is the
 * one the tool answered from. Hooks call this for every graph tool, also
 * before a first build. Before a tool that reports its build stamp only the
 * `stat` is taken: the record checks the reported stamp against a fresh
 * read, and a stampless answer from it holds for its turn at most.
 */
export async function beginClaudeCodeGraphToolCall(
  scope: ClaudeCodeGraphOrientationScope,
  toolUseId: string,
  toolName?: string,
): Promise<void> {
  const [graph, repositories] = await Promise.all([
    reportsBuildStamp(toolName)
      ? readUnstampedGraph(scope)
      : readStampedGraph(scope),
    readRepositoryIdentity(scope),
  ]);
  const key = pendingCallKey(scope, toolUseId);
  pendingCalls.set(key, { graph, ...repositories });
  if (pendingCalls.size > MAX_PENDING_CALLS) {
    const oldest = pendingCalls.keys().next().value;
    if (oldest !== undefined) pendingCalls.delete(oldest);
  }
}

export interface ClaudeCodeGraphToolCall {
  toolUseId?: string;
  /** BuildOrUpdateCodeGraph: the call itself rebuilds the graph. */
  rebuildsGraph: boolean;
  /**
   * The build stamp (`lastBuildAt`) the tool's answer reported; `null` when
   * it reported none.
   */
  answeredBuildAt: number | null;
}

export interface ClaudeCodeGraphToolAnswer {
  failed: boolean;
  lastBuildAt: number | null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonAnswer(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads a graph tool's JSON answer from a PostToolUse `tool_response`: the
 * Claude CLI passes the MCP content blocks, the SDK may wrap them in
 * `{ content, isError }`. A missing, malformed or ambiguous stamp is `null`.
 */
export function readClaudeCodeGraphToolAnswer(
  toolResponse: unknown,
): ClaudeCodeGraphToolAnswer {
  const blocks: unknown[] = Array.isArray(toolResponse)
    ? toolResponse
    : isObjectRecord(toolResponse) && Array.isArray(toolResponse.content)
      ? toolResponse.content
      : [];
  const answers: unknown[] = [];
  if (typeof toolResponse === 'string') {
    answers.push(parseJsonAnswer(toolResponse));
  }
  if (isObjectRecord(toolResponse) && 'structuredContent' in toolResponse) {
    answers.push(toolResponse.structuredContent);
  }
  for (const block of blocks) {
    if (
      isObjectRecord(block) &&
      block.type === 'text' &&
      typeof block.text === 'string'
    ) {
      answers.push(parseJsonAnswer(block.text));
    }
  }
  const failed =
    (isObjectRecord(toolResponse) && toolResponse.isError === true) ||
    answers.some(
      (answer) => isObjectRecord(answer) && answer.status === 'error',
    );
  const stamps: number[] = [];
  for (const answer of answers) {
    if (
      isObjectRecord(answer) &&
      typeof answer.lastBuildAt === 'number' &&
      Number.isFinite(answer.lastBuildAt) &&
      !stamps.includes(answer.lastBuildAt)
    ) {
      stamps.push(answer.lastBuildAt);
    }
  }
  return {
    failed,
    lastBuildAt: stamps.length === 1 ? (stamps[0] ?? null) : null,
  };
}

/** How the graph observed at record time relates to the tool's answer. */
type AnswerAttribution = 'attributed' | 'unattributable' | 'mismatch';

/**
 * Binds the answer to the consistent post-call graph `current`. A reported
 * stamp must equal the current one and, for a read-only answer, belong to the
 * database instance seen before the call. A stampless answer needs the
 * pre-call stamp and instance to hold; after a `stat`-only snapshot it holds
 * for its turn at most, and any graph change is a mismatch. An unreadable
 * pre-call graph or a missing snapshot never attributes.
 */
function attributeAnswer(
  call: ClaudeCodeGraphToolCall,
  before: CallSnapshot | undefined,
  current: GraphState,
): AnswerAttribution {
  const startedOn = before?.graph ?? null;
  if (call.answeredBuildAt !== null) {
    if (current === null) return 'unattributable';
    // No graph now: the answer's build is gone.
    if (current === 'absent') return 'mismatch';
    const stamp = Number(current.stamp);
    if (!Number.isFinite(stamp)) return 'unattributable';
    if (stamp !== call.answeredBuildAt) return 'mismatch';
    if (startedOn === null) return 'unattributable';
    // A read-only answer cannot tell a copy carrying the same stamp from the
    // database it read; a build may create or publish a new instance.
    return call.rebuildsGraph ||
      (startedOn !== 'absent' &&
        startedOn.graph.instance === current.graph.instance)
      ? 'attributed'
      : 'mismatch';
  }
  if (
    startedOn !== null &&
    startedOn !== 'absent' &&
    startedOn.stamp === null &&
    current !== null &&
    !call.rebuildsGraph
  ) {
    // No pre-call stamp, so a read-only answer cannot be told from a build
    // that landed during the call: any graph change is a known mismatch.
    return current !== 'absent' && sameGraph(startedOn.graph, current.graph)
      ? 'unattributable'
      : 'mismatch';
  }
  if (!isStampedGraph(startedOn) || current === null) return 'unattributable';
  // Derived analysis and WAL checkpoints change the `stat`, never the stamp.
  if (
    current !== 'absent' &&
    current.graph.instance === startedOn.graph.instance &&
    current.stamp === startedOn.stamp
  ) {
    return 'attributed';
  }
  // Without a reported stamp, a build or replacement during the call is a
  // known mismatch for a read-only answer and unattributable for a build.
  return call.rebuildsGraph ? 'unattributable' : 'mismatch';
}

/**
 * Records a successful graph tool call as orienting the scope's chat. The
 * orientation is durable only when the graph observed now is the one the
 * tool answered from and the pre-call graph and HEADs were readable. A known
 * mismatch, or HEAD moving during the call, leaves the chat unoriented at
 * once. Otherwise a still-valid earlier orientation is kept, and failing
 * that, the answer holds for this turn only.
 */
export async function recordClaudeCodeGraphOrientation(
  scope: ClaudeCodeGraphOrientationScope,
  call?: ClaudeCodeGraphToolCall,
): Promise<void> {
  const key = orientationKey(scope);
  const before =
    call?.toolUseId === undefined
      ? undefined
      : pendingCalls.get(pendingCallKey(scope, call.toolUseId));
  if (call?.toolUseId !== undefined) {
    pendingCalls.delete(pendingCallKey(scope, call.toolUseId));
  }
  const [{ heads, membership }, current] = await Promise.all([
    readRepositoryIdentity(scope),
    readStampedGraph(scope),
  ]);
  // Omitting `call` records unbracketed, as in tests of the identity itself.
  const attribution =
    call === undefined ? 'attributed' : attributeAnswer(call, before, current);
  if (
    attribution === 'mismatch' ||
    (before !== undefined &&
      (changed(before.membership, membership) || changed(before.heads, heads)))
  ) {
    orientations.delete(key);
    return;
  }
  const durable =
    attribution === 'attributed' &&
    heads !== null &&
    (call === undefined || (before !== undefined && before.heads !== null)) &&
    isStampedGraph(current)
      ? current
      : null;
  if (durable === null && (await keepsValidOrientation(scope, key))) return;
  remember(key, {
    graph: durable?.graph ?? null,
    stamp: durable?.stamp ?? null,
    heads: durable === null ? null : heads,
    membership,
    turn: scope.turn,
  });
}

/**
 * Whether the graph still holds the build the chat oriented on. A new
 * database instance or a deleted graph is a replacement. Changed content in
 * the same instance is a rebuild exactly when the build stamp changed;
 * otherwise it is derived analysis or another non-build write and is adopted.
 */
async function graphStillOriented(
  scope: ClaudeCodeGraphOrientationScope,
  entry: OrientationEntry,
  current: GraphIdentity | 'absent' | null,
  shareStampRead: boolean,
): Promise<boolean> {
  const recorded = entry.graph;
  if (recorded === null || current === null) return true;
  if (current === 'absent' || recorded.instance !== current.instance) {
    return false;
  }
  if (recorded.content === current.content) return true;
  const stamped = shareStampRead
    ? await readStampedGraphForProbe(scope, current)
    : await readStampedGraph(scope, current);
  if (
    !isStampedGraph(stamped) ||
    stamped.graph.instance !== recorded.instance ||
    stamped.stamp !== entry.stamp
  ) {
    return false;
  }
  entry.graph = stamped.graph;
  return true;
}

async function revalidateOrientation(
  scope: ClaudeCodeGraphOrientationScope,
  key: string,
  entry: OrientationEntry,
  shareStampRead: boolean,
): Promise<boolean> {
  const identity = await readOrientationIdentity(scope);
  // Another check already dropped or replaced the entry: skip the stamp read.
  if (orientations.get(key) !== entry) return false;
  const oriented =
    !changed(entry.membership, identity.membership) &&
    !changed(entry.heads, identity.heads) &&
    (await graphStillOriented(scope, entry, identity.graph, shareStampRead));
  if (orientations.get(key) !== entry) return false;
  if (!oriented) {
    orientations.delete(key);
    return false;
  }
  const verifiable =
    entry.graph !== null &&
    isGraphIdentity(identity.graph) &&
    entry.stamp !== null &&
    entry.heads !== null &&
    identity.heads !== null;
  if (!verifiable && entry.turn !== scope.turn) {
    // An unverifiable orientation never outlives its turn, even if a later
    // read succeeds.
    orientations.delete(key);
    return false;
  }
  remember(key, entry);
  return true;
}

/**
 * Whether the chat's existing orientation outranks a recording that cannot
 * be bound durably: it is still current, or a newer record replaced it.
 */
async function keepsValidOrientation(
  scope: ClaudeCodeGraphOrientationScope,
  key: string,
): Promise<boolean> {
  const previous = orientations.get(key);
  if (previous === undefined) return false;
  // Part of a record: never shares a probe's stamp read.
  if (await revalidateOrientation(scope, key, previous, false)) return true;
  return orientations.has(key);
}

/**
 * Whether the scope's chat is still oriented: the graph's repository set is
 * unchanged, no graph repository HEAD moved, the graph database was not
 * replaced or deleted, and no build has run since. An unreadable identity
 * holds only within the recording turn.
 *
 * Hooks call this only for a call they would otherwise steer, so its async
 * repository lookup, stat and ref reads (and, after a graph change, one
 * read-worker stamp read shared by concurrent checks) replace a denial and
 * the model round trip it forces.
 */
export async function isClaudeCodeGraphOrientationCurrent(
  scope: ClaudeCodeGraphOrientationScope,
): Promise<boolean> {
  const key = orientationKey(scope);
  const entry = orientations.get(key);
  if (!entry) return false;
  return revalidateOrientation(scope, key, entry, true);
}

/** Test seam: replace individual identity readers; `null` restores them. */
export function setClaudeCodeGraphOrientationReadersForTests(
  overrides: Partial<ClaudeCodeGraphOrientationReaders> | null,
): void {
  readers = overrides ? { ...defaultReaders, ...overrides } : defaultReaders;
}

export function resetClaudeCodeGraphOrientationForTests(): void {
  orientations.clear();
  pendingCalls.clear();
  sharedStampReads.clear();
  readers = defaultReaders;
}
