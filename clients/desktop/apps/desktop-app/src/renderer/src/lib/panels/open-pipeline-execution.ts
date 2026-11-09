/**
 * The single opener for live pipeline run detail.
 *
 * Every live entry point (the Activity run list, chat run cards, toasts and
 * OS notifications, Overview, automations, Workers, Audit, Plans, Plan
 * Explore, agent artifact links, and App Advisor's `pipeline.open_run`) opens
 * a run through {@link openPipelineExecutionPanel}. It:
 *
 * 1. Takes the owner from the run itself: its record already in the pipeline
 *    runs store (a listed summary or a loaded state), else a
 *    `window.pipelines.getExecution` read. Caller owner hints are validated
 *    against it and never replace it; the selected worktree is never a
 *    fallback.
 * 2. Waits (bounded) for the projects to hydrate, then classifies the owner
 *    against them. An owner they do not list is gone (`owner_missing`) and
 *    nothing navigates or touches a layout; projects that never hydrate end
 *    the open with a retryable `navigation_failed`.
 * 3. Navigates the main window to the exact Code worktree or Cowork Work
 *    Entry (the entry fills the worktree slot of the layout key), unless the
 *    run's tab (or the origin chat it opens beside) already lives in one of
 *    the owner's auxiliary windows.
 * 4. Awaits the owner's layout, then re-checks that this request is still the
 *    latest, that the owner is still shown, and that it still exists.
 * 5. Places a new `pipeline-execution` tab with the phase 01 placement helper
 *    (beside the origin chat, after the origin file, or the file destination
 *    fallback), or reveals the existing tab anywhere in the owner's layout
 *    family without moving it.
 * 6. Applies an explicit breadcrumb/job target through the panel's session
 *    store, so an already-mounted panel switches to it.
 *
 * Concurrent opens of the same run coalesce: an older request resolves with
 * the newest one's result, and only the newest navigates or places. An open
 * superseded by a different run, or by the user navigating elsewhere while it
 * waited, resolves as `superseded` without touching focus.
 *
 * Runs without a usable owner (no project/worktree recorded, or an App
 * Advisor-owned run, whose layouts live in the App Advisor window) open in the
 * app-level compatibility host instead of acquiring a fabricated owner.
 */
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import type { PipelineExecutionDetailTarget } from '@/components/activity/details/pipelineDetailTypes';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { isRegisteredCoworkWorkspaceId } from '@/lib/cowork-registry';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  askNavigationGuard,
  runWithoutNavigationGuard,
  useNavigationStore,
} from '@/stores/navigationStore';
import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  isAuxPanelLayoutKey,
  type PanelInstanceLocation,
} from '@/stores/panelLayoutStore';
import { openPipelineCompatDetail } from '@/stores/pipelineCompatDetailStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { requestPipelinePanelReveal } from '@/stores/pipelinePanelUiStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import {
  placeOrRevealContentPanel,
  type ContentPanelOrigin,
} from './chat-panel-sync';
import { revealPanel } from './panel-reveal';
import { ensureWorktreePanelLayout } from './persistence-bridge';
import { pipelineExecutionPanelSeed } from './pipeline-execution-panel-identity';

/** A run's workspace owner. For Cowork the Work Entry id is `worktreeId`. */
export interface PipelineExecutionOwner {
  readonly projectId: string;
  readonly worktreeId: string;
}

export interface OpenPipelineExecutionRequest {
  /** The run to bind (a root run, or a child opened directly). */
  readonly executionId: string;
  /**
   * Trusted owner hint from the caller. It is checked against the run's own
   * owner and a mismatch is refused; it never supplies a missing owner.
   */
  readonly owner?: PipelineExecutionOwner;
  /** Child breadcrumb stack and job/variant to show. Omit to reveal as-is. */
  readonly target?: PipelineExecutionDetailTarget;
  /**
   * Where the open started. Placement uses it only when it belongs to the
   * run's owner (`ownerKey` names the origin's owner); a chat in another
   * worktree never receives this run's tab.
   */
  readonly origin?: {
    readonly chatTabId?: string;
    readonly fileTabId?: string;
    readonly ownerKey?: string;
  };
}

export type OpenPipelineExecutionErrorCode =
  | 'not_found'
  | 'owner_missing'
  | 'owner_mismatch'
  | 'navigation_failed'
  | 'superseded'
  | 'layout_unavailable';

export type OpenPipelineExecutionResult =
  | {
      /** The run's panel is shown (and targeted) in its owner's layout. */
      readonly status: 'applied';
      readonly ownerKey: string;
      readonly layoutKey: string;
      readonly panelId: string;
      readonly outcome: 'placed' | 'revealed';
    }
  | {
      /**
       * The run has no usable owner and is shown in the app-level
       * compatibility host. `unsupported-owner` is an App Advisor-owned run.
       */
      readonly status: 'ownerless';
      readonly executionId: string;
      readonly reason: 'no-owner' | 'unsupported-owner';
    }
  | {
      readonly status: 'error';
      readonly code: OpenPipelineExecutionErrorCode;
      /** User-facing copy (see docs/ux-writing.md "Workflow run panel"). */
      readonly message: string;
    };

export type PipelineExecutionOwnerKind = 'code' | 'cowork';

export type PipelineExecutionOwnerClassification =
  | PipelineExecutionOwnerKind
  | 'unsupported'
  | 'missing';

export type PipelineExecutionNavigationOutcome =
  | 'shown'
  | 'missing'
  | 'superseded'
  | 'failed';

/** The owner fields of a run record (a state or a listed summary). */
export interface PipelineExecutionOwnerRecord {
  readonly project_id?: string;
  readonly worktree_id?: string;
}

/**
 * The host operations the opener needs. Production binds them to the real
 * stores; tests inject fakes. Panel placement and reveal always run against
 * the real panel layout store.
 */
export interface PipelineExecutionOpenerEnvironment {
  /**
   * The run's record when the renderer already has it (no read). A run the
   * list shows needs no extra IPC read to be opened.
   */
  peekExecution?(executionId: string): PipelineExecutionOwnerRecord | null;
  /** The run's persisted state, or `null` when it does not exist. */
  readExecution(executionId: string): Promise<ExecutionState | null>;
  /**
   * Resolves `true` once the owner directory (the projects store) has
   * hydrated, or `false` when it did not within a bounded wait. Owners are
   * classified only after it resolves `true`, so a deleted owner is never
   * mistaken for one that simply has not loaded yet.
   */
  waitForOwnerDirectory?(): Promise<boolean>;
  /** Whether an owner is a Code worktree, a Cowork entry, or neither. */
  classifyOwner(
    owner: PipelineExecutionOwner,
  ): PipelineExecutionOwnerClassification;
  /** Shows the owner in the main window. */
  navigateToOwner(
    owner: PipelineExecutionOwner,
    kind: PipelineExecutionOwnerKind,
  ): Promise<PipelineExecutionNavigationOutcome>;
  /** Whether the main window still shows the owner (the focus fence). */
  isOwnerShown(
    owner: PipelineExecutionOwner,
    kind: PipelineExecutionOwnerKind,
  ): boolean;
  /** Restores or creates the owner's layout family. */
  ensureLayout(ownerKey: string): Promise<void>;
  /** Shows an ownerless run in the compatibility host. */
  openCompatibility(
    executionId: string,
    target: PipelineExecutionDetailTarget | undefined,
  ): void;
}

export const PIPELINE_RUN_OPEN_ERROR_MESSAGES: Readonly<
  Record<OpenPipelineExecutionErrorCode, string>
> = {
  not_found: "Couldn't open the run. It may have been deleted.",
  owner_missing:
    "Couldn't open the run. The worktree or task it ran in no longer exists.",
  owner_mismatch:
    "Couldn't open the run. It belongs to a different worktree or task.",
  navigation_failed: "Couldn't open the run. Try again.",
  superseded: 'Another navigation replaced this one.',
  layout_unavailable: "Couldn't open the run. Try again.",
};

function openError(
  code: OpenPipelineExecutionErrorCode,
): OpenPipelineExecutionResult {
  return {
    status: 'error',
    code,
    message: PIPELINE_RUN_OPEN_ERROR_MESSAGES[code],
  };
}

function ownerKeyOf(owner: PipelineExecutionOwner): string {
  return `${owner.projectId}/${owner.worktreeId}`;
}

function ownerOfExecution(
  state: PipelineExecutionOwnerRecord,
): PipelineExecutionOwner | null {
  const projectId = state.project_id?.trim() ?? '';
  const worktreeId = state.worktree_id?.trim() ?? '';
  return projectId.length > 0 && worktreeId.length > 0
    ? { projectId, worktreeId }
    : null;
}

function placementOrigin(
  origin: OpenPipelineExecutionRequest['origin'],
  ownerKey: string,
): ContentPanelOrigin | undefined {
  if (origin === undefined) return undefined;
  // An origin in another owner never hosts this run's tab.
  if (origin.ownerKey !== undefined && origin.ownerKey !== ownerKey) {
    return undefined;
  }
  if (origin.fileTabId !== undefined) return { fileTabId: origin.fileTabId };
  if (origin.chatTabId !== undefined) return { chatTabId: origin.chatTabId };
  return undefined;
}

function originLocation(
  ownerKey: string,
  origin: ContentPanelOrigin | undefined,
): PanelInstanceLocation | null {
  if (origin?.fileTabId !== undefined) {
    return findPanelByInstanceKey(ownerKey, `file-diff:${origin.fileTabId}`);
  }
  if (origin?.chatTabId !== undefined) {
    return findPanelByInstanceKey(ownerKey, `chat:${origin.chatTabId}`);
  }
  return null;
}

/**
 * Whether the run's tab is already open in one of the owner's auxiliary
 * windows, or (with no tab yet) its origin chat/file is. That window then
 * reveals or receives the tab, and the main window keeps whatever it shows.
 */
function opensInAuxiliaryWindow(
  ownerKey: string,
  instanceKey: string,
  origin: ContentPanelOrigin | undefined,
): boolean {
  const existing = findPanelByInstanceKey(ownerKey, instanceKey);
  if (existing !== null) return isAuxPanelLayoutKey(existing.layoutKey);
  const location = originLocation(ownerKey, origin);
  return location !== null && isAuxPanelLayoutKey(location.layoutKey);
}

export interface PipelineExecutionOpener {
  open(
    request: OpenPipelineExecutionRequest,
  ): Promise<OpenPipelineExecutionResult>;
}

type ReadOutcome =
  | { readonly kind: 'found'; readonly record: PipelineExecutionOwnerRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed' };

export function createPipelineExecutionOpener(
  environment: PipelineExecutionOpenerEnvironment,
): PipelineExecutionOpener {
  let intentCounter = 0;
  // The newest open. A request that wakes up after a newer one started is
  // superseded; if the newer one is for the same run it takes its result.
  let latestToken = 0;
  let latestExecutionId: string | null = null;
  let latestPromise: Promise<OpenPipelineExecutionResult> | null = null;
  const reads = new Map<string, Promise<ReadOutcome>>();

  function readOnce(executionId: string): Promise<ReadOutcome> {
    const inFlight = reads.get(executionId);
    if (inFlight !== undefined) return inFlight;
    const promise = environment
      .readExecution(executionId)
      .then(
        (state): ReadOutcome =>
          state === null
            ? { kind: 'missing' }
            : { kind: 'found', record: state },
        (): ReadOutcome => ({ kind: 'failed' }),
      )
      .finally(() => {
        if (reads.get(executionId) === promise) reads.delete(executionId);
      });
    reads.set(executionId, promise);
    return promise;
  }

  function supersededBy(
    token: number,
    executionId: string,
  ): Promise<OpenPipelineExecutionResult> | null {
    if (token === latestToken) return null;
    if (latestExecutionId === executionId && latestPromise !== null) {
      return latestPromise;
    }
    return Promise.resolve(openError('superseded'));
  }

  async function run(
    request: OpenPipelineExecutionRequest,
    token: number,
  ): Promise<OpenPipelineExecutionResult> {
    const { executionId, target } = request;
    const cached = environment.peekExecution?.(executionId) ?? null;
    let record: PipelineExecutionOwnerRecord;
    if (cached !== null) {
      record = cached;
    } else {
      const read = await readOnce(executionId);
      const afterRead = supersededBy(token, executionId);
      if (afterRead !== null) return afterRead;
      if (read.kind === 'failed') return openError('navigation_failed');
      if (read.kind === 'missing') return openError('not_found');
      record = read.record;
    }

    const owner = ownerOfExecution(record);
    if (owner === null) {
      environment.openCompatibility(executionId, target);
      return { status: 'ownerless', executionId, reason: 'no-owner' };
    }
    if (
      request.owner !== undefined &&
      (request.owner.projectId !== owner.projectId ||
        request.owner.worktreeId !== owner.worktreeId)
    ) {
      return openError('owner_mismatch');
    }
    let classification = environment.classifyOwner(owner);
    if (
      classification !== 'unsupported' &&
      environment.waitForOwnerDirectory !== undefined
    ) {
      // An owner the projects have not listed yet may exist or may be gone;
      // classify it only against hydrated projects so a toast, notification
      // or deep link fired at startup never navigates to a deleted owner.
      // (An App Advisor or legacy owner needs no projects to classify.)
      const hydrated = await environment.waitForOwnerDirectory();
      const afterHydration = supersededBy(token, executionId);
      if (afterHydration !== null) return afterHydration;
      if (!hydrated) return openError('navigation_failed');
      classification = environment.classifyOwner(owner);
    }
    if (classification === 'unsupported') {
      environment.openCompatibility(executionId, target);
      return { status: 'ownerless', executionId, reason: 'unsupported-owner' };
    }
    if (classification === 'missing') return openError('owner_missing');
    const kind: PipelineExecutionOwnerKind = classification;

    const ownerKey = ownerKeyOf(owner);
    const seed = pipelineExecutionPanelSeed(executionId);
    const instanceKey = getPanelInstanceKey(seed);
    const origin = placementOrigin(request.origin, ownerKey);

    if (!opensInAuxiliaryWindow(ownerKey, instanceKey, origin)) {
      let navigated: PipelineExecutionNavigationOutcome;
      try {
        navigated = await environment.navigateToOwner(owner, kind);
      } catch {
        navigated = 'failed';
      }
      const afterNavigation = supersededBy(token, executionId);
      if (afterNavigation !== null) return afterNavigation;
      if (navigated === 'missing') return openError('owner_missing');
      if (navigated === 'superseded') return openError('superseded');
      if (navigated === 'failed') return openError('navigation_failed');
      try {
        await environment.ensureLayout(ownerKey);
      } catch {
        return openError('layout_unavailable');
      }
      const afterLayout = supersededBy(token, executionId);
      if (afterLayout !== null) return afterLayout;
      // The user went somewhere else while the owner loaded: never pull
      // them back.
      if (!environment.isOwnerShown(owner, kind)) {
        return openError('superseded');
      }
    }
    // The owner may have been deleted while its layout loaded (or while an
    // auxiliary window held it): never place a tab in a removed owner.
    if (environment.classifyOwner(owner) === 'missing') {
      return openError('owner_missing');
    }

    const placement = await placeOrRevealContentPanel({
      worktreeKey: ownerKey,
      seed,
      ...(origin !== undefined ? { origin } : {}),
      revealExisting: (location): void => {
        if (token === latestToken) revealPanel(location);
      },
    });
    const afterPlacement = supersededBy(token, executionId);
    if (afterPlacement !== null) return afterPlacement;
    if (placement.outcome === 'unavailable') {
      return openError('layout_unavailable');
    }
    const { location } = placement;
    if (placement.outcome === 'placed') {
      // A new tab can land behind a maximized sibling or in a collapsed
      // group; surface it the same way an existing one is.
      revealPanel(location);
    }
    if (target !== undefined) {
      requestPipelinePanelReveal({
        ownerKey,
        panelId: location.panelId,
        executionId,
        target,
      });
    }
    return {
      status: 'applied',
      ownerKey,
      layoutKey: location.layoutKey,
      panelId: location.panelId,
      outcome: placement.outcome,
    };
  }

  return {
    open(request): Promise<OpenPipelineExecutionResult> {
      intentCounter += 1;
      const token = intentCounter;
      latestToken = token;
      latestExecutionId = request.executionId;
      const promise = run(request, token);
      latestPromise = promise;
      return promise;
    },
  };
}

// ---------------------------------------------------------------------------
// Production environment
// ---------------------------------------------------------------------------

/**
 * How long an open waits for the projects to hydrate before giving up. It
 * matches the app's loading-screen watchdog, after which the app is usable
 * without them.
 */
export const PIPELINE_RUN_OWNER_DIRECTORY_TIMEOUT_MS = 10_000;

/**
 * Resolves `true` once the projects store has hydrated (immediately when it
 * already has), or `false` after `timeoutMs`. It only observes the store:
 * the app starts hydration itself, and a failed load still marks it hydrated.
 */
export function waitForPipelineExecutionOwnerDirectory(
  timeoutMs: number = PIPELINE_RUN_OWNER_DIRECTORY_TIMEOUT_MS,
): Promise<boolean> {
  if (useProjectsStore.getState().hasHydratedProjects) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (hydrated: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      resolve(hydrated);
    };
    const timer = window.setTimeout(() => settle(false), timeoutMs);
    const unsubscribe = useProjectsStore.subscribe((state) => {
      if (state.hasHydratedProjects) settle(true);
    });
    // Hydration may have landed between the first read and subscribing.
    if (useProjectsStore.getState().hasHydratedProjects) settle(true);
  });
}

/**
 * Whether an owner is a Code worktree, a Cowork workspace's entry, an owner
 * with no main-window layout, or gone. Read it against hydrated projects
 * (see {@link waitForPipelineExecutionOwnerDirectory}): an owner the projects
 * do not list is `missing`. A Cowork Work Entry is not in the projects store;
 * the navigation verifies it before any layout is touched.
 */
export function classifyPipelineExecutionOwner(
  owner: PipelineExecutionOwner,
): PipelineExecutionOwnerClassification {
  // App Advisor's layouts live in its own window; the legacy standalone-chat
  // sentinel predates Work Entries and has no layout. Neither can host a
  // main-window panel.
  if (
    owner.projectId === APP_ADVISOR_PROJECT_ID ||
    owner.projectId === STANDALONE_CHAT_PROJECT_ID
  ) {
    return 'unsupported';
  }
  const { projects } = useProjectsStore.getState();
  const project = projects.find(
    (candidate) => candidate.id === owner.projectId,
  );
  if (
    project?.type === 'cowork' ||
    isRegisteredCoworkWorkspaceId(owner.projectId)
  ) {
    // Work Entries are not in the projects store; the navigation verifies
    // the entry.
    return 'cowork';
  }
  // Never optimistic: the opener waits for hydration before classifying, so
  // an unlisted project is gone rather than not yet loaded.
  if (project === undefined) return 'missing';
  return project.worktrees.some((worktree) => worktree.id === owner.worktreeId)
    ? 'code'
    : 'missing';
}

function isOwnerShown(
  owner: PipelineExecutionOwner,
  kind: PipelineExecutionOwnerKind,
): boolean {
  const activePage = useNavigationStore.getState().activePage;
  if (kind === 'code') {
    const selected = useChatStore.getState().selectedWorktree;
    return (
      activePage === 'main' &&
      selected?.projectId === owner.projectId &&
      selected.worktreeId === owner.worktreeId
    );
  }
  const cowork = useStandaloneChatStore.getState();
  return (
    activePage === 'chat' &&
    cowork.activeChatProjectId === owner.projectId &&
    cowork.activeWorkEntryId === owner.worktreeId
  );
}

/**
 * Shows the run's owner. A dirty editor that guards navigation (the Workflows
 * edit shell) is asked first, before anything changes; keeping the edits
 * supersedes the open instead of half-navigating.
 */
export async function navigateToPipelineExecutionOwner(
  owner: PipelineExecutionOwner,
  kind: PipelineExecutionOwnerKind,
): Promise<PipelineExecutionNavigationOutcome> {
  if (!(await askNavigationGuard(kind === 'code' ? 'main' : 'chat'))) {
    return 'superseded';
  }
  dismissPageLikeViewers();
  if (kind === 'code') {
    // The guard has answered: a save from its prompt may not have re-rendered
    // the editor clean yet, so asking again would prompt twice.
    runWithoutNavigationGuard(() =>
      useNavigationStore.getState().navigate('main'),
    );
    useChatStore.getState().selectWorktree(owner.projectId, owner.worktreeId);
    return isOwnerShown(owner, 'code') ? 'shown' : 'failed';
  }
  const cowork = useStandaloneChatStore.getState();
  try {
    await cowork.openWorkEntryFromSidebar(owner.projectId, owner.worktreeId);
  } catch (error: unknown) {
    // The workspace itself is gone (a fresh listing did not find it).
    reportRendererConsoleError('Opening the pipeline run owner failed', {
      projectId: owner.projectId,
      entryId: owner.worktreeId,
      error,
    });
    return 'missing';
  }
  const after = useStandaloneChatStore.getState();
  if (
    after.activeChatProjectId !== owner.projectId ||
    after.activeWorkEntryId !== owner.worktreeId
  ) {
    // The workspace opened but has no such entry: the run's task is gone.
    // Otherwise a newer navigation won (the Cowork open returns silently).
    return after.activeChatProjectId === owner.projectId &&
      !after.workEntries.some((entry) => entry.id === owner.worktreeId)
      ? 'missing'
      : 'superseded';
  }
  // Asked again: the Cowork open awaited, so a saved editor has re-rendered
  // clean, and edits made meanwhile still get their prompt.
  useNavigationStore.getState().navigate('chat');
  return isOwnerShown(owner, 'cowork') ? 'shown' : 'failed';
}

function peekExecution(
  executionId: string,
): PipelineExecutionOwnerRecord | null {
  const { statesById, summaries } = usePipelineRunsStore.getState();
  return (
    statesById[executionId] ??
    summaries.find((summary) => summary.id === executionId) ??
    null
  );
}

async function readExecution(
  executionId: string,
): Promise<ExecutionState | null> {
  const result = await window.pipelines.getExecution(executionId);
  return result.success && result.data ? result.data : null;
}

let defaultOpener: PipelineExecutionOpener | null = null;

function getDefaultOpener(): PipelineExecutionOpener {
  defaultOpener ??= createPipelineExecutionOpener({
    peekExecution,
    readExecution,
    waitForOwnerDirectory: () => waitForPipelineExecutionOwnerDirectory(),
    classifyOwner: classifyPipelineExecutionOwner,
    navigateToOwner: navigateToPipelineExecutionOwner,
    isOwnerShown,
    ensureLayout: ensureWorktreePanelLayout,
    openCompatibility: openPipelineCompatDetail,
  });
  return defaultOpener;
}

/** Opens (or reveals) a live run's detail. See the module comment. */
export function openPipelineExecutionPanel(
  request: OpenPipelineExecutionRequest,
): Promise<OpenPipelineExecutionResult> {
  return getDefaultOpener().open(request);
}

/**
 * The same as {@link openPipelineExecutionPanel}, for user gestures: a
 * failure (other than being superseded by a newer navigation) is shown as an
 * error toast.
 */
export async function openPipelineExecutionFromUi(
  request: OpenPipelineExecutionRequest,
): Promise<OpenPipelineExecutionResult> {
  const result = await openPipelineExecutionPanel(request);
  if (result.status === 'error' && result.code !== 'superseded') {
    useGitHubStore
      .getState()
      .addToast(result.message, 'error', undefined, { category: 'Pipeline' });
  }
  return result;
}
