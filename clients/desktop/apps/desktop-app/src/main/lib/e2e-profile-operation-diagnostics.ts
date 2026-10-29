import { AsyncLocalStorage } from 'node:async_hooks';
// Side-effect-free. The only installer is inside index.ts's build-time E2E gate.
type Fields = Record<string, unknown>;
type Method = (...args: unknown[]) => unknown;
type Surface = Record<string, Method>;
export interface ProfileDiagnosticSurface {
  inventory: Surface & { authority: Surface; queue: Surface };
  jobs: Surface;
  maintenance: Surface & { adapter: Surface };
}
const isFields = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object';
const isSurface = (value: unknown): value is Surface =>
  value !== null && (typeof value === 'object' || typeof value === 'function');
const isProfileDiagnosticSurface = (
  value: unknown,
): value is ProfileDiagnosticSurface & Surface =>
  isSurface(value) &&
  isSurface(read(value, 'inventory')) &&
  isSurface(read(read(value, 'inventory'), 'authority')) &&
  isSurface(read(read(value, 'inventory'), 'queue')) &&
  isSurface(read(value, 'jobs')) &&
  isSurface(read(value, 'maintenance')) &&
  isSurface(read(read(value, 'maintenance'), 'adapter'));
const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));
const read = (value: unknown, key: string): unknown => {
  try {
    return isFields(value) || typeof value === 'function'
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
};
const short = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  let result = Buffer.from(value.slice(0, limit))
    .subarray(0, limit)
    .toString('utf8');
  while (Buffer.byteLength(result) > limit) result = result.slice(0, -1);
  return result;
};
function errorFields(error: unknown): Fields {
  if (typeof error === 'string') error = { message: error };
  const result: Fields = {};
  let truncated = false;
  for (const [key, limit] of [
    ['name', 128],
    ['code', 128],
    ['message', 2048],
    ['stack', 8192],
  ] as const) {
    const value = read(error, key);
    result[key] = short(value, limit);
    if (typeof value === 'string' && result[key] !== value) truncated = true;
  }
  result.truncated = truncated;
  // JSON escaping can expand raw control characters sixfold; cap serialized
  // error records too, while retaining the first original error per operation.
  while (bytes(result) > 11 * 1024) {
    const field =
      typeof result.stack === 'string' && result.stack.length
        ? 'stack'
        : 'message';
    const text = typeof result[field] === 'string' ? result[field] : '';
    if (!text.length) break;
    result[field] = text.slice(0, Math.floor(text.length / 2));
    result.truncated = true;
  }
  return result;
}
function metadata(value: unknown): Fields {
  const result: Fields = {};
  for (const key of [
    'jobId',
    'profileId',
    'storageGeneration',
    'metadataRevision',
    'kind',
    'status',
    'cancellable',
    'retryable',
    'cleanupPending',
    'newStorageGeneration',
    'createdAt',
    'updatedAt',
    'expiresAt',
    'token',
    'approximateBytes',
    'files',
    'directories',
    'skippedEntries',
    'partial',
    'completedEntries',
    'lifecycle',
    'savedTabs',
    'liveViews',
    'activeDownloads',
    'measured',
    'truncated',
    'nextOffset',
  ]) {
    const item = read(value, key);
    if (item === null || typeof item === 'number' || typeof item === 'boolean')
      result[key] = item;
    else if (typeof item === 'string') result[key] = short(item, 128);
  }
  const message = short(read(value, 'message'), 2048);
  if (message) result.message = message;
  const operation = read(value, 'operation');
  if (operation)
    result.operation = { kind: short(read(operation, 'kind'), 128) };
  for (const key of ['tabs', 'defaults', 'contexts', 'cookieDomains']) {
    const array = read(value, key);
    if (Array.isArray(array)) result[`${key}Count`] = array.length;
  }
  const classes = read(value, 'dataClasses');
  if (Array.isArray(classes))
    result.dataClasses = classes.slice(0, 16).map((item) => short(item, 64));
  return result;
}

/** Fixed instance boundaries only: never accepts arbitrary methods from the E2E caller. */
function observeOperations(
  input: unknown,
  profileId: string,
  generation: number,
  clear: boolean,
  createScope?: BrowserDiagnosticScope,
  resetScope?: LoadedTaskDiagnosticScope,
): { release: () => void; snapshot: () => Fields } {
  const data = isProfileDiagnosticSurface(input) ? input : undefined;
  const startedAt = Date.now();
  const resetContext = resetScope
    ? new AsyncLocalStorage<BrowserDiagnosticScope>()
    : undefined;
  let active = true,
    expired = false,
    dropped = 0,
    normalBytes = 0,
    sequence = 0;
  let currentOperation: string | undefined;
  let inventoryEntered = false,
    commitEntered = false,
    stoppedAt: number | undefined;
  const events: Fields[] = [],
    firstErrors = new Map<string, Fields>();
  const pending = new Map<number, Fields>();
  const jobs = new Set<string>(),
    previews = new Set<string>();
  const restorations: (() => void)[] = [],
    restorationConflicts: string[] = [];
  let lastJobList: Fields | undefined;
  const safe = (action: () => void): void => {
    try {
      action();
    } catch {
      dropped++;
    }
  };
  const add = (event: Fields): void => {
    if (!active) return;
    const record = {
      elapsedMs: Date.now() - startedAt,
      ...event,
      ...(resetScope
        ? { monotonicNs: process.hrtime.bigint().toString() }
        : {}),
    };
    if (resetScope) safe(() => resetScope.write(record));
    const size = bytes(record);
    if (size > 16 * 1024) {
      dropped++;
      return;
    }
    while (events.length >= 256 || normalBytes + size > 104 * 1024) {
      normalBytes -= bytes(events.shift());
      dropped++;
    }
    events.push(record);
    normalBytes += size;
  };
  const track = (set: Set<string>, value: unknown): boolean => {
    if (typeof value !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(value))
      return false;
    if (!set.has(value) && set.size >= 8) {
      dropped++;
      return false;
    }
    set.add(value);
    return true;
  };
  const exact = (id: unknown, gen: unknown): boolean =>
    id === profileId && gen === generation;
  const profile = (value: unknown): boolean =>
    exact(read(value, 'profileId'), read(value, 'storageGeneration'));
  const user = (actor: unknown): boolean => read(actor, 'kind') === 'user';
  const wrap = (
    target: Surface,
    name: string,
    stage: string,
    match: (args: unknown[]) => boolean,
    details: (args: unknown[]) => Fields = () => ({}),
    success: (value: unknown, args: unknown[]) => Fields = metadata,
    handle = false,
  ): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const original = target[name];
    if (typeof original !== 'function')
      throw new Error(`Missing E2E observation boundary: ${stage}`);
    const wrapper: Method = function (this: unknown, ...args) {
      let captured = false,
        call = 0,
        identity: Fields = {};
      safe(() => {
        if (!active || !match(args)) return;
        captured = true;
        call = ++sequence;
        identity = {
          stage,
          call,
          operationId: currentOperation,
          ...(resetContext?.getStore()
            ? { owner: resetContext.getStore() }
            : {}),
          ...details(args),
        };
        add({ ...identity, outcome: createScope ? 'entered' : 'started' });
        const item = {
          stage,
          call,
          operationId: identity.operationId,
          startedAt: Date.now(),
        };
        if (
          pending.size < 64 &&
          bytes(Array.from(pending.values())) + bytes(item) < 16 * 1024
        )
          pending.set(call, item);
        else dropped++;
      });
      const settled = (outcome: string, value: unknown): void => {
        if (!active || !captured) return;
        safe(() => {
          pending.delete(call);
          const fields =
            outcome === 'rejected'
              ? { error: errorFields(value) }
              : { value: success(value, args) };
          const record = {
            ...identity,
            outcome:
              createScope && outcome === 'completed' ? 'fulfilled' : outcome,
            ...fields,
          };
          if (outcome === 'rejected') {
            const key =
              typeof identity.operationId === 'string'
                ? identity.operationId
                : stage;
            if (!firstErrors.has(key) && firstErrors.size < 8)
              firstErrors.set(key, {
                stage,
                call,
                operationId: identity.operationId,
                outcome,
                ...fields,
              });
          }
          add(record);
        });
      };
      try {
        const invoke = (): unknown => Reflect.apply(original, this, args);
        const owner = read(identity, 'owner') as
          | BrowserDiagnosticScope
          | undefined;
        const result =
          captured && resetContext && owner
            ? resetContext.run(owner, invoke)
            : invoke();
        if (captured)
          safe(() => {
            const observed = handle ? read(result, 'result') : result;
            if (observed instanceof Promise)
              void observed.then(
                (value) => settled('completed', value),
                (error) => settled('rejected', error),
              );
            else settled('completed', observed);
          });
        return result;
      } catch (error) {
        settled('rejected', error);
        throw error;
      }
    };
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      enumerable: descriptor?.enumerable ?? false,
      value: wrapper,
    });
    restorations.push(() => {
      if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapper) {
        restorationConflicts.push(stage);
        return;
      }
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = (): void => {
    if (!active) return;
    active = false;
    stoppedAt = Date.now();
    clearTimeout(timer);
    for (const restore of restorations.reverse()) safe(restore);
    resetContext?.disable();
  };
  try {
    if (resetScope) {
      const profileData = read(input, 'profileData');
      if (!isSurface(input) || !isProfileDiagnosticSurface(profileData))
        throw new Error('Missing E2E browser reset observation boundary.');
      const service = input;
      const ownerFor = (value: unknown): BrowserDiagnosticScope | undefined =>
        resetScope.owners.find(
          (owner) =>
            read(value, 'projectId') === owner.projectId &&
            read(value, 'worktreeId') === owner.worktreeId,
        );
      const profileOwners = new Map<unknown, BrowserDiagnosticScope>();
      const jobOwners = new Map<unknown, BrowserDiagnosticScope>();
      const inCreate = (): boolean => resetContext?.getStore() !== undefined;
      wrap(
        service,
        'create',
        'browser.create',
        (args) => !!ownerFor(args[0]),
        (args) => ({
          owner: ownerFor(args[0]),
          restoration: args[2] !== undefined,
        }),
        browserIdentity,
      );
      wrap(service, 'createSerialized', 'create.serialized', inCreate);
      wrap(profileData, 'ensureReady', 'create.ensureReady', inCreate);
      wrap(
        service,
        'recoverProfileSwitches',
        'create.recoverSwitches',
        inCreate,
      );
      wrap(
        resetScope.authority,
        'resolve',
        'create.resolve',
        inCreate,
        undefined,
        (value) => {
          const owner = resetContext?.getStore();
          const id = read(read(value, 'profile'), 'profileId');
          if (owner && id && profileOwners.size < 8)
            profileOwners.set(id, owner);
          return { profileId: short(id, 128) };
        },
      );
      for (const name of ['acquireSession', 'commitBinding', 'assertActive'])
        wrap(resetScope.authority, name, `create.${name}`, inCreate);
      for (const name of ['attachDebugger', 'navigate', 'persistLiveSnapshot'])
        wrap(service, name, `create.${name}`, inCreate);
      wrap(
        profileData.jobs,
        'create',
        'reset.jobs.create',
        (args) => profileOwners.has(read(args[1], 'profileId')),
        (args) => {
          const owner = profileOwners.get(read(args[1], 'profileId'));
          if (jobOwners.size < 8 && owner) jobOwners.set(args[0], owner);
          return {
            owner,
            jobId: short(args[0], 128),
            input: metadata(args[1]),
          };
        },
      );
      wrap(
        profileData.jobs,
        'update',
        'reset.jobs.update',
        (args) => jobOwners.has(args[0]),
        (args) => ({
          owner: jobOwners.get(args[0]),
          jobId: short(args[0], 128),
          patch: metadata(args[2]),
        }),
      );
      wrap(
        service,
        'resumeProfileViews',
        'browser.resumeProfileViews',
        (args) =>
          Array.isArray(args[0]) &&
          args[0].some((tab) => ownerFor(read(tab, 'snapshot'))),
        (args) => ({
          owner: Array.isArray(args[0])
            ? ownerFor(
                read(
                  args[0].find((tab) => ownerFor(read(tab, 'snapshot'))),
                  'snapshot',
                ),
              )
            : undefined,
        }),
      );
    } else if (createScope) {
      if (!isSurface(input))
        throw new Error('Missing E2E browser create observation boundary.');
      wrap(
        input,
        'create',
        'browser.create',
        (args) => {
          const requestBrowserId = read(args[0], 'browserId');
          const url = read(args[0], 'url');
          return (
            read(args[0], 'projectId') === createScope.projectId &&
            read(args[0], 'worktreeId') === createScope.worktreeId &&
            (args[1] === undefined || args[1] === 'user') &&
            args[2] === undefined &&
            (createScope.browserId === undefined
              ? requestBrowserId === undefined &&
                (url === undefined || url === '' || url === 'about:blank')
              : requestBrowserId === createScope.browserId)
          );
        },
        () => {
          inventoryEntered = true;
          return {};
        },
        browserIdentity,
      );
    } else {
      if (!data) throw new Error('Missing E2E profile observation boundary.');
      wrap(
        data.inventory,
        'start',
        'inventory.start',
        (a) => exact(a[1], a[2]) && track(jobs, a[0]),
        (a) => {
          inventoryEntered = true;
          currentOperation = String(a[0]);
          return { operationId: a[0] };
        },
      );
      for (const name of [
        'directory',
        'assertAvailable',
        'cookies',
        'withGeneration',
      ])
        wrap(
          data.inventory.authority,
          name,
          `inventory.${name}`,
          (a) =>
            name === 'assertAvailable' ? a[0] === profileId : exact(a[0], a[1]),
          undefined,
          (value) =>
            name === 'directory'
              ? {
                  pathCategory:
                    typeof value === 'string'
                      ? 'resolved-profile-directory'
                      : 'unresolved',
                }
              : name === 'cookies'
                ? {
                    measured: read(value, 'measured'),
                    truncated: read(value, 'truncated'),
                    domainCount: ((): number | undefined => {
                      const domains = read(value, 'domains');
                      return Array.isArray(domains)
                        ? domains.length
                        : undefined;
                    })(),
                  }
                : metadata(value),
        );
      wrap(
        data.inventory.queue,
        'run',
        'inventory.queue',
        (a) => exact(a[0], a[1]),
        undefined,
        metadata,
        true,
      );
      wrap(
        data.jobs,
        'create',
        'jobs.create',
        (a) => profile(a[1]) && track(jobs, a[0]),
        (a) => ({
          jobId: a[0],
          input: metadata(a[1]),
          preview: metadata(read(a[3], 'preview')),
        }),
      );
      wrap(
        data.jobs,
        'update',
        'jobs.update',
        (a) => jobs.has(String(a[0])),
        (a) => ({
          jobId: a[0],
          expected: Array.isArray(a[1])
            ? a[1].slice(0, 8).map((x) => short(x, 32))
            : [],
          patch: metadata(a[2]),
        }),
      );
      wrap(
        data.jobs,
        'list',
        'jobs.list',
        (a) => user(a[0]) && a[2] === profileId,
        (a) => ({ offset: a[1] ?? 0 }),
        (value, args) => {
          const list = read(value, 'jobs');
          const filtered = Array.isArray(list)
            ? list
                .filter((job) => read(job, 'profileId') === profileId)
                .slice(0, 100)
                .map(metadata)
            : [];
          const page = {
            offset: args[1] ?? 0,
            ...metadata(value),
            jobs: filtered,
            returnedCount: Array.isArray(list) ? list.length : null,
            truncated: false,
          };
          while (bytes(page) > 24 * 1024) {
            page.jobs.pop();
            page.truncated = true;
          }
          lastJobList = page;
          return {
            returnedCount: page.returnedCount,
            retainedCount: page.jobs.length,
            truncated: page.truncated,
          };
        },
      );
      wrap(
        data.maintenance,
        'preview',
        'maintenance.preview',
        (a) => user(a[0]) && exact(a[1], a[2]),
        (a) => ({ metadataRevision: a[3], operation: metadata(a[4]) }),
        (value) => {
          if (profile(value)) track(previews, read(value, 'token'));
          return metadata(value);
        },
      );
      wrap(
        data.maintenance,
        'commit',
        'maintenance.commit.service-outcome',
        (a) => user(a[0]) && previews.has(String(a[2])) && track(jobs, a[1]),
        (a) => {
          commitEntered = true;
          currentOperation = String(a[1]);
          return { operationId: a[1], token: a[2] };
        },
      );
      if (clear) {
        wrap(
          data.maintenance,
          'validateCurrent',
          'maintenance.validateCurrent',
          (a) =>
            user(a[1]) &&
            previews.has(String(read(read(a[0], 'preview'), 'token'))),
        );
        for (const name of ['profile', 'authorize', 'usage', 'scope'])
          wrap(data.maintenance.adapter, name, `maintenance.${name}`, (a) =>
            name === 'profile' || name === 'usage'
              ? a[0] === profileId
              : profile(a[0]),
          );
      }
    }
    timer = setTimeout(
      () => {
        expired = true;
        release();
      },
      resetScope ? 180_000 : 30_000,
    );
    timer.unref();
  } catch (error) {
    release();
    throw error;
  }
  return {
    release,
    snapshot: (): Fields => {
      const snapshot: unknown = JSON.parse(
        JSON.stringify({
          profileId,
          storageGeneration: generation,
          runtimeVersions: process.versions,
          active,
          expired,
          elapsedMs: Date.now() - startedAt,
          dropped,
          events,
          firstErrors: Array.from(firstErrors.values()),
          pending: Array.from(pending.values()).map((item) => ({
            ...item,
            elapsedMs: (stoppedAt ?? Date.now()) - Number(item.startedAt),
          })),
          jobIds: Array.from(jobs),
          previewTokens: Array.from(previews),
          lastJobList,
          restorationConflicts,
          serviceOutcomeBoundary:
            'Actual service outcome; no IPC envelope capture',
          operation: createScope
            ? 'browser-create'
            : clear
              ? 'clear'
              : 'inventory',
          createScope: createScope
            ? {
                projectId: createScope.projectId,
                worktreeId: createScope.worktreeId,
                browserId: createScope.browserId,
              }
            : undefined,
          createStage: createScope
            ? inventoryEntered
              ? 'entered'
              : 'stage-not-entered'
            : undefined,
          inventoryStage: inventoryEntered ? 'entered' : 'stage-not-entered',
          commitStage: commitEntered ? 'entered' : 'stage-not-entered',
          pendingStatus: active ? 'pending-now' : 'pending-at-observation-stop',
          stoppedAt,
          metadataSource:
            'cached allowlisted service metadata only; raw job/index/inventory/preview files not collected',
        }),
      );
      return isFields(snapshot) ? snapshot : {};
    },
  };
}

export interface BrowserDiagnosticScope {
  projectId: string;
  worktreeId: string;
  browserId?: string;
  url?: string;
}

function browserIdentity(value: unknown): Fields {
  const profile = read(value, 'profile');
  return {
    browserId: short(read(value, 'id'), 128),
    profileId: short(read(profile, 'resolvedProfileId'), 128),
    storageGeneration:
      typeof read(profile, 'storageGeneration') === 'number'
        ? read(profile, 'storageGeneration')
        : undefined,
    runtimeGeneration:
      typeof read(profile, 'runtimeGeneration') === 'number'
        ? read(profile, 'runtimeGeneration')
        : undefined,
  };
}

export function observeProfileOperations(
  input: unknown,
  profileId: string,
  generation: number,
  clear: boolean,
): { release: () => void; snapshot: () => Fields } {
  return observeOperations(input, profileId, generation, clear);
}

/** The same bounded recorder and descriptor restoration as profile operations. */
export function observeBrowserCreate(
  input: unknown,
  scope: BrowserDiagnosticScope,
): { release: () => void; snapshot: () => Fields } {
  const validIdentifier = (value: string): boolean =>
    /^[a-z0-9-]{1,128}$/i.test(value);
  if (
    ![scope.projectId, scope.worktreeId].every((value) =>
      validIdentifier(value),
    )
  )
    throw new Error('Captured synthetic project/worktree IDs are required.');
  if (scope.browserId !== undefined && !validIdentifier(scope.browserId))
    throw new Error('Captured synthetic browser ID is invalid.');
  return observeOperations(input, '', 0, false, scope);
}

interface LoadedTaskDiagnosticScope {
  owners: BrowserDiagnosticScope[];
  authority: Surface;
  write: (event: Fields) => void;
}

/** Fixed methods, asynchronous owner context, and the existing bounded recorder.
 * Startup activation is only in index.ts's pruned E2E gate; no product hooks. */
export function observeLoadedTaskReset(
  input: unknown,
  authority: unknown,
  owners: BrowserDiagnosticScope[],
  write: (event: Fields) => void,
): { release: () => void; snapshot: () => Fields } {
  if (
    !owners.length ||
    owners.length > 3 ||
    owners.some(
      (owner) =>
        ![owner.projectId, owner.worktreeId].every((value) =>
          /^[a-z0-9-]{1,128}$/i.test(value),
        ),
    )
  )
    throw new Error('Captured Task fixture owners are required.');
  if (!isSurface(authority))
    throw new Error('Missing E2E browser authority observation boundary.');
  return observeOperations(input, '', 0, false, undefined, {
    owners: owners.map(({ projectId, worktreeId }) => ({
      projectId,
      worktreeId,
    })),
    authority,
    write,
  });
}

interface NativeView {
  webContents?: {
    id: number;
    getURL: () => string;
    isDestroyed: () => boolean;
  };
  getVisible: () => boolean;
  getBounds: () => { x: number; y: number; width: number; height: number };
  children: NativeView[];
}
interface NativeWindow {
  id: number;
  webContents: { id: number };
  isDestroyed: () => boolean;
  contentView: { children: NativeView[] };
}

/** Fixed cached service seam; no service methods, disk reads, URLs or contents emitted. */
export function captureBrowserBoundary(
  input: unknown,
  windows: NativeWindow[],
  scope: BrowserDiagnosticScope,
): Fields {
  const sessions: Fields[] = [];
  const native: Fields[] = [];
  const errors: Fields[] = [];
  const result: Fields = {
    sessions,
    native,
    truncated: false,
    errors,
  };
  const attempt = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      if (errors.length < 8) errors.push(errorFields(error));
      else result.truncated = true;
    }
  };
  const states = read(input, 'sessions');
  let exactView: unknown;
  result.sessionsStatus = states instanceof Map ? 'available' : 'unavailable';
  if (states instanceof Map) {
    let visited = 0;
    const iterator = states.values();
    for (let entry = iterator.next(); !entry.done; entry = iterator.next()) {
      const state: unknown = entry.value;
      if (++visited > 64) {
        result.truncated = true;
        break;
      }
      attempt(() => {
        const snapshot = read(state, 'snapshot');
        if (
          read(snapshot, 'projectId') !== scope.projectId ||
          read(snapshot, 'worktreeId') !== scope.worktreeId
        )
          return;
        const view = read(state, 'view');
        if (scope.browserId && read(snapshot, 'id') === scope.browserId)
          exactView = view;
        if (sessions.length >= 8) {
          result.truncated = true;
          return;
        }
        sessions.push({
          ...browserIdentity(snapshot),
          webContentsId: read(read(view, 'webContents'), 'id'),
          hostWindowId: read(read(state, 'hostWindow'), 'id'),
          ownerRendererWebContentsId: read(
            read(read(state, 'hostWindow'), 'webContents'),
            'id',
          ),
          cachedVisible: read(state, 'visible'),
          dialogId: short(read(read(state, 'pendingDialog'), 'id'), 128),
        });
      });
    }
  }
  let visited = 0;
  for (const win of windows.slice(0, 8)) {
    if (visited >= 64) break;
    attempt(() => {
      let childIndex = -1;
      for (const view of win.contentView.children) {
        // A Browser page sits two views down, in its frame's rounded clip.
        const page = view.webContents
          ? view
          : (view.children[0]?.children[0] ?? view);
        childIndex++;
        if (++visited > 64) {
          result.truncated = true;
          break;
        }
        attempt(() => {
          const matchesBrowser = page === exactView;
          const destroyed = page.webContents?.isDestroyed();
          const matchesUrl =
            scope.url !== undefined &&
            !destroyed &&
            page.webContents?.getURL() === scope.url;
          if (!matchesBrowser && !matchesUrl) return;
          if (native.length >= 8) {
            result.truncated = true;
            return;
          }
          const record: Fields = {
            windowId: win.id,
            childIndex,
            ownerRendererWebContentsId: win.webContents.id,
            webContentsId: page.webContents?.id,
            destroyed,
            matchesUrl,
            matchesBrowser,
          };
          native.push(record);
          attempt(() => {
            record.windowDestroyed = win.isDestroyed();
          });
          attempt(() => {
            record.visible = page.getVisible();
          });
          attempt(() => {
            const bounds = view.getBounds();
            record.bounds = {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            };
          });
        });
      }
    });
  }
  if (windows.length > 8) result.truncated = true;
  return result;
}
