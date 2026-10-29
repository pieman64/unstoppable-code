import {
  type ComponentProps,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ConfirmDialog,
  HeaderActionButton,
  InlineDeleteConfirm,
  Markdown,
  markdownOptions,
  RowActionButton,
  RowActionTray,
} from '@canopy/ui-shared/components';
import {
  ChevronRightIcon,
  CloseIcon,
  PencilIcon,
  RefreshIcon,
  RerunIcon,
  SearchIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  LOCAL_MEMORY_FULL_SENTENCE_REASONS,
  type LocalMemoryConsolidationStatus,
  type LocalMemoryDocument,
  type LocalMemoryFileSummary,
  type LocalMemoryItem,
  type LocalMemoryRebuildResult,
  type LocalMemoryScopeRequest,
} from '@canopy/desktop-shared/types/local-memory';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { LoadingPlaceholder } from '@/components/shared/loading';
import { formatRelativeTime } from '@/lib/format';

function MemoryImage({ alt }: ComponentProps<'img'>): JSX.Element | null {
  return alt ? <span>{alt}</span> : null;
}

interface MemoryExplorerProps {
  scope: 'user' | 'workspace';
  projectId?: string;
  onEmptyChange?: (empty: boolean) => void;
  hideWhenEmpty?: boolean;
}

interface ExplorerContentProps {
  request: LocalMemoryScopeRequest;
  onEmptyChange?: (empty: boolean) => void;
  hideWhenEmpty?: boolean;
}

interface EditingItem {
  item: LocalMemoryItem;
  snapshot: LocalMemoryDocument;
  revision: string;
  fileKey: string;
  mode: 'edit' | 'delete';
}

interface ReadPool {
  version: number;
  queue: string[];
  active: number;
  /** Busy-parser retries already spent per file key. */
  attempts: Map<string, number>;
}

interface FileLoadState {
  document: LocalMemoryDocument | null;
  error: string | null;
  loading: boolean;
}

interface FileView {
  file: LocalMemoryFileSummary;
  title: string;
  document: LocalMemoryDocument | null;
  hoisted: LocalMemoryItem | null;
  items: LocalMemoryItem[];
  state: FileLoadState | undefined;
}

type MemoryMarkdownOptions = ReturnType<typeof markdownOptions>;

const FILE_READ_ERROR = "Couldn't open this memory file.";
/** Reads in flight at once; the main-process parser caps pending requests. */
const READ_POOL_CONCURRENCY = 4;
const READ_BUSY_RETRIES = 2;
const READ_BUSY_RETRY_DELAY_MS = 250;
const CONSOLIDATION_FAILURE_PREFIX = "Couldn't consolidate memories";
const REBUILD_FAILURE_PREFIX = "Couldn't finish rebuilding memories";
/** Internal skip/failure reasons rendered as plain-language fragments. */
const CONSOLIDATION_REASONS: Record<string, string> = {
  failed: 'the model request failed',
  'invalid-output': 'the model returned unusable output',
  'missing-input-hash': 'the run finished without a checkpoint',
  'local-memory-disabled': 'local memory is off',
  'already-running': 'another run is in progress',
  cancelled: 'memory changed while it ran',
  'no-progress': 'a run left the same notes waiting',
  undrainable: 'a saved note is too large to consolidate',
  'too-many-runs': 'too many runs were needed',
};
const ROW_CLASS =
  'group relative flex cursor-pointer list-none items-center gap-1 rounded-md px-2 py-1 text-xs fg-primary hover:bg-fg-primary/[0.04] focus-ring [&::-webkit-details-marker]:hidden';
// A long unbroken run (a flag, a path, an env var) wraps rather than pushing
// the list into a sideways scroll; code blocks keep their own scroll.
const MARKDOWN_CLASS =
  'min-w-0 text-xs fg-primary wrap-anywhere [&_p]:my-0 [&_ul]:my-0 [&_ol]:my-0 [&_li]:my-0 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_pre]:my-1 [&_pre]:overflow-auto [&_a]:fg-accent';

function itemTitle(item: LocalMemoryItem): string {
  return (
    item.text
      .replace(/^\s*#{1,6}\s+/, '')
      .trim()
      .split('\n')[0] || 'Untitled section'
  );
}

function hoistedTitle(item: LocalMemoryItem): string | undefined {
  const line = item.text.split(/\r\n?|\n/)[0];
  // Closing hashes are syntax only in ATX headings, not setext headings.
  const marker = /^ {0,3}#(?:[ \t]+|$)/.exec(line);
  if (!marker) return line.trim() || undefined;
  // Unicode whitespace is content in CommonMark, not ATX padding.
  let contentEnd = line.length;
  while (
    contentEnd > marker[0].length &&
    (line[contentEnd - 1] === ' ' || line[contentEnd - 1] === '\t')
  )
    contentEnd -= 1;
  const title = line.slice(marker[0].length, contentEnd);
  let end = title.length;
  while (end > 0 && title[end - 1] === '#') end -= 1;
  if (end === 0) return undefined;
  if (end < title.length && (title[end - 1] === ' ' || title[end - 1] === '\t'))
    return title.slice(0, end).trim() || undefined;
  return title.trim() || undefined;
}

function fileName(fileKey: string): string {
  return fileKey.replace(/^(topics|inbox)\//, '');
}

function containsItem(item: LocalMemoryItem, id: string): boolean {
  return (
    item.id === id || item.children.some((child) => containsItem(child, id))
  );
}

function includesQuery(item: LocalMemoryItem, query: string): boolean {
  return (
    item.text.toLocaleLowerCase().includes(query) ||
    item.children.some((child) => includesQuery(child, query))
  );
}

/** Keeps matching items; a heading survives when it or a descendant matches. */
function filterItems(
  items: LocalMemoryItem[],
  query: string,
): LocalMemoryItem[] {
  const kept: LocalMemoryItem[] = [];
  for (const item of items) {
    if (!includesQuery(item, query)) continue;
    kept.push(
      item.kind === 'heading'
        ? { ...item, children: filterItems(item.children, query) }
        : item,
    );
  }
  return kept;
}

function summaryKind(fileKey: string): LocalMemoryFileSummary['kind'] {
  return fileKey === 'MEMORY.md'
    ? 'index'
    : fileKey.startsWith('topics/')
      ? 'topic'
      : 'inbox';
}

/**
 * Copy for a run that failed or was skipped for a reason worth showing.
 * Blocked or unavailable memory models already carry their full user-facing
 * sentence; every other reason becomes a fragment after the shared prefix.
 * Returns null when the last run has nothing to report (success, clean,
 * cancelled).
 */
function consolidationProblem(
  status: LocalMemoryConsolidationStatus,
): string | null {
  const reason = status.lastReason;
  if (
    status.lastResult === 'skipped' &&
    (reason === null || reason === 'clean')
  )
    return null;
  if (status.lastResult !== 'failed' && status.lastResult !== 'skipped')
    return null;
  if (reason !== null && LOCAL_MEMORY_FULL_SENTENCE_REASONS.has(reason))
    return reason;
  return `${CONSOLIDATION_FAILURE_PREFIX}: ${reasonFragment(reason)}`;
}

function reasonFragment(reason: string | null | undefined): string {
  if (reason === null || reason === undefined) {
    return CONSOLIDATION_REASONS.failed;
  }
  return CONSOLIDATION_REASONS[reason] ?? reason;
}

/** Copy for a rebuild that did not finish, or null when it did. */
function rebuildProblem(result: LocalMemoryRebuildResult): string | null {
  if (result.status === 'completed') return null;
  if (
    result.reason !== undefined &&
    LOCAL_MEMORY_FULL_SENTENCE_REASONS.has(result.reason)
  ) {
    return result.reason;
  }
  return `${REBUILD_FAILURE_PREFIX}: ${reasonFragment(result.reason)}`;
}

function toggleKey(
  current: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function MemoryExplorer({
  scope,
  projectId,
  onEmptyChange,
  hideWhenEmpty,
}: MemoryExplorerProps): JSX.Element {
  if (scope === 'workspace' && !projectId) {
    return (
      <p
        className="p-4 text-s fg-secondary"
        data-testid="memory-explorer-no-project"
      >
        Choose a project to see its memories.
      </p>
    );
  }
  const request: LocalMemoryScopeRequest =
    scope === 'workspace' && projectId
      ? { scope, workspaceId: projectId }
      : { scope: 'user' };
  return (
    <ExplorerContent
      key={`${scope}:${projectId ?? ''}`}
      request={request}
      onEmptyChange={onEmptyChange}
      hideWhenEmpty={hideWhenEmpty}
    />
  );
}

function ExplorerContent({
  request,
  onEmptyChange,
  hideWhenEmpty,
}: ExplorerContentProps): JSX.Element {
  const [files, setFiles] = useState<LocalMemoryFileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [fileStates, setFileStates] = useState<Record<string, FileLoadState>>(
    {},
  );
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [collapsedHeadings, setCollapsedHeadings] = useState<
    ReadonlySet<string>
  >(new Set());
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<EditingItem | null>(null);
  const empty = !editing && files.length === 0 && listError === null;
  // Reports only once the first load ends: until then the empty list proves
  // nothing, and a remounted explorer would otherwise report it over the
  // content an earlier one found (its host starts out treating it as empty).
  useEffect(() => {
    if (loading) return;
    onEmptyChange?.(empty);
  }, [empty, loading, onEmptyChange]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const [consolidation, setConsolidation] =
    useState<LocalMemoryConsolidationStatus | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [confirmingRebuild, setConfirmingRebuild] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  // A rebuild's problem belongs to the status it arrived with; a newer run's
  // status (a later lastRunAt) replaces it.
  const [rebuildMessage, setRebuildMessage] = useState<{
    text: string;
    lastRunAt: string | null;
  } | null>(null);
  const active = useRef(true);
  const initializedExpansion = useRef(false);
  const loadedVersions = useRef(new Map<string, number>());
  const inflight = useRef(new Map<string, number>());
  const readPool = useRef<ReadPool>({
    version: -1,
    queue: [],
    active: 0,
    attempts: new Map(),
  });
  /** Keys with an IPC read outstanding, whatever refresh version started it. */
  const reading = useRef(new Set<string>());
  /** Keys parked in a busy-retry delay; they re-queue themselves. */
  const retrying = useRef(new Set<string>());
  const requestRef = useRef<LocalMemoryScopeRequest>({ scope: 'user' });
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const scope = request.scope;
  const workspaceId =
    request.scope === 'workspace' ? request.workspaceId : undefined;
  const stableRequest = useMemo<LocalMemoryScopeRequest>(
    () =>
      workspaceId ? { scope: 'workspace', workspaceId } : { scope: 'user' },
    [workspaceId],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const hasQuery = normalizedQuery !== '';
  const editingFileKey = editing?.fileKey;
  const isEditing = editing !== null;

  useEffect(
    () => (): void => {
      active.current = false;
    },
    [],
  );

  const refresh = useCallback(
    (): void => setRefreshVersion((value) => value + 1),
    [],
  );

  const openFile = useCallback((fileKey: string): void => {
    setExpandedFiles((current) =>
      current.has(fileKey) ? current : new Set(current).add(fileKey),
    );
    setQuery('');
    setScrollTarget(fileKey);
  }, []);

  useEffect(() => {
    if (!scrollTarget) return;
    const row = rowRefs.current.get(scrollTarget);
    if (row && typeof row.scrollIntoView === 'function')
      row.scrollIntoView({ block: 'nearest' });
    setScrollTarget(null);
  }, [scrollTarget]);

  const optionsForFile = useMemo(() => {
    const cache = new Map<string, MemoryMarkdownOptions>();
    return (fileKey: string): MemoryMarkdownOptions => {
      const cached = cache.get(fileKey);
      if (cached) return cached;
      const options = markdownOptions({
        img: MemoryImage,
        a: function MemoryLink({
          href,
          children,
        }: ComponentProps<'a'>): JSX.Element {
          let target: string | undefined;
          if (href && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) {
            try {
              const resolved = new URL(href, `https://memory.local/${fileKey}`);
              const candidate = decodeURIComponent(resolved.pathname.slice(1));
              if (files.some((file) => file.fileKey === candidate))
                target = candidate;
            } catch {
              target = undefined;
            }
          }
          const external = href && /^https?:\/\//i.test(href);
          if (!target && !external) return <span>{children}</span>;
          return (
            <a
              href={href}
              aria-disabled={!!target && isEditing}
              onClick={(event: MouseEvent<HTMLAnchorElement>): void => {
                event.preventDefault();
                if (target) {
                  if (!isEditing) openFile(target);
                } else if (external && href)
                  void window.api.browser.openLink({ url: href });
              }}
            >
              {children}
            </a>
          );
        },
      });
      cache.set(fileKey, options);
      return options;
    };
  }, [files, isEditing, openFile]);

  useEffect(() => {
    let current = true;
    void window.api
      .listLocalMemoryFiles(stableRequest)
      .then((nextFiles) => {
        if (!current) return;
        setFiles(nextFiles);
        setListError(null);
        setLoading(false);
        if (!initializedExpansion.current && nextFiles.length > 0) {
          initializedExpansion.current = true;
          const first =
            nextFiles.find((file) => file.kind === 'index') ?? nextFiles[0];
          setExpandedFiles(new Set([first.fileKey]));
        }
      })
      .catch(() => {
        if (!current) return;
        setListError("Couldn't load memories. Try again.");
        setLoading(false);
      });
    return (): void => {
      current = false;
    };
  }, [stableRequest, refreshVersion]);

  const settleRead = useCallback(
    (fileKey: string, version: number, state: FileLoadState): void => {
      if (!active.current || inflight.current.get(fileKey) !== version) return;
      inflight.current.delete(fileKey);
      loadedVersions.current.set(fileKey, version);
      setFileStates((current) => ({ ...current, [fileKey]: state }));
    },
    [],
  );

  /** True when the current refresh still wants a read that nobody holds. */
  const needsRead = useCallback((fileKey: string): boolean => {
    const pool = readPool.current;
    return (
      inflight.current.get(fileKey) === pool.version &&
      loadedVersions.current.get(fileKey) !== pool.version &&
      !reading.current.has(fileKey) &&
      !retrying.current.has(fileKey) &&
      !pool.queue.includes(fileKey)
    );
  }, []);

  const pump = useCallback((): void => {
    const pool = readPool.current;
    while (
      pool.active < READ_POOL_CONCURRENCY &&
      pool.queue.length > 0 &&
      active.current
    ) {
      const fileKey = pool.queue.shift();
      if (fileKey === undefined || reading.current.has(fileKey)) continue;
      const version = pool.version;
      reading.current.add(fileKey);
      pool.active += 1;
      void window.api
        .readLocalMemoryFile({ ...requestRef.current, fileKey })
        .then(
          (document) =>
            settleRead(fileKey, version, {
              document,
              error: null,
              loading: false,
            }),
          (failure: unknown) => {
            const busy =
              failure instanceof Error && /busy/i.test(failure.message);
            const attempt = pool.attempts.get(fileKey) ?? 0;
            if (busy && attempt < READ_BUSY_RETRIES) {
              pool.attempts.set(fileKey, attempt + 1);
              retrying.current.add(fileKey);
              window.setTimeout(() => {
                retrying.current.delete(fileKey);
                if (!active.current || !needsRead(fileKey)) return;
                pool.queue.push(fileKey);
                pump();
              }, READ_BUSY_RETRY_DELAY_MS);
              return;
            }
            settleRead(fileKey, version, {
              document: null,
              error: FILE_READ_ERROR,
              loading: false,
            });
          },
        )
        .finally(() => {
          reading.current.delete(fileKey);
          pool.active -= 1;
          // A refresh that arrived mid-read still wants this key: queue it
          // now, so each file has at most one read in flight at any time.
          if (active.current && needsRead(fileKey)) pool.queue.push(fileKey);
          pump();
        });
    }
  }, [needsRead, settleRead]);

  const neededKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const file of files)
      if (hasQuery || expandedFiles.has(file.fileKey)) keys.add(file.fileKey);
    if (editingFileKey) keys.add(editingFileKey);
    return Array.from(keys).sort().join('\n');
  }, [files, hasQuery, expandedFiles, editingFileKey]);

  useEffect(() => {
    // Reads go through one FIFO pool for the component's lifetime so a
    // global search never exceeds the main-process parser cap, even across
    // refreshes: a new refresh version clears the queue and the busy-retry
    // budget but keeps the shared in-flight count, and a key still being read
    // for an older version is re-queued only once that read settles.
    const pool = readPool.current;
    requestRef.current = stableRequest;
    if (pool.version !== refreshVersion) {
      pool.version = refreshVersion;
      pool.queue = [];
      pool.attempts = new Map();
    }
    for (const fileKey of neededKeys.split('\n').filter(Boolean)) {
      if (
        loadedVersions.current.get(fileKey) === refreshVersion ||
        inflight.current.get(fileKey) === refreshVersion
      )
        continue;
      inflight.current.set(fileKey, refreshVersion);
      setFileStates((current) => ({
        ...current,
        [fileKey]: {
          document: current[fileKey]?.document ?? null,
          error: current[fileKey]?.error ?? null,
          loading: true,
        },
      }));
      if (!reading.current.has(fileKey)) pool.queue.push(fileKey);
    }
    pump();
  }, [neededKeys, refreshVersion, stableRequest, pump]);

  useEffect(
    () =>
      window.api.onLocalMemoryChanged((event) => {
        if (
          event.scope === scope &&
          (event.scope === 'user' || event.workspaceId === workspaceId)
        )
          refresh();
      }),
    [scope, workspaceId, refresh],
  );

  // Main keeps a filesystem watcher on the scope while this explorer is
  // mounted, so notes written by agents or by hand arrive as change events.
  useEffect(() => {
    void window.api.watchLocalMemory(stableRequest).catch(() => undefined);
    return (): void => {
      void window.api.unwatchLocalMemory(stableRequest).catch(() => undefined);
    };
  }, [stableRequest]);

  useEffect(() => {
    let current = true;
    void window.api
      .getLocalMemoryConsolidationStatus(stableRequest)
      .then((status) => {
        if (current) setConsolidation(status);
      })
      .catch(() => undefined);
    return (): void => {
      current = false;
    };
  }, [stableRequest, refreshVersion]);

  async function consolidateNow(): Promise<void> {
    if (consolidating) return;
    setConsolidating(true);
    setRebuildMessage(null);
    try {
      const status = await window.api.consolidateLocalMemory(stableRequest);
      if (active.current) setConsolidation(status);
    } catch (failure) {
      if (active.current)
        setConsolidation((current) =>
          current
            ? {
                ...current,
                running: false,
                lastResult: 'failed',
                lastReason:
                  failure instanceof Error && failure.message
                    ? failure.message
                    : 'failed',
              }
            : current,
        );
    } finally {
      if (active.current) setConsolidating(false);
      refresh();
    }
  }

  async function rebuildNow(): Promise<void> {
    setConfirmingRebuild(false);
    if (rebuilding) return;
    setRebuilding(true);
    setRebuildMessage(null);
    try {
      const response = await window.api.rebuildLocalMemory(stableRequest);
      if (active.current) {
        setConsolidation(response.status);
        const text = rebuildProblem(response.rebuild);
        setRebuildMessage(
          text === null ? null : { text, lastRunAt: response.status.lastRunAt },
        );
      }
    } catch (failure) {
      if (active.current)
        setRebuildMessage({
          text: `${REBUILD_FAILURE_PREFIX}: ${reasonFragment(
            failure instanceof Error && failure.message
              ? failure.message
              : null,
          )}`,
          lastRunAt: consolidation?.lastRunAt ?? null,
        });
    } finally {
      if (active.current) setRebuilding(false);
      refresh();
    }
  }

  function startEditing(
    document: LocalMemoryDocument,
    item: LocalMemoryItem,
    mode: 'edit' | 'delete',
  ): void {
    setEditing({
      item,
      snapshot: document,
      revision: document.revision,
      fileKey: document.fileKey,
      mode,
    });
    setDraft(item.text);
    setMutationError(null);
  }

  function cancelEditing(): void {
    setEditing(null);
    setMutationError(null);
  }

  async function save(): Promise<void> {
    if (!editing || saving) return;
    setSaving(true);
    setMutationError(null);
    const mutation = {
      ...stableRequest,
      fileKey: editing.fileKey,
      itemId: editing.item.id,
      revision: editing.revision,
    };
    try {
      const updated =
        editing.mode === 'delete'
          ? await window.api.deleteLocalMemoryItem(mutation)
          : await window.api.updateLocalMemoryItem({
              ...mutation,
              text: draft,
            });
      setFileStates((current) => ({
        ...current,
        [editing.fileKey]: { document: updated, error: null, loading: false },
      }));
      setEditing(null);
      refresh();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '';
      setMutationError(
        /conflict|changed|revision/i.test(message)
          ? "Couldn't save this memory because the file changed. Your draft is kept; cancel, refresh, and try again."
          : "Couldn't save this memory. Your draft is kept; try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!saving) cancelEditing();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  }

  function renderEditor(): JSX.Element {
    return (
      <div
        className="space-y-2 rounded-md bg-base p-2 ring-1 ring-line-base"
        data-testid="memory-item-editor"
      >
        <textarea
          autoFocus
          aria-label="Memory content"
          rows={Math.min(12, Math.max(3, draft.split('\n').length + 1))}
          value={draft}
          onChange={(event): void => setDraft(event.target.value)}
          onKeyDown={handleDraftKeyDown}
          disabled={saving}
          className="focus-ring w-full resize-y rounded-md bg-base px-2 py-1.5 font-mono text-xs fg-primary ring-1 ring-line-base"
          data-testid="memory-item-draft"
        />
        {mutationError && (
          <p role="alert" className="text-xs fg-destructive">
            {mutationError}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(): void => {
              void save();
            }}
            disabled={saving || !draft.trim()}
            className="focus-ring rounded-md bg-accent px-2.5 py-1 text-xs font-medium fg-emphasis hover:bg-accent/90 disabled:opacity-50"
            data-testid="memory-item-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={cancelEditing}
            disabled={saving}
            className="focus-ring rounded-md px-2.5 py-1 text-xs fg-secondary hover:fg-primary"
            data-testid="memory-item-cancel"
          >
            Cancel
          </button>
          <span className="ml-auto text-2xs fg-tertiary">Markdown</span>
        </div>
      </div>
    );
  }

  function renderActions(
    document: LocalMemoryDocument,
    item: LocalMemoryItem,
    options: { editLabel: string; deletable: boolean },
  ): JSX.Element {
    const confirming =
      editing?.mode === 'delete' &&
      editing.item.id === item.id &&
      editing.fileKey === document.fileKey;
    return (
      <RowActionTray revealOnFocus forceVisible={confirming}>
        {confirming ? (
          <span data-testid="memory-item-editor">
            <InlineDeleteConfirm
              onConfirm={(): void => {
                void save();
              }}
              onCancel={cancelEditing}
              deleting={saving}
              confirmLabel={
                item.kind === 'heading' ? 'Delete heading?' : 'Delete?'
              }
              confirmTestId="memory-item-save"
              cancelTestId="memory-item-cancel"
              autoFocusConfirm
              focusRing
            />
          </span>
        ) : (
          <>
            <RowActionButton
              label={options.editLabel}
              disabled={isEditing}
              focusRing
              testId="memory-item-edit"
              onClick={(): void => startEditing(document, item, 'edit')}
            >
              <PencilIcon width={12} height={12} />
            </RowActionButton>
            {options.deletable && (
              <RowActionButton
                label="Delete"
                destructive
                disabled={isEditing}
                focusRing
                testId="memory-item-delete"
                onClick={(): void => startEditing(document, item, 'delete')}
              >
                <TrashIcon width={12} height={12} />
              </RowActionButton>
            )}
          </>
        )}
      </RowActionTray>
    );
  }

  function renderDeleteError(
    item: LocalMemoryItem,
    fileKey: string,
  ): JSX.Element | null {
    if (
      !mutationError ||
      editing?.mode !== 'delete' ||
      editing.item.id !== item.id ||
      editing.fileKey !== fileKey
    )
      return null;
    return (
      <p role="alert" className="px-2 py-0.5 text-xs fg-destructive">
        {mutationError}
      </p>
    );
  }

  function renderItem(
    document: LocalMemoryDocument,
    item: LocalMemoryItem,
  ): JSX.Element {
    const fileKey = document.fileKey;
    const editingThis =
      editing?.mode === 'edit' &&
      editing.item.id === item.id &&
      editing.fileKey === fileKey;
    if (item.kind === 'heading') {
      // Item ids are file-local byte ranges, so the file must match too.
      const keepsOpen =
        isEditing &&
        editing.fileKey === fileKey &&
        containsItem(item, editing.item.id);
      const headingKey = `${fileKey}:${item.id}`;
      return (
        <details
          key={item.id}
          open={hasQuery || keepsOpen || !collapsedHeadings.has(headingKey)}
          className="group/section"
          data-testid="memory-heading"
        >
          <summary
            onClick={(event): void => {
              if (event.defaultPrevented) return;
              event.preventDefault();
              if (keepsOpen || hasQuery) return;
              setCollapsedHeadings((current) => toggleKey(current, headingKey));
            }}
            className={`${ROW_CLASS} font-medium`}
          >
            <ChevronRightIcon
              width={12}
              height={12}
              className="shrink-0 fg-secondary transition-transform group-open/section:rotate-90"
            />
            <span
              className="min-w-0 flex-1 truncate"
              data-testid="memory-row-title"
            >
              {itemTitle(item)}
            </span>
            {renderActions(document, item, {
              editLabel: 'Edit',
              deletable: true,
            })}
          </summary>
          <div className="pl-4">
            {editingThis && renderEditor()}
            {renderDeleteError(item, fileKey)}
            {item.children.map((child) => renderItem(document, child))}
          </div>
        </details>
      );
    }
    if (editingThis) return <div key={item.id}>{renderEditor()}</div>;
    return (
      <div key={item.id}>
        <div
          className="group relative rounded-md px-2 py-1 hover:bg-fg-primary/[0.04]"
          data-testid="memory-item"
        >
          <div className={MARKDOWN_CLASS}>
            <Markdown options={optionsForFile(fileKey)}>{item.text}</Markdown>
          </div>
          {renderActions(document, item, {
            editLabel: 'Edit',
            deletable: true,
          })}
        </div>
        {renderDeleteError(item, fileKey)}
      </div>
    );
  }

  function fileView(file: LocalMemoryFileSummary): FileView | null {
    const fileKey = file.fileKey;
    const state = fileStates[fileKey];
    const document =
      editing?.fileKey === fileKey
        ? editing.snapshot
        : (state?.document ?? null);
    const first = document?.items[0];
    const hoisted =
      first && first.kind === 'heading' && first.level === 1 ? first : null;
    const title = hoisted
      ? (hoistedTitle(hoisted) ?? fileName(fileKey))
      : (file.title ?? fileName(fileKey));
    const displayItems = document
      ? hoisted
        ? [...hoisted.children, ...document.items.slice(1)]
        : document.items
      : [];
    let items = displayItems;
    if (hasQuery) {
      // A file whose read failed cannot be searched; keep its row (and its
      // Retry) visible instead of silently dropping it from the results.
      if (!document && state?.error)
        return { file, title, document, hoisted, items: [], state };
      const filtered = filterItems(displayItems, normalizedQuery);
      const titleMatches =
        title.toLocaleLowerCase().includes(normalizedQuery) ||
        fileKey.toLocaleLowerCase().includes(normalizedQuery);
      if (filtered.length > 0) items = filtered;
      else if (!titleMatches) return null;
    }
    return { file, title, document, hoisted, items, state };
  }

  function renderFile(view: FileView): JSX.Element {
    const { file, title, document, hoisted, items, state } = view;
    const fileKey = file.fileKey;
    const keepsOpen = editing?.fileKey === fileKey;
    const open = hasQuery || keepsOpen || expandedFiles.has(fileKey);
    const editingHoisted =
      hoisted !== null &&
      editing?.mode === 'edit' &&
      editing.item.id === hoisted.id &&
      editing.fileKey === fileKey;
    return (
      <details
        key={fileKey}
        open={open}
        className="group/file"
        data-testid="memory-file-section"
      >
        <summary
          ref={(element): void => {
            if (element) rowRefs.current.set(fileKey, element);
            else rowRefs.current.delete(fileKey);
          }}
          onClick={(event): void => {
            if (event.defaultPrevented) return;
            event.preventDefault();
            if (keepsOpen || hasQuery) return;
            setExpandedFiles((current) => toggleKey(current, fileKey));
          }}
          className={`${ROW_CLASS} font-semibold`}
          title={fileKey}
          data-testid="memory-file"
          data-file-key={fileKey}
        >
          <ChevronRightIcon
            width={12}
            height={12}
            className="shrink-0 fg-secondary transition-transform group-open/file:rotate-90"
          />
          <span
            className="min-w-0 flex-1 truncate"
            data-testid="memory-row-title"
          >
            {title}
          </span>
          {hoisted &&
            document &&
            renderActions(document, hoisted, {
              editLabel: 'Edit title',
              deletable: false,
            })}
        </summary>
        <div className="pl-4">
          {editingHoisted && renderEditor()}
          {document ? (
            <>
              {items.map((item) => renderItem(document, item))}
              {items.length === 0 && (
                <p className="px-2 py-1 text-xs fg-secondary">
                  This file has no saved items yet.
                </p>
              )}
            </>
          ) : state?.error ? (
            <p role="alert" className="px-2 py-1 text-xs fg-destructive">
              {state.error}{' '}
              <button
                type="button"
                onClick={refresh}
                className="focus-ring underline"
              >
                Retry
              </button>
            </p>
          ) : (
            <p className="px-2 py-1 text-2xs fg-tertiary">Opening…</p>
          )}
        </div>
      </details>
    );
  }

  function renderConsolidationStatus(): JSX.Element | null {
    if (!consolidation) return null;
    const rebuildRunning = rebuilding || consolidation.rebuilding;
    const running = consolidating || rebuildRunning || consolidation.running;
    const currentRebuildMessage =
      rebuildMessage !== null &&
      rebuildMessage.lastRunAt === consolidation.lastRunAt
        ? rebuildMessage.text
        : null;
    const problem = running
      ? null
      : (currentRebuildMessage ?? consolidationProblem(consolidation));
    const pending = consolidation.pendingNotes;
    if (!running && problem === null && pending === 0) return null;
    let message: string;
    let tone = 'fg-tertiary';
    if (running) {
      message = rebuildRunning ? 'Rebuilding memories…' : 'Consolidating…';
    } else if (problem !== null) {
      message = problem;
      tone = 'fg-destructive';
    } else {
      message = `${pending} ${pending === 1 ? 'note' : 'notes'} waiting to be consolidated`;
      if (consolidation.lastConsolidatedAt)
        message += ` · Consolidated ${formatRelativeTime(consolidation.lastConsolidatedAt)}`;
    }
    return (
      <p
        className={`flex shrink-0 flex-wrap items-baseline gap-x-2 text-2xs ${tone}`}
        data-testid="memory-consolidation-status"
        data-state={
          running ? 'running' : problem !== null ? 'problem' : 'pending'
        }
      >
        <span className="min-w-0">{message}</span>
        <button
          type="button"
          onClick={(): void => {
            void consolidateNow();
          }}
          disabled={running || isEditing}
          className="focus-ring fg-accent hover:underline disabled:opacity-50 disabled:hover:no-underline"
          data-testid="memory-consolidate"
        >
          Consolidate now
        </button>
      </p>
    );
  }

  const listedFiles =
    editing && !files.some((file) => file.fileKey === editing.fileKey)
      ? [
          {
            fileKey: editing.fileKey,
            kind: summaryKind(editing.fileKey),
            modifiedAt: '',
            sizeBytes: 0,
          },
          ...files,
        ]
      : files;
  const views = listedFiles.flatMap((file) => fileView(file) ?? []);
  const pendingSearch =
    hasQuery &&
    listedFiles.some((file) => {
      const state = fileStates[file.fileKey];
      return !state || state.loading || (!state.document && !state.error);
    });
  const groups: { kind: LocalMemoryFileSummary['kind']; label?: string }[] = [
    { kind: 'index' },
    { kind: 'topic', label: 'Topics' },
    { kind: 'inbox', label: 'Recent notes' },
  ];

  if (hideWhenEmpty && empty) return <></>;

  return (
    <div
      className="flex min-h-0 flex-col gap-2"
      data-testid={`memory-explorer-${scope}`}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md bg-base/80 px-2 ring-1 ring-line-base">
          <SearchIcon className="h-3 w-3 shrink-0 fg-secondary" />
          <input
            type="search"
            aria-label="Search memories"
            placeholder="Search memories"
            value={query}
            disabled={isEditing}
            onChange={(event): void => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-xs fg-primary outline-none placeholder:fg-secondary"
            data-testid="memory-search"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={(): void => setQuery('')}
              className="shrink-0 rounded-sm p-0.5 fg-secondary transition hover:fg-primary"
              aria-label="Clear search"
            >
              <CloseIcon className="h-3 w-3" />
            </button>
          )}
        </div>
        <HeaderActionButton
          iconOnly
          tone="neutral"
          onClick={refresh}
          aria-label="Refresh memories"
          data-testid="memory-refresh"
        >
          <RefreshIcon width={14} height={14} />
        </HeaderActionButton>
        <HeaderActionButton
          iconOnly
          tone="neutral"
          onClick={(): void => setConfirmingRebuild(true)}
          disabled={
            isEditing ||
            rebuilding ||
            consolidating ||
            consolidation?.running === true
          }
          aria-label="Rebuild memories"
          data-testid="memory-rebuild"
        >
          <RerunIcon width={14} height={14} />
        </HeaderActionButton>
      </div>
      {confirmingRebuild && (
        <ConfirmDialog
          title="Rebuild memories?"
          message={
            <>
              {scope === 'user'
                ? 'Your memories are rebuilt'
                : "This project's memories are rebuilt"}{' '}
              from every saved note and import with the memory model. The
              current index and topics are replaced after a snapshot of them is
              saved. This can take several minutes.
            </>
          }
          confirmLabel="Rebuild memories"
          destructive
          onConfirm={(): void => {
            void rebuildNow();
          }}
          onCancel={(): void => setConfirmingRebuild(false)}
          dataTestId="memory-rebuild-dialog"
          confirmTestId="memory-rebuild-confirm"
        />
      )}
      {renderConsolidationStatus()}
      {listError && (
        <p role="alert" className="shrink-0 text-xs fg-destructive">
          {listError}{' '}
          <button
            type="button"
            onClick={refresh}
            className="focus-ring underline"
          >
            Retry
          </button>
        </p>
      )}
      {loading ? (
        <LoadingPlaceholder label="Loading memories…" />
      ) : listedFiles.length === 0 && !listError ? (
        <p
          className="py-4 text-center text-xs fg-secondary/60"
          data-testid="memory-empty"
        >
          Ask in a chat to remember something{' '}
          {scope === 'user' ? 'about you' : 'about this project'}. Saved
          memories will appear here.
        </p>
      ) : (
        <div
          // Blocked from session replay: the memory facts. Mounts with the
          // loaded list; the search field, status, and errors stay recorded.
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} min-h-0 flex-1 overflow-y-auto overflow-x-hidden`}
          data-testid="memory-items"
        >
          {groups.map(({ kind, label }) => {
            const groupViews = views.filter((view) => view.file.kind === kind);
            if (groupViews.length === 0) return null;
            return (
              <div key={kind}>
                {label && (
                  <p className="px-2 pb-0.5 pt-2 text-2xs font-medium fg-secondary/60">
                    {label}
                  </p>
                )}
                {groupViews.map(renderFile)}
              </div>
            );
          })}
          {hasQuery && views.length === 0 && !pendingSearch && (
            <p
              className="py-4 text-center text-xs fg-secondary/60"
              data-testid="memory-empty-search"
            >
              Try another search.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
