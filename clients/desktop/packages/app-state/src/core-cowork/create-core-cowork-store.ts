import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  CanopyErrorPayloadSchema,
  CanopyStreamCursorSchema,
  CoreChatLifecycleResultSchema,
  CoreChatTaskEventsItemSchema,
  CoreChatTaskListResultSchema,
  CoreWorkspaceListResultSchema,
  isCanopySnapshotRequiredError,
  type CanopyErrorPayload,
  type CanopyStreamCursor,
  type CoreChatTask,
} from '@canopy/protocol/canopy-core';
import {
  CoreCoworkRequestError,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from './invoker';

export type CoreCoworkStatus = 'disabled' | 'offline' | 'online';

export interface CoreCoworkProject {
  key: string;
  workspaceId: string;
  name: string;
  color?: string;
  ownerOrganizationId: string | null;
}

export interface CoreCoworkTask {
  key: string;
  workspaceId: string;
  worktreeId: string;
  title: string;
  state: string;
  updatedAt: string;
}

export interface CoreCoworkState {
  status: CoreCoworkStatus;
  generation: number;
  projects: readonly CoreCoworkProject[];
  tasksByProject: Readonly<Record<string, readonly CoreCoworkTask[]>>;
  connect(invoker: CoreCoworkInvoker): Promise<void>;
  /** Clears every project and task; nothing is kept for later display. */
  disconnect(reason: 'disabled' | 'offline'): void;
  /** `core.chat.create` with a new UUID tab id, which is the task's `worktreeId`. */
  createTask(workspaceId: string, title?: string): Promise<CoreCoworkTask>;
  archiveTask(workspaceId: string, worktreeId: string): Promise<void>;
}

/** Every key this store hands out names its authority (CAN-4185 D6). */
const AUTHORITY = 'web-core';
const TASK_REREAD_COALESCE_MS = 250;
const PAGE_SIZE = 500;

const projectKey = (workspaceId: string): string =>
  `${AUTHORITY}:${workspaceId}`;
const taskKey = (workspaceId: string, worktreeId: string): string =>
  `${AUTHORITY}:${workspaceId}:${worktreeId}`;

/** A generation that moved on while a reply was in flight. */
class StaleGenerationError extends Error {}

type Frame =
  | { kind: 'item'; cursor: CanopyStreamCursor; item: unknown }
  | { kind: 'end'; error: CanopyErrorPayload | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toFrame(value: unknown): Frame {
  if (isRecord(value) && value.kind === 'item') {
    const cursor = CanopyStreamCursorSchema.safeParse(value.cursor);
    if (cursor.success)
      return { kind: 'item', cursor: cursor.data, item: value.item };
  }
  if (isRecord(value) && value.kind === 'end') {
    const error = CanopyErrorPayloadSchema.safeParse(value.error);
    return { kind: 'end', error: error.success ? error.data : null };
  }
  return {
    kind: 'end',
    error: {
      kind: 'internal',
      message: 'The task stream sent an invalid frame.',
      retry: { kind: 'never' },
    },
  };
}

/** Only an item past the applied cursor of the same epoch is new. */
function isAfter(
  cursor: CanopyStreamCursor,
  applied: CanopyStreamCursor | null,
): boolean {
  return (
    applied === null ||
    cursor.daemonEpoch !== applied.daemonEpoch ||
    cursor.sequence > applied.sequence
  );
}

function toTask(task: CoreChatTask): CoreCoworkTask {
  return {
    key: taskKey(task.workspaceId, task.worktreeId),
    workspaceId: task.workspaceId,
    worktreeId: task.worktreeId,
    title: task.title,
    state: task.state,
    updatedAt: task.updatedAt,
  };
}

function newestFirst(tasks: readonly CoreCoworkTask[]): CoreCoworkTask[] {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const EMPTY = {
  projects: [],
  tasksByProject: {},
} satisfies Pick<CoreCoworkState, 'projects' | 'tasksByProject'>;

/**
 * Cloud cowork projects and their tasks from one core, read through
 * `core.workspace.list` and `core.chat.task.list` and kept live by one
 * `core.chat.task.events` stream (CAN-4185 D13). Transport-neutral: the host
 * passes a {@link CoreCoworkInvoker}. Leaving `online` drops everything, so
 * an offline core never shows a cached snapshot (D7).
 */
export function createCoreCoworkStore(): StoreApi<CoreCoworkState> {
  let invoker: CoreCoworkInvoker | null = null;
  let stream: CoreCoworkStream | null = null;
  let appliedCursor: CanopyStreamCursor | null = null;
  let rereadTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingRereads = new Set<string>();
  let pendingResync = false;
  // Refreshes run one at a time, so an older read never lands after a newer one.
  let refreshQueue: Promise<void> = Promise.resolve();

  const store = createStore<CoreCoworkState>()((set, get) => {
    const assertCurrent = (generation: number): void => {
      if (get().generation !== generation) throw new StaleGenerationError();
    };

    const call = async (
      generation: number,
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      if (!invoker) throw new StaleGenerationError();
      const reply = await invoker.request(method, params);
      assertCurrent(generation);
      if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
      return reply.value;
    };

    const serialized = (work: () => Promise<void>): Promise<void> => {
      const run = refreshQueue.then(work);
      refreshQueue = run.catch(() => undefined);
      return run;
    };

    const releaseConnection = (): void => {
      refreshQueue = Promise.resolve();
      if (rereadTimer !== null) clearTimeout(rereadTimer);
      rereadTimer = null;
      pendingRereads.clear();
      pendingResync = false;
      appliedCursor = null;
      const open = stream;
      stream = null;
      invoker = null;
      if (open) void open.close().catch(() => undefined);
    };

    const listTasks = async (
      generation: number,
      workspaceId: string,
    ): Promise<CoreCoworkTask[]> => {
      const tasks: CoreCoworkTask[] = [];
      let cursor: string | null = null;
      do {
        const value = await call(generation, 'core.chat.task.list', {
          scope: { workspaceId },
          pageSize: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
        });
        const page = CoreChatTaskListResultSchema.parse(value);
        tasks.push(...page.items.map(toTask));
        cursor = page.nextCursor;
      } while (cursor !== null);
      return newestFirst(tasks);
    };

    const listProjects = async (
      generation: number,
    ): Promise<CoreCoworkProject[]> => {
      const projects: CoreCoworkProject[] = [];
      let cursor: string | null = null;
      do {
        const value = await call(generation, 'core.workspace.list', {
          pageSize: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
        });
        const page = CoreWorkspaceListResultSchema.parse(value);
        for (const workspace of page.items) {
          // Without a named owner the project cannot be placed in a
          // Personal or organization context, so it is not shown at all.
          if (
            workspace.kind !== 'cowork' ||
            workspace.ownerOrganizationId === undefined
          )
            continue;
          projects.push({
            key: projectKey(workspace.workspaceId),
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            ...(workspace.color === undefined
              ? {}
              : { color: workspace.color }),
            ownerOrganizationId: workspace.ownerOrganizationId,
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      return projects;
    };

    const relistAll = async (generation: number): Promise<void> => {
      const projects = await listProjects(generation);
      const lists = await Promise.all(
        projects.map((project) => listTasks(generation, project.workspaceId)),
      );
      assertCurrent(generation);
      const tasksByProject: Record<string, readonly CoreCoworkTask[]> = {};
      projects.forEach((project, index) => {
        tasksByProject[project.key] = lists[index] ?? [];
      });
      set({ projects, tasksByProject });
    };

    const rereadProject = async (
      generation: number,
      workspaceId: string,
    ): Promise<void> => {
      const tasks = await listTasks(generation, workspaceId);
      const key = projectKey(workspaceId);
      if (!get().projects.some((project) => project.key === key)) return;
      set({ tasksByProject: { ...get().tasksByProject, [key]: tasks } });
    };

    const goOffline = (generation: number): void => {
      if (get().generation === generation) get().disconnect('offline');
    };

    const flushRereads = (generation: number): void => {
      rereadTimer = null;
      const resync = pendingResync;
      const workspaceIds = [...pendingRereads];
      pendingResync = false;
      pendingRereads.clear();
      const work = serialized(async () => {
        if (resync) await relistAll(generation);
        else
          for (const workspaceId of workspaceIds)
            await rereadProject(generation, workspaceId);
      });
      void work.catch((error: unknown) => {
        if (!(error instanceof StaleGenerationError)) goOffline(generation);
      });
    };

    const scheduleReread = (generation: number): void => {
      rereadTimer ??= setTimeout(
        () => flushRereads(generation),
        TASK_REREAD_COALESCE_MS,
      );
    };

    const openTaskStream = async (generation: number): Promise<void> => {
      if (!invoker) throw new StaleGenerationError();
      const opened = await invoker.openStream('core.chat.task.events', {
        scope: 'all',
        cursor: appliedCursor,
      });
      if (get().generation !== generation) {
        void opened.close().catch(() => undefined);
        throw new StaleGenerationError();
      }
      stream = opened;
    };

    /** Re-lists from a fresh, cursorless stream; the caller skips its leading `resync`. */
    const restartFromSnapshot = async (generation: number): Promise<void> => {
      appliedCursor = null;
      await openTaskStream(generation);
      await serialized(() => relistAll(generation));
    };

    /** A cursorless open always yields one leading `resync` first. */
    const pump = async (
      generation: number,
      skipLeadingResync: boolean,
    ): Promise<void> => {
      let leading = skipLeadingResync;
      let endedWithoutItems = 0;
      for (;;) {
        const current = stream;
        if (!current || get().generation !== generation) return;
        const result = await current.next();
        if (get().generation !== generation) return;
        const frame: Frame = result.done
          ? { kind: 'end', error: null }
          : toFrame(result.value);
        if (frame.kind === 'end') {
          stream = null;
          void current.close().catch(() => undefined);
          if (isCanopySnapshotRequiredError(frame.error)) {
            await restartFromSnapshot(generation);
            leading = true;
            continue;
          }
          if (frame.error !== null)
            throw new CoreCoworkRequestError(frame.error);
          // A stream the core ended cleanly resumes after the applied cursor,
          // unless it keeps ending with nothing delivered.
          endedWithoutItems += 1;
          if (endedWithoutItems > 1)
            throw new Error('The task stream keeps ending.');
          try {
            await openTaskStream(generation);
            leading = false;
          } catch (error) {
            // The applied cursor may have aged out while the stream was closed.
            if (
              !(error instanceof CoreCoworkRequestError) ||
              !isCanopySnapshotRequiredError(error.payload)
            )
              throw error;
            await restartFromSnapshot(generation);
            leading = true;
          }
          continue;
        }
        endedWithoutItems = 0;
        if (!isAfter(frame.cursor, appliedCursor)) continue;
        appliedCursor = frame.cursor;
        const item = CoreChatTaskEventsItemSchema.safeParse(frame.item);
        const wasLeading = leading;
        leading = false;
        if (!item.success) continue;
        if (item.data.kind === 'resync') {
          if (wasLeading) continue;
          pendingResync = true;
        } else {
          const { workspaceId } = item.data;
          if (get().projects.some((p) => p.workspaceId === workspaceId))
            pendingRereads.add(workspaceId);
          // A task in a project this list does not hold yet: a new project.
          else pendingResync = true;
        }
        scheduleReread(generation);
      }
    };

    return {
      status: 'disabled',
      generation: 0,
      ...EMPTY,

      connect: async (next): Promise<void> => {
        releaseConnection();
        const generation = get().generation + 1;
        // A first connect stays `disabled` (nothing shown) until it settles.
        const status = get().status === 'online' ? 'offline' : get().status;
        set({ generation, status, ...EMPTY });
        invoker = next;
        try {
          // Opened before the first list, so nothing between the two is lost.
          await openTaskStream(generation);
          await relistAll(generation);
          assertCurrent(generation);
          set({ status: 'online' });
        } catch (error) {
          if (error instanceof StaleGenerationError) return;
          goOffline(generation);
          return;
        }
        void pump(generation, true).catch((error: unknown) => {
          if (!(error instanceof StaleGenerationError)) goOffline(generation);
        });
      },

      disconnect: (reason): void => {
        releaseConnection();
        set({ generation: get().generation + 1, status: reason, ...EMPTY });
      },

      createTask: async (workspaceId, title): Promise<CoreCoworkTask> => {
        const generation = get().generation;
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const tabId = globalThis.crypto.randomUUID();
        const commandId = globalThis.crypto.randomUUID();
        const value = await call(generation, 'core.chat.create', {
          projectId: workspaceId,
          worktreeId: tabId,
          commandId,
          _meta: { idempotencyKey: commandId },
          action: {
            type: 'chat.create_tab',
            tabId,
            ...(title === undefined ? {} : { title }),
          },
        });
        const result = CoreChatLifecycleResultSchema.parse(value);
        if (
          result.outcome !== 'applied' &&
          result.outcome !== 'already_applied'
        )
          throw new Error(result.reason ?? 'The cloud chat was not created.');
        await serialized(() => rereadProject(generation, workspaceId));
        const key = taskKey(workspaceId, tabId);
        const listed = get().tasksByProject[projectKey(workspaceId)]?.find(
          (task) => task.key === key,
        );
        if (listed) return listed;
        const created: CoreCoworkTask = {
          key,
          workspaceId,
          worktreeId: tabId,
          title: title ?? '',
          state: 'idle',
          updatedAt: new Date().toISOString(),
        };
        const projectTasks =
          get().tasksByProject[projectKey(workspaceId)] ?? [];
        set({
          tasksByProject: {
            ...get().tasksByProject,
            [projectKey(workspaceId)]: [created, ...projectTasks],
          },
        });
        return created;
      },

      archiveTask: async (workspaceId, worktreeId): Promise<void> => {
        const generation = get().generation;
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const commandId = globalThis.crypto.randomUUID();
        const value = await call(generation, 'core.chat.archive', {
          projectId: workspaceId,
          worktreeId,
          commandId,
          _meta: { idempotencyKey: commandId },
          action: { type: 'chat.archive_tab', tabId: worktreeId },
        });
        const result = CoreChatLifecycleResultSchema.parse(value);
        if (
          result.outcome !== 'applied' &&
          result.outcome !== 'already_applied' &&
          result.outcome !== 'not_found'
        )
          throw new Error(result.reason ?? 'The cloud chat was not archived.');
        await serialized(() => rereadProject(generation, workspaceId));
      },
    };
  });
  return store;
}
