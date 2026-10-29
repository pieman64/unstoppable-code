import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  extname,
  isAbsolute as isAbsolutePath,
  join,
  relative,
} from 'node:path';
import {
  getCoworkArtifactsIndexFilePath,
  getCoworkManagedSubdir,
} from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import {
  COWORK_HOME_WORKTREE_ID,
  DEFAULT_CHAT_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_NAME,
  DEFAULT_COWORK_WORKSPACE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type CoworkWorkspaceSettings,
  type StandaloneProjectFile,
} from '@canopy/desktop-shared/types';
import { hasMigrationRun, markMigrationRun } from './migrations';
import {
  loadCoworkMigrationMapCache,
  readCoworkMigrationMap,
  writeCoworkMigrationMap,
} from './cowork-migration-map';
import {
  getChatPluginsRootDir,
  getChatProjectChatTabsFilePath,
  getChatProjectDir,
  getChatProjectHistoryDir,
  getChatProjectsFilePath,
  getStandaloneChatDir,
  getWorkspaceChatHistoryDir,
  getWorkspaceChatTabsFilePath,
  getWorkspaceHomeDir,
} from './paths';
import { recordMigratedCoworkWorkspace } from './cowork-workspace-records';
import { readStandaloneProjectFile } from './standalone-project-state';
import { ensureAgentsMdSymlink } from './instruction-files';
import { isErrnoException, isRecord } from './type-guards';

export const COWORK_WORKSPACES_MIGRATION_KEY = 'cowork_workspaces';
const COWORK_DEFAULT_WORKSPACE_ID = DEFAULT_COWORK_WORKSPACE_ID;

// ---------------------------------------------------------------------------
// Generic fs helpers (EXDEV-safe move + non-destructive merge), mirroring
// app-managed-workspaces.ts.
// ---------------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function movePath(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EXDEV') {
      throw error;
    }
    await cp(source, destination, { recursive: true, force: false });
    await rm(source, { recursive: true, force: true });
  }
}

/**
 * Writes `content` to `filePath` atomically: the payload lands fully-formed
 * in a temp file in the SAME directory as `filePath` (so the later `rename`
 * stays on one filesystem and is therefore atomic), then that temp file is
 * renamed over the final path. A process crash/interrupt can only ever leave
 * either the untouched original `filePath` or a stray, harmless temp file
 * behind — it can never leave a truncated/partial file at `filePath` itself.
 * Callers that gate a source deletion on the destination's existence can
 * therefore trust that an existing destination is complete.
 */
async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.migrate-tmp`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

async function removeIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    const code = isErrnoException(error) ? error.code : undefined;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') {
      throw error;
    }
  }
}

async function mergeMissingEntries(
  sourceDir: string,
  destinationDir: string,
): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    if (!(await pathExists(destination))) {
      await movePath(source, destination);
      continue;
    }
    if (entry.isDirectory()) {
      const destinationStat = await stat(destination);
      if (destinationStat.isDirectory()) {
        await mergeMissingEntries(source, destination);
        await removeIfEmpty(source);
      }
    }
  }
  await removeIfEmpty(sourceDir);
}

async function listDirectoryNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Path rewriting for persisted absolute paths that pointed inside the old
// project directory.
// ---------------------------------------------------------------------------

function relativeInside(parent: string, child: string): string | null {
  const rel = relative(parent, child);
  if (rel === '') {
    return '';
  }
  if (rel.startsWith('..') || isAbsolutePath(rel)) {
    return null;
  }
  return rel;
}

/**
 * Rewrites an absolute path that pointed inside the legacy chat-project
 * directory to its new home-relative location. Non-absolute paths and paths
 * outside the legacy project dir are returned unchanged.
 */
function rewriteLegacyProjectPath(
  path: string,
  legacyProjectDir: string,
  home: string,
): string {
  if (!isAbsolutePath(path)) {
    return path;
  }

  const workspaceDir = join(legacyProjectDir, 'workspace');
  const attachmentsDir = join(workspaceDir, 'attachments');
  const notesDir = join(workspaceDir, 'notes');
  const promptsDir = join(workspaceDir, 'prompts');
  const artifactsDir = join(workspaceDir, 'artifacts');

  const inAttachments = relativeInside(attachmentsDir, path);
  if (inAttachments !== null) {
    return join(getCoworkManagedSubdir(home, 'attachments'), inAttachments);
  }
  const inNotes = relativeInside(notesDir, path);
  if (inNotes !== null) {
    return join(getCoworkManagedSubdir(home, 'notes'), inNotes);
  }
  const inPrompts = relativeInside(promptsDir, path);
  if (inPrompts !== null) {
    return join(getCoworkManagedSubdir(home, 'prompts'), inPrompts);
  }
  const inArtifacts = relativeInside(artifactsDir, path);
  if (inArtifacts !== null) {
    return join(home, inArtifacts);
  }
  const inProject = relativeInside(legacyProjectDir, path);
  if (inProject !== null) {
    return join(home, inProject);
  }
  return path;
}

// ---------------------------------------------------------------------------
// Generic JSON-record path rewriting for persisted chat data. Operates on
// plain `Record<string, unknown>` shapes (rather than the strong
// `PersistedChatTab`/`PersistedChatMessage` types) so unknown/extra fields are
// preserved untouched via spread, without needing unsafe casts.
// ---------------------------------------------------------------------------

/**
 * `Array.isArray` narrows an `unknown` value to `any[]`, which then leaks
 * `any` through every `.map()` callback below. Routing through an explicit
 * type predicate narrows to `unknown[]` instead, so downstream `typeof`/
 * `isRecord` checks stay fully typed.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function rewriteMessageRecord(
  message: Record<string, unknown>,
  rewrite: (path: string) => string,
): Record<string, unknown> {
  return {
    ...message,
    attachmentPaths: isUnknownArray(message.attachmentPaths)
      ? message.attachmentPaths.map((entry) =>
          typeof entry === 'string' ? rewrite(entry) : entry,
        )
      : message.attachmentPaths,
    attachmentPromptContexts: isUnknownArray(message.attachmentPromptContexts)
      ? message.attachmentPromptContexts.map((entry) =>
          isRecord(entry) && typeof entry.attachmentPath === 'string'
            ? { ...entry, attachmentPath: rewrite(entry.attachmentPath) }
            : entry,
        )
      : message.attachmentPromptContexts,
  };
}

function rewriteTabRecord(
  tab: Record<string, unknown>,
  rewrite: (path: string) => string,
): Record<string, unknown> {
  return {
    ...tab,
    filePath:
      typeof tab.filePath === 'string' ? rewrite(tab.filePath) : tab.filePath,
    pendingRevertAttachmentPath:
      typeof tab.pendingRevertAttachmentPath === 'string'
        ? rewrite(tab.pendingRevertAttachmentPath)
        : tab.pendingRevertAttachmentPath,
    messages: isUnknownArray(tab.messages)
      ? tab.messages.map((message) =>
          isRecord(message) ? rewriteMessageRecord(message, rewrite) : message,
        )
      : tab.messages,
  };
}

function rewriteChatTabsFileRecord(
  record: Record<string, unknown>,
  rewrite: (path: string) => string,
): Record<string, unknown> {
  return {
    ...record,
    tabs: isUnknownArray(record.tabs)
      ? record.tabs.map((tab) =>
          isRecord(tab) ? rewriteTabRecord(tab, rewrite) : tab,
        )
      : record.tabs,
  };
}

function getTabId(tab: unknown): string | null {
  return isRecord(tab) && typeof tab.id === 'string' ? tab.id : null;
}

function isChatTabsFileRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isUnknownArray(value.tabs) &&
    typeof value.activeTabId === 'string'
  );
}

function getPendingQuestionRequestId(question: unknown): string | null {
  return isRecord(question) && typeof question.requestId === 'string'
    ? question.requestId
    : null;
}

function getPendingQuestionChatId(question: unknown): string | null {
  return isRecord(question) && typeof question.chatId === 'string'
    ? question.chatId
    : null;
}

function mergePendingQuestions(
  destination: unknown,
  source: unknown,
  chatIds: ReadonlySet<string>,
): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();

  for (const question of [
    ...(isUnknownArray(destination) ? destination : []),
    ...(isUnknownArray(source) ? source : []),
  ]) {
    const requestId = getPendingQuestionRequestId(question);
    const chatId = getPendingQuestionChatId(question);
    if (requestId === null || chatId === null) {
      continue;
    }
    if (seen.has(requestId) || !chatIds.has(chatId)) {
      continue;
    }
    seen.add(requestId);
    merged.push(question);
  }

  return merged;
}

/**
 * Union two `ChatTabsFile` records by tab id. Destination tabs win on an id
 * collision and keep their order; legacy source tabs not already present are
 * appended after them. The destination's `activeTabId` is preserved (it
 * reflects the live session that already wrote `home.json`), falling back to
 * the source's only when the destination has none.
 *
 * File-level pending ask-user prompts are merged in the same destination-first
 * order, deduped by request id, and filtered to prompts whose chat tab still
 * exists after the tab merge.
 *
 * This exists so {@link moveChatTabs} can safely reconcile a legacy
 * `chat-tabs.json` with a `home.json` that a different code path already
 * created (most notably the always-present default cowork workspace, whose
 * `home.json` is written by ordinary chat provisioning independent of this
 * migration). Merging — rather than skipping and deleting the source — is what
 * prevents a pre-existing/starter `home.json` from silently discarding a
 * legacy project's live conversations.
 */
function mergeChatTabsRecords(
  destination: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const destinationTabs = isUnknownArray(destination.tabs)
    ? destination.tabs
    : [];
  const sourceTabs = isUnknownArray(source.tabs) ? source.tabs : [];

  const seen = new Set<string>();
  for (const tab of destinationTabs) {
    const id = getTabId(tab);
    if (id !== null) {
      seen.add(id);
    }
  }

  const mergedTabs = [...destinationTabs];
  for (const tab of sourceTabs) {
    const id = getTabId(tab);
    if (id !== null && seen.has(id)) {
      continue;
    }
    if (id !== null) {
      seen.add(id);
    }
    mergedTabs.push(tab);
  }

  const activeTabId =
    typeof destination.activeTabId === 'string'
      ? destination.activeTabId
      : source.activeTabId;
  const pendingQuestions = mergePendingQuestions(
    destination.pendingQuestions,
    source.pendingQuestions,
    seen,
  );
  const merged: Record<string, unknown> = {
    ...destination,
    tabs: mergedTabs,
    ...(activeTabId !== undefined ? { activeTabId } : {}),
  };
  if (pendingQuestions.length > 0) {
    merged.pendingQuestions = pendingQuestions;
  } else {
    delete merged.pendingQuestions;
  }

  return merged;
}

function rewritePinnedContextArray(
  value: unknown,
  rewrite: (path: string) => string,
): unknown {
  if (!isUnknownArray(value)) {
    return value;
  }
  return value.map((entry) =>
    isRecord(entry) && typeof entry.path === 'string'
      ? { ...entry, path: rewrite(entry.path) }
      : entry,
  );
}

function rewriteChatMetaRecord(
  record: Record<string, unknown>,
  rewrite: (path: string) => string,
): Record<string, unknown> {
  return {
    ...record,
    pinnedContext: rewritePinnedContextArray(record.pinnedContext, rewrite),
  };
}

function rewriteConversationRecord(
  record: Record<string, unknown>,
  rewrite: (path: string) => string,
): Record<string, unknown> {
  return {
    ...record,
    tab: isRecord(record.tab)
      ? rewriteTabRecord(record.tab, rewrite)
      : record.tab,
  };
}

/**
 * Rewrites a JSON file in place. The read/parse and the write are handled
 * separately and deliberately conservatively:
 *  - A missing file (`ENOENT`) is the expected "nothing to rewrite" case and
 *    is skipped silently.
 *  - A file that exists but fails to parse is NOT treated the same as a
 *    missing file: it means the data predates this migration in a broken
 *    state (this function's own writes are atomic via `writeFileAtomic` and
 *    can never produce a truncated file here). Rather than risk destroying
 *    user data by writing over it with a best-effort partial rewrite, the
 *    file is left completely untouched and the caller is allowed to proceed
 *    (e.g. move the containing directory as-is) instead of throwing the
 *    whole migration out.
 *  - The write itself goes through {@link writeFileAtomic} so an interrupted
 *    process can never leave a half-written file at `filePath`.
 */
async function rewriteJsonFileInPlace(
  filePath: string,
  transform: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return;
    }
    // Some other read failure (e.g. a permission error). Leave whatever is
    // on disk untouched rather than throwing the whole migration out.
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Existing-but-corrupt file: leave it untouched (see doc comment above).
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }
  const rewritten = transform(parsed);
  await writeFileAtomic(filePath, `${JSON.stringify(rewritten, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Legacy chat-project enumeration
// ---------------------------------------------------------------------------

async function readLegacyProjectsIndexEntries(): Promise<
  Array<{ id: string; name: string }>
> {
  try {
    const raw = await readFile(getChatProjectsFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.projects)
    ) {
      return [];
    }
    const result: Array<{ id: string; name: string }> = [];
    for (const entry of parsed.projects) {
      if (
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.name === 'string'
      ) {
        result.push({ id: entry.id, name: entry.name });
      }
    }
    return result;
  } catch {
    return [];
  }
}

async function listOrderedLegacyProjectIds(): Promise<{
  legacyIds: string[];
  fallbackNameById: Map<string, string>;
}> {
  const fallbackNameById = new Map<string, string>();
  for (const entry of await readLegacyProjectsIndexEntries()) {
    fallbackNameById.set(entry.id, entry.name);
  }

  const defaultExists = await pathExists(
    getChatProjectDir(DEFAULT_CHAT_PROJECT_ID),
  );

  const dirIds = new Set(
    await listDirectoryNames(join(getStandaloneChatDir(), 'projects')),
  );
  for (const id of Array.from(fallbackNameById.keys())) {
    if (id !== DEFAULT_CHAT_PROJECT_ID) {
      dirIds.add(id);
    }
  }

  const otherIds = Array.from(dirIds).sort((left, right) =>
    left.localeCompare(right),
  );

  return {
    legacyIds: defaultExists
      ? [DEFAULT_CHAT_PROJECT_ID, ...otherIds]
      : otherIds,
    fallbackNameById,
  };
}

// ---------------------------------------------------------------------------
// Workspace id allocation
// ---------------------------------------------------------------------------

function candidateWorkspaceId(legacyId: string): string {
  return legacyId === DEFAULT_CHAT_PROJECT_ID
    ? COWORK_DEFAULT_WORKSPACE_ID
    : legacyId;
}

// ---------------------------------------------------------------------------
// Cowork settings construction
// ---------------------------------------------------------------------------

function buildCoworkSettings(
  projectFile: StandaloneProjectFile | null,
  legacyProjectId: string,
): CoworkWorkspaceSettings | undefined {
  // Migrated workspaces carry legacy chat-history snapshots and per-chat
  // archives. Seed `null` (not an explicit day count) so the container layer
  // still gets the default-on resolution while `applyArchiveRetention` never
  // retroactively purges data the legacy install preserved indefinitely.
  if (!projectFile) {
    return legacyProjectId === DEFAULT_CHAT_PROJECT_ID
      ? { archiveRetentionDays: null }
      : undefined;
  }

  // Legacy `projectPinnedContext`/`ui`/`searchIndexingEnabled` fields are
  // intentionally dropped: the pinned-context, cowork UI-state, and search
  // features they configured no longer exist.
  return {
    createdAt: projectFile.createdAt,
    description: projectFile.description,
    defaultModel: projectFile.defaultModel,
    defaultPresetId: projectFile.defaultPresetId,
    presets: projectFile.presets,
    archiveRetentionDays:
      projectFile.settings?.archiveRetentionDays !== undefined
        ? projectFile.settings.archiveRetentionDays
        : legacyProjectId === DEFAULT_CHAT_PROJECT_ID
          ? null
          : undefined,
  };
}

// ---------------------------------------------------------------------------
// Per-project data moves
// ---------------------------------------------------------------------------

async function moveChatTabs(
  legacyId: string,
  workspaceId: string,
  legacyProjectDir: string,
  home: string,
): Promise<void> {
  const source = getChatProjectChatTabsFilePath(legacyId);
  const destination = getWorkspaceChatTabsFilePath(
    workspaceId,
    COWORK_HOME_WORKTREE_ID,
  );

  if (!(await pathExists(source))) {
    return;
  }

  const rewrite = (path: string): string =>
    rewriteLegacyProjectPath(path, legacyProjectDir, home);

  let sourceRaw: string;
  try {
    sourceRaw = await readFile(source, 'utf8');
  } catch {
    return;
  }

  // Source exists but is corrupt: never delete it, so its data survives for
  // manual recovery / a future retry rather than being silently dropped.
  const sourceParsed: unknown = JSON.parse(sourceRaw);

  if (!isChatTabsFileRecord(sourceParsed)) {
    throw new Error(`Invalid legacy chat tabs file: ${source}`);
  }

  const rewrittenSource = rewriteChatTabsFileRecord(sourceParsed, rewrite);

  // A destination `home.json` can already exist for reasons unrelated to a
  // completed prior migration — most importantly the always-present default
  // cowork workspace, whose `home.json` is written by ordinary chat/starter
  // provisioning before this migration runs. Blindly skipping + deleting the
  // source in that case is how a starter `home.json` silently discarded a
  // legacy project's live conversations. Instead, MERGE the legacy tabs into
  // whatever is already there (union by tab id; live destination tabs win).
  let payload: unknown = rewrittenSource;
  let destinationParsed: unknown = null;
  try {
    destinationParsed = JSON.parse(await readFile(destination, 'utf8'));
  } catch {
    // Missing or corrupt destination: fall back to writing the valid legacy
    // source verbatim — never worse than the pre-existing state, and it
    // recovers the source data into a usable `home.json`.
    destinationParsed = null;
  }
  if (isChatTabsFileRecord(destinationParsed)) {
    payload = mergeChatTabsRecords(destinationParsed, rewrittenSource);
  }

  // Write the destination atomically FIRST, then only delete the source once
  // that write has fully landed. If the process is interrupted mid-write, the
  // destination is left unchanged (never truncated) and the source is still
  // intact, so a retry starts from the same safe state and never loses tabs.
  await writeFileAtomic(destination, `${JSON.stringify(payload, null, 2)}\n`);
  await rm(source, { force: true });
}

async function moveOneHistoryChat(
  legacyId: string,
  workspaceId: string,
  chatId: string,
  legacyProjectDir: string,
  home: string,
): Promise<void> {
  const sourceDir = join(getChatProjectHistoryDir(legacyId), chatId);
  if (!(await pathExists(sourceDir))) {
    return;
  }

  const rewrite = (path: string): string =>
    rewriteLegacyProjectPath(path, legacyProjectDir, home);

  await rewriteJsonFileInPlace(join(sourceDir, 'meta.json'), (record) =>
    rewriteChatMetaRecord(record, rewrite),
  );
  await rewriteJsonFileInPlace(join(sourceDir, 'conversation.json'), (record) =>
    rewriteConversationRecord(record, rewrite),
  );

  const destinationDir = getWorkspaceChatHistoryDir(workspaceId, chatId);
  if (await pathExists(destinationDir)) {
    await mergeMissingEntries(sourceDir, destinationDir);
    return;
  }
  await movePath(sourceDir, destinationDir);
}

async function moveHistoryDirs(
  legacyId: string,
  workspaceId: string,
  legacyProjectDir: string,
  home: string,
): Promise<void> {
  const historyDir = getChatProjectHistoryDir(legacyId);
  const chatIds = await listDirectoryNames(historyDir);
  for (const chatId of chatIds) {
    await moveOneHistoryChat(
      legacyId,
      workspaceId,
      chatId,
      legacyProjectDir,
      home,
    );
  }
  await removeIfEmpty(historyDir);
}

async function moveManagedSubdirIfPresent(
  source: string,
  destination: string,
): Promise<void> {
  if (!(await pathExists(source))) {
    return;
  }
  if (await pathExists(destination)) {
    await mergeMissingEntries(source, destination);
    return;
  }
  await movePath(source, destination);
}

async function allocateNonCollidingName(
  dir: string,
  name: string,
): Promise<string> {
  if (!(await pathExists(join(dir, name)))) {
    return name;
  }
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let suffix = 2;
  let candidate = `${base}-migrated-${suffix}${ext}`;
  while (await pathExists(join(dir, candidate))) {
    suffix += 1;
    candidate = `${base}-migrated-${suffix}${ext}`;
  }
  return candidate;
}

/**
 * Moves each top-level artifact into the `home/` root, renaming on
 * collision. Returns a rename map (old name -> new name) so the caller can
 * keep `artifacts-index.json`'s `relativePath` entries in sync — otherwise a
 * collision-renamed artifact would silently desync from its index entry.
 */
async function moveArtifactsToHomeRoot(
  artifactsDir: string,
  home: string,
): Promise<Map<string, string>> {
  const renames = new Map<string, string>();
  if (!(await pathExists(artifactsDir))) {
    return renames;
  }
  const entries = await readdir(artifactsDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(artifactsDir, entry.name);
    const destinationName = await allocateNonCollidingName(home, entry.name);
    if (destinationName !== entry.name) {
      renames.set(entry.name, destinationName);
    }
    await movePath(source, join(home, destinationName));
  }
  await removeIfEmpty(artifactsDir);
  return renames;
}

function rewriteArtifactIndexItems(
  record: Record<string, unknown>,
  renames: Map<string, string>,
): Record<string, unknown> {
  if (!isRecord(record.items)) {
    return record;
  }
  const items: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(record.items)) {
    if (isRecord(value) && typeof value.relativePath === 'string') {
      const renamed = renames.get(value.relativePath);
      items[id] = renamed ? { ...value, relativePath: renamed } : value;
    } else {
      items[id] = value;
    }
  }
  return { ...record, items };
}

async function restructureHomeInPlace(home: string): Promise<void> {
  const workspaceDir = join(home, 'workspace');

  await moveManagedSubdirIfPresent(
    join(workspaceDir, 'notes'),
    getCoworkManagedSubdir(home, 'notes'),
  );
  await moveManagedSubdirIfPresent(
    join(workspaceDir, 'prompts'),
    getCoworkManagedSubdir(home, 'prompts'),
  );
  await moveManagedSubdirIfPresent(
    join(workspaceDir, 'attachments'),
    getCoworkManagedSubdir(home, 'attachments'),
  );
  const artifactRenames = await moveArtifactsToHomeRoot(
    join(workspaceDir, 'artifacts'),
    home,
  );

  const artifactsIndexSource = join(home, 'artifacts-index.json');
  const artifactsIndexDestination = getCoworkArtifactsIndexFilePath(home);
  if (await pathExists(artifactsIndexSource)) {
    if (artifactRenames.size > 0) {
      await rewriteJsonFileInPlace(artifactsIndexSource, (record) =>
        rewriteArtifactIndexItems(record, artifactRenames),
      );
    }
    if (await pathExists(artifactsIndexDestination)) {
      await rm(artifactsIndexSource, { force: true });
    } else {
      await movePath(artifactsIndexSource, artifactsIndexDestination);
    }
  }

  await rm(join(home, 'derived'), { recursive: true, force: true });
  await rm(join(home, '.git'), { recursive: true, force: true });
  await rm(join(home, 'project.json'), { force: true });
  await removeIfEmpty(workspaceDir);

  try {
    await ensureAgentsMdSymlink(home);
  } catch {
    // AGENTS.md compatibility-file creation is non-fatal: CLAUDE.md itself is
    // authoritative. Windows uses a hard link or copy and never a symlink.
  }
}

async function moveAndRestructureFolder(
  legacyProjectDir: string,
  home: string,
): Promise<void> {
  if (await pathExists(legacyProjectDir)) {
    if (await pathExists(home)) {
      await mergeMissingEntries(legacyProjectDir, home);
    } else {
      await movePath(legacyProjectDir, home);
    }
  }
  if (await pathExists(home)) {
    await restructureHomeInPlace(home);
  }
}

async function moveChatPluginsDir(
  legacyId: string,
  workspaceId: string,
): Promise<void> {
  const source = join(
    getChatPluginsRootDir(),
    STANDALONE_CHAT_PROJECT_ID,
    legacyId,
  );
  const destination = join(
    getChatPluginsRootDir(),
    workspaceId,
    COWORK_HOME_WORKTREE_ID,
  );
  try {
    if (!(await pathExists(source))) {
      return;
    }
    if (await pathExists(destination)) {
      await mergeMissingEntries(source, destination);
      return;
    }
    await movePath(source, destination);
  } catch {
    // Best-effort: installed chat capability assets re-resolve on next use if
    // this move fails.
  }
}

// ---------------------------------------------------------------------------
// Per-project orchestration
// ---------------------------------------------------------------------------

async function migrateOneProject(
  legacyId: string,
  fallbackName: string | undefined,
): Promise<string> {
  const legacyProjectDir = getChatProjectDir(legacyId);

  const projectFile = await readStandaloneProjectFile(legacyId);
  const workspaceId = await recordMigratedCoworkWorkspace({
    source: 'legacy_cowork_migration',
    legacyId,
    candidateId: candidateWorkspaceId(legacyId),
    name:
      legacyId === DEFAULT_CHAT_PROJECT_ID
        ? DEFAULT_CHAT_PROJECT_NAME
        : projectFile?.name?.trim() || fallbackName?.trim() || legacyId,
    color: projectFile?.color,
    cowork: buildCoworkSettings(projectFile, legacyId),
  });
  const home = getWorkspaceHomeDir(workspaceId);

  await moveChatTabs(legacyId, workspaceId, legacyProjectDir, home);
  await moveHistoryDirs(legacyId, workspaceId, legacyProjectDir, home);
  await moveAndRestructureFolder(legacyProjectDir, home);
  await moveChatPluginsDir(legacyId, workspaceId);

  return workspaceId;
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

async function finalizeStandaloneChatTree(): Promise<void> {
  const standaloneDir = getStandaloneChatDir();
  await rm(getChatProjectsFilePath(), { force: true });
  await rm(join(standaloneDir, '.git'), { recursive: true, force: true });
  await rm(join(standaloneDir, '.gitignore'), { force: true });
  await rm(join(standaloneDir, 'CLAUDE.md'), { force: true });
  await removeIfEmpty(join(standaloneDir, 'projects'));
  await removeIfEmpty(standaloneDir);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * One-time startup migration that converts legacy standalone-chat projects
 * (`standalone-chat/default` and `standalone-chat/projects/{id}`) into cowork
 * workspaces under the unified `workspaces/` layout. Guarded by
 * `hasMigrationRun('cowork_workspaces')`; the marker is written only after
 * every legacy project has been migrated and the legacy tree removed, so an
 * interrupted run is safely retried in full on the next launch (each
 * individual move is itself idempotent — see `recordMigratedCoworkWorkspace`
 * and the per-file/per-dir existence checks throughout this module).
 *
 * Each project is migrated in isolation: one project failing (an unexpected
 * fs error, a corrupt legacy file, etc.) must not abort every other
 * project's migration. `finalizeStandaloneChatTree` and `markMigrationRun`
 * are only reached when every project in this run succeeded, so a partial
 * failure leaves the failed project's legacy directory in place to be
 * retried on the next launch, while every project that already succeeded
 * stays fully migrated (its files are moved and its id-map entry is already
 * durably persisted per-project below).
 */
export async function migrateStandaloneChatToCowork(): Promise<void> {
  await loadCoworkMigrationMapCache();

  if (await hasMigrationRun(COWORK_WORKSPACES_MIGRATION_KEY)) {
    return;
  }

  const idMap: Record<string, string> = {
    ...(await readCoworkMigrationMap()).idMap,
  };

  const failedLegacyIds: string[] = [];

  if (await pathExists(getStandaloneChatDir())) {
    const { legacyIds, fallbackNameById } = await listOrderedLegacyProjectIds();
    for (const legacyId of legacyIds) {
      try {
        const workspaceId = await migrateOneProject(
          legacyId,
          fallbackNameById.get(legacyId),
        );
        idMap[legacyId] = workspaceId;
        // Persisted after every project (not just once at the end): a project
        // that already migrated its legacy dir away is no longer re-discovered
        // by `listOrderedLegacyProjectIds` on a later retry, so its mapping
        // would otherwise be silently lost if a crash landed between this
        // project's completion and the final write below.
        await writeCoworkMigrationMap(idMap);
      } catch {
        failedLegacyIds.push(legacyId);
      }
    }
    if (failedLegacyIds.length === 0) {
      await finalizeStandaloneChatTree();
    }
  }

  await writeCoworkMigrationMap(idMap);
  if (failedLegacyIds.length === 0) {
    await markMigrationRun(COWORK_WORKSPACES_MIGRATION_KEY);
  }
}
