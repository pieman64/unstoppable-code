/**
 * Serialized verbatim into Electron. Waits only for the already-requested
 * native suppression to become observable; it never changes presentation.
 */
export async function waitForInitialNativeReadiness(
  { BrowserWindow },
  target,
  seams = {},
) {
  const budgetMs = 5000;
  const cadenceMs = 100;
  const maxObservations = 64;
  const data = (object, name) => {
    if (
      (typeof object !== 'object' && typeof object !== 'function') ||
      object === null
    )
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  };
  const integer = (value) => (Number.isSafeInteger(value) ? value : null);
  const boolean = (value) => (typeof value === 'boolean' ? value : null);
  const finite = (value) => (Number.isFinite(value) ? value : null);
  const safeId = (value) =>
    typeof value === 'string' && value.length <= 256 ? value : null;
  const projectBounds = (value) => {
    const result = {};
    for (const name of ['x', 'y', 'width', 'height']) {
      const number = finite(data(value, name));
      if (number === null) return null;
      result[name] = number;
    }
    return result;
  };
  const positiveBounds = (value) =>
    value !== null && value.width > 0 && value.height > 0;
  const clock =
    seams.clock ?? (() => Number(process.hrtime.bigint()) / 1_000_000);
  const wait =
    seams.wait ??
    ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const diagnosticGetter =
    seams.diagnosticGetter ??
    data(globalThis, '__CANOPY_E2E_PROFILE_OPERATION_DIAGNOSTICS__');
  const startedAt = clock();
  if (!Number.isFinite(startedAt))
    throw new Error('Initial native readiness requires a monotonic clock');
  const deadline = startedAt + budgetMs;
  const pinned = data(target, 'initialNative');
  const identity = {
    projectId: safeId(data(target, 'projectId')),
    worktreeId: safeId(data(target, 'worktreeId')),
    browserId: safeId(data(target, 'browserId')),
    profileId: safeId(data(target, 'profileId')),
    runtimeGeneration: integer(data(target, 'runtimeGeneration')),
    storageGeneration: integer(data(target, 'storageGeneration')),
    dialogId: safeId(data(target, 'dialogId')),
    ownerRendererWebContentsId: integer(
      data(target, 'ownerRendererWebContentsId'),
    ),
    url: safeId(data(target, 'url')),
    webContentsId: integer(data(pinned, 'webContentsId')),
    hostWindowId: integer(data(pinned, 'hostWindowId')),
  };
  if (Object.values(identity).some((value) => value === null))
    throw new Error('Initial native readiness requires exact identities');
  const observations = [];
  let ordinal = 0;
  const retain = (row) => {
    if (observations.length >= maxObservations) return false;
    observations.push({ ordinal: ++ordinal, ...row });
    return true;
  };
  const initial = {
    time: finite(data(pinned, 'observedAtMs')) ?? startedAt,
    phase: 'initial',
    ready: false,
    classification:
      boolean(data(pinned, 'visible')) === true
        ? 'native-visible'
        : 'initial-observation',
    native: {
      webContentsId: identity.webContentsId,
      hostWindowId: identity.hostWindowId,
      destroyed: boolean(data(pinned, 'destroyed')),
      windowDestroyed: boolean(data(pinned, 'windowDestroyed')),
      visible: boolean(data(pinned, 'visible')),
      bounds: projectBounds(data(pinned, 'bounds')),
    },
  };
  retain(initial);
  const finish = (status, reason, ready = null) => {
    const final = observations.at(-1) ?? initial;
    return {
      version: 1,
      status,
      reason,
      budgetMs,
      cadenceMs,
      startedAt,
      endedAt: final.time,
      elapsedMs: Math.max(0, final.time - startedAt),
      identity,
      initial,
      observations,
      ready,
      final,
    };
  };
  const observeState = (time) => {
    let matchingViews = [];
    try {
      const windows = BrowserWindow.getAllWindows();
      for (let i = 0; i < Math.min(windows.length, 8); i++) {
        const win = windows[i];
        const children = win.contentView?.children;
        if (!Array.isArray(children)) continue;
        for (let j = 0; j < Math.min(children.length, 16); j++) {
          // A Browser page's window child is its frame, which holds the page
          // two views down; the frame carries its window bounds.
          const frame = children[j];
          const page = frame.webContents
            ? frame
            : frame.children?.[0]?.children?.[0];
          const contents = page?.webContents;
          if (
            typeof contents?.getURL === 'function' &&
            contents.getURL() === identity.url
          )
            matchingViews.push({ win, view: page, frame, contents });
        }
      }
    } catch {
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: false,
        classification: 'native-unavailable',
      };
    }
    if (matchingViews.length !== 1) {
      const changed = matchingViews.some(
        ({ win, contents }) =>
          integer(contents.id) !== identity.webContentsId ||
          integer(win.id) !== identity.hostWindowId,
      );
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: changed || matchingViews.length > 1,
        classification:
          changed || matchingViews.length > 1
            ? 'native-identity-changed'
            : 'native-unavailable',
      };
    }
    const [{ win, view, frame, contents }] = matchingViews;
    if (
      integer(contents.id) !== identity.webContentsId ||
      integer(win.id) !== identity.hostWindowId
    )
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: true,
        classification: 'native-identity-changed',
      };
    let direct;
    try {
      direct = {
        webContentsId: identity.webContentsId,
        hostWindowId: identity.hostWindowId,
        destroyed: contents.isDestroyed(),
        windowDestroyed: win.isDestroyed(),
        visible: frame.getVisible() && view.getVisible(),
        bounds: projectBounds(frame.getBounds()),
      };
    } catch {
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: false,
        classification: 'native-unavailable',
      };
    }
    if (direct.destroyed !== false || direct.windowDestroyed !== false)
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: true,
        classification: 'native-destroyed',
        native: direct,
      };
    let raw;
    try {
      raw =
        typeof diagnosticGetter === 'function'
          ? diagnosticGetter({
              kind: 'browser-snapshot',
              scope: {
                projectId: identity.projectId,
                worktreeId: identity.worktreeId,
                browserId: identity.browserId,
              },
              deadline: Date.now() + 1000,
            })
          : undefined;
    } catch {
      raw = undefined;
    }
    if (raw && typeof data(raw, 'then') === 'function') {
      Promise.prototype.then.call(
        raw,
        () => {},
        () => {},
      );
      raw = undefined;
    }
    const sessions = data(raw, 'sessions');
    const native = data(raw, 'native');
    if (
      data(raw, 'sessionsStatus') !== 'available' ||
      data(raw, 'truncated') === true ||
      !Array.isArray(data(raw, 'errors')) ||
      data(raw, 'errors').length > 0 ||
      !Array.isArray(sessions) ||
      !Array.isArray(native)
    )
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: false,
        classification: 'diagnostic-unavailable',
        native: direct,
      };
    const exactSessions = sessions
      .slice(0, 8)
      .filter((row) => data(row, 'browserId') === identity.browserId);
    const exactNative = native
      .slice(0, 8)
      .filter((row) => data(row, 'matchesBrowser') === true);
    if (exactSessions.length !== 1 || exactNative.length !== 1)
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: exactSessions.length > 1 || exactNative.length > 1,
        classification:
          exactSessions.length > 1 || exactNative.length > 1
            ? 'diagnostic-identity-ambiguous'
            : 'diagnostic-unavailable',
        native: direct,
      };
    const session = exactSessions[0];
    const observedNative = exactNative[0];
    if (data(session, 'dialogId') !== identity.dialogId)
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: true,
        classification: 'dialog-identity-changed',
        native: direct,
      };
    if (
      data(session, 'profileId') !== identity.profileId ||
      data(session, 'runtimeGeneration') !== identity.runtimeGeneration ||
      data(session, 'storageGeneration') !== identity.storageGeneration ||
      data(session, 'ownerRendererWebContentsId') !==
        identity.ownerRendererWebContentsId
    )
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: true,
        classification: 'runtime-identity-changed',
        native: direct,
      };
    if (
      data(session, 'webContentsId') !== identity.webContentsId ||
      data(session, 'hostWindowId') !== identity.hostWindowId ||
      data(observedNative, 'webContentsId') !== identity.webContentsId ||
      data(observedNative, 'windowId') !== identity.hostWindowId ||
      data(observedNative, 'ownerRendererWebContentsId') !==
        identity.ownerRendererWebContentsId
    )
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: true,
        classification: 'native-identity-changed',
        native: direct,
      };
    const state = {
      session: {
        browserId: identity.browserId,
        profileId: identity.profileId,
        runtimeGeneration: identity.runtimeGeneration,
        storageGeneration: identity.storageGeneration,
        dialogId: identity.dialogId,
        ownerRendererWebContentsId: identity.ownerRendererWebContentsId,
        webContentsId: identity.webContentsId,
        hostWindowId: identity.hostWindowId,
        cachedVisible: boolean(data(session, 'cachedVisible')),
      },
      native: {
        ...direct,
        diagnosticVisible: boolean(data(observedNative, 'visible')),
        diagnosticBounds: projectBounds(data(observedNative, 'bounds')),
      },
    };
    if (
      state.session.cachedVisible === null ||
      state.native.visible === null ||
      state.native.diagnosticVisible === null ||
      !positiveBounds(state.native.bounds) ||
      !positiveBounds(state.native.diagnosticBounds)
    )
      return {
        time,
        phase: 'sample',
        ready: false,
        terminal: false,
        classification: 'diagnostic-unavailable',
        ...state,
      };
    const ready =
      state.session.cachedVisible === false &&
      state.native.visible === false &&
      state.native.diagnosticVisible === false;
    return {
      time,
      phase: ready ? 'ready' : 'sample',
      ready,
      terminal: false,
      classification: ready ? 'ready' : 'native-visible',
      ...state,
    };
  };
  const observe = () => {
    const entryTime = clock();
    if (!Number.isFinite(entryTime) || entryTime < startedAt)
      return {
        time: startedAt,
        entryTime: startedAt,
        phase: 'sample',
        ready: false,
        terminal: true,
        classification: 'invalid-clock',
      };
    const observed = observeState(entryTime);
    const completionTime = clock();
    if (!Number.isFinite(completionTime) || completionTime < entryTime)
      return {
        ...observed,
        time: entryTime,
        entryTime,
        phase: 'sample',
        ready: false,
        terminal: true,
        classification: 'invalid-clock',
      };
    const completed = {
      ...observed,
      time: completionTime,
      entryTime,
    };
    if (entryTime >= deadline || completionTime >= deadline)
      return {
        ...completed,
        phase: 'deadline',
        ready: false,
        terminal: true,
        observedReady: observed.ready,
        observedClassification: observed.classification,
        classification: 'readiness-deadline',
      };
    return completed;
  };
  while (true) {
    const sample = observe();
    if (!retain(sample)) return finish('not-ready', 'observation-capacity');
    if (sample.ready) return finish('ready', null, sample);
    if (sample.terminal) return finish('not-ready', sample.classification);
    const remaining = deadline - sample.time;
    if (remaining <= 0) return finish('not-ready', 'readiness-deadline');
    await wait(Math.min(cadenceMs, remaining));
  }
}

/**
 * Serialized verbatim into the renderer. This observes only its own exact DOM
 * node, ResizeObserver, event listener and animation frame. Its observations
 * never stand in for the app's observer, listener, frame or IPC admission.
 */
export function installPresentationRendererRouteRecorder(
  textbox,
  options = {},
  seams = {},
) {
  const MAX_RECORDS = 64;
  const MAX_RECORD_BYTES = 48 * 1024;
  const renderer = seams.renderer ?? globalThis;
  const clock = seams.clock ?? (() => renderer.performance.now());
  const byteLength =
    seams.byteLength ??
    ((value) => new renderer.TextEncoder().encode(value).byteLength);
  const eventName = 'canopy:browser-view-bounds-invalidated';
  const records = [];
  const counters = {
    resizeObserverNotifications: 0,
    initialResizeObserverNotifications: 0,
    postTriggerSizeChanges: 0,
    boundsInvalidationEvents: 0,
    ownAnimationFramesScheduled: 0,
    ownAnimationFrameCallbacks: 0,
    droppedRecords: 0,
    readFailures: 0,
    invalidClocks: 0,
    resizeObserverDisconnectAttempts: 0,
    resizeObserverDisconnectFailures: 0,
  };
  let root;
  let slateScroller;
  let resizeObserver;
  let listenerInstalled = false;
  let pendingOwnAnimationFrame = null;
  let triggered = false;
  let triggerRootRect = null;
  let recordBytes = 0;
  let ordinal = 0;
  let incomplete = false;
  let reason = null;
  let cleaned = false;
  let resizeObserverDisconnected = null;
  let resizeObserverDisconnectPending = false;
  let resizeObserverObserved = false;
  let listenerRemoved = null;
  let ownAnimationFrameCancelled = null;
  let finalizedReport;
  let lastTime = -Infinity;
  const increment = (value) => Math.min(1_000_000_000, value + 1);
  const unavailable = (nextReason) => {
    incomplete = true;
    reason ??= nextReason;
  };
  const now = () => {
    try {
      const value = clock();
      if (!Number.isFinite(value) || value < lastTime) throw new Error();
      lastTime = value;
      return value;
    } catch {
      counters.invalidClocks = increment(counters.invalidClocks);
      unavailable('invalid-clock');
      return null;
    }
  };
  const projectRect = (value) => {
    const projected = {};
    for (const name of ['x', 'y', 'width', 'height']) {
      const number = value?.[name];
      if (!Number.isFinite(number)) throw new Error();
      projected[name] = number;
    }
    if (projected.width <= 0 || projected.height <= 0) throw new Error();
    return projected;
  };
  const observeState = () => {
    try {
      const currentRoot = textbox?.closest?.('[data-chat-composer-root]');
      const currentSlateScroller = textbox?.parentElement;
      const rootConnected = root?.isConnected === true;
      const textboxConnected = textbox?.isConnected === true;
      const slateScrollerSame = currentSlateScroller === slateScroller;
      const slateScrollerConnected = slateScroller?.isConnected === true;
      const slateScrollerWithinRoot = root?.contains?.(slateScroller) === true;
      if (!rootConnected) unavailable('composer-root-disconnected');
      if (!textboxConnected) unavailable('textbox-disconnected');
      if (currentRoot !== root) unavailable('composer-root-identity-changed');
      if (!slateScroller) unavailable('slate-scroller-missing');
      else if (!slateScrollerSame)
        unavailable('slate-scroller-identity-changed');
      else if (!slateScrollerConnected)
        unavailable('slate-scroller-disconnected');
      else if (!slateScrollerWithinRoot)
        unavailable('slate-scroller-outside-root');
      const composerDensity = root.getAttribute('data-composer-density');
      if (
        typeof composerDensity !== 'string' ||
        composerDensity.length === 0 ||
        composerDensity.length > 32
      )
        unavailable('composer-density-unavailable');
      const computedStyle = renderer.getComputedStyle(slateScroller);
      const overflowY = computedStyle.overflowY;
      const maxHeight = computedStyle.maxHeight;
      const overflowYAvailable =
        typeof overflowY === 'string' &&
        overflowY.length > 0 &&
        overflowY.length <= 32;
      const maxHeightAvailable =
        typeof maxHeight === 'string' &&
        maxHeight.length > 0 &&
        maxHeight.length <= 32;
      if (!overflowYAvailable)
        unavailable('slate-scroller-overflow-y-unavailable');
      if (!maxHeightAvailable)
        unavailable('slate-scroller-max-height-unavailable');
      const clientHeight = slateScroller.clientHeight;
      const scrollHeight = slateScroller.scrollHeight;
      if (
        !Number.isFinite(clientHeight) ||
        clientHeight < 0 ||
        !Number.isFinite(scrollHeight) ||
        scrollHeight < 0
      )
        throw new Error();
      return {
        status:
          rootConnected &&
          textboxConnected &&
          currentRoot === root &&
          slateScrollerSame &&
          slateScrollerConnected &&
          slateScrollerWithinRoot &&
          typeof composerDensity === 'string' &&
          composerDensity.length > 0 &&
          composerDensity.length <= 32 &&
          overflowYAvailable &&
          maxHeightAvailable
            ? 'available'
            : 'unavailable',
        rootSame: currentRoot === root,
        rootConnected,
        textboxConnected,
        composerDensity:
          typeof composerDensity === 'string'
            ? composerDensity.slice(0, 32)
            : null,
        documentVisibility:
          typeof renderer.document?.visibilityState === 'string'
            ? renderer.document.visibilityState.slice(0, 32)
            : 'unavailable',
        rootRect: projectRect(root.getBoundingClientRect()),
        textboxRect: projectRect(textbox.getBoundingClientRect()),
        slateScroller: {
          same: slateScrollerSame,
          connected: slateScrollerConnected,
          withinRoot: slateScrollerWithinRoot,
          rect: projectRect(slateScroller.getBoundingClientRect()),
          clientHeight,
          scrollHeight,
          overflowY: overflowYAvailable ? overflowY : null,
          maxHeight: maxHeightAvailable ? maxHeight : null,
        },
      };
    } catch {
      counters.readFailures = increment(counters.readFailures);
      unavailable('geometry-read-failed');
      return {
        status: 'unavailable',
        reason: 'geometry-read-failed',
      };
    }
  };
  const retain = (phase, fields = {}) => {
    const row = {
      ordinal: (ordinal = increment(ordinal)),
      time: now(),
      phase,
      ...fields,
    };
    let bytes;
    try {
      bytes = byteLength(JSON.stringify(row));
    } catch {
      counters.readFailures = increment(counters.readFailures);
      unavailable('record-size-read-failed');
      return null;
    }
    if (
      records.length >= MAX_RECORDS ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > 4096 ||
      recordBytes + bytes > MAX_RECORD_BYTES
    ) {
      counters.droppedRecords = increment(counters.droppedRecords);
      unavailable('record-capacity');
      return null;
    }
    recordBytes += bytes;
    records.push(row);
    return row;
  };
  const captureState = (phase, fields = {}) =>
    retain(phase, { ...fields, ...observeState() });
  const sameSize = (left, right) =>
    left && right && left.width === right.width && left.height === right.height;
  const onResize = () => {
    if (cleaned) return;
    counters.resizeObserverNotifications = increment(
      counters.resizeObserverNotifications,
    );
    const initial = counters.resizeObserverNotifications === 1;
    if (initial)
      counters.initialResizeObserverNotifications = increment(
        counters.initialResizeObserverNotifications,
      );
    const state = observeState();
    const postTriggerSizeChange = Boolean(
      !initial &&
      triggered &&
      state.status === 'available' &&
      state.rootRect &&
      !sameSize(state.rootRect, triggerRootRect),
    );
    if (postTriggerSizeChange)
      counters.postTriggerSizeChanges = increment(
        counters.postTriggerSizeChanges,
      );
    retain('resize-observer', {
      initial,
      afterTrigger: triggered,
      postTriggerSizeChange,
      ...state,
    });
  };
  const onBoundsInvalidated = () => {
    if (cleaned) return;
    counters.boundsInvalidationEvents = increment(
      counters.boundsInvalidationEvents,
    );
    captureState('bounds-invalidated-event');
    if (pendingOwnAnimationFrame !== null) return;
    try {
      pendingOwnAnimationFrame = renderer.requestAnimationFrame(() => {
        pendingOwnAnimationFrame = null;
        if (cleaned) return;
        counters.ownAnimationFrameCallbacks = increment(
          counters.ownAnimationFrameCallbacks,
        );
        captureState('own-animation-frame');
      });
      counters.ownAnimationFramesScheduled = increment(
        counters.ownAnimationFramesScheduled,
      );
    } catch {
      pendingOwnAnimationFrame = null;
      unavailable('animation-frame-schedule-failed');
    }
  };
  const report = () => {
    if (finalizedReport) return JSON.parse(JSON.stringify(finalizedReport));
    const value = {
      version: 1,
      status: incomplete ? 'unavailable' : cleaned ? 'complete' : 'recording',
      reason,
      incomplete,
      records,
      counters,
      recordBytes,
      resources: {
        resizeObserverInstalled:
          Boolean(resizeObserver) && resizeObserverObserved && !cleaned,
        resizeObserverOwned: Boolean(resizeObserver),
        resizeObserverObserved,
        resizeObserverDisconnectPending,
        listenerInstalled: listenerInstalled && !cleaned,
        pendingOwnAnimationFrame: pendingOwnAnimationFrame !== null,
        cleaned,
        resizeObserverDisconnected,
        listenerRemoved,
        ownAnimationFrameCancelled,
      },
      evidence: {
        rootResizeObservedAfterTrigger: counters.postTriggerSizeChanges > 0,
        boundsInvalidationObserved: counters.boundsInvalidationEvents > 0,
        ownAnimationFrameObserved: counters.ownAnimationFrameCallbacks > 0,
        canSatisfyControlledWitness: false,
      },
      observationSemantics:
        'passive test-owned observations; own ResizeObserver/event/RAF evidence is not app callback or main-handler admission evidence',
    };
    try {
      value.serializedBytes = 0;
      for (let pass = 0; pass < 4; pass++) {
        const measured = byteLength(JSON.stringify(value));
        if (measured === value.serializedBytes) break;
        value.serializedBytes = measured;
      }
    } catch {
      value.serializedBytes = null;
      value.status = 'unavailable';
      value.reason ??= 'record-size-read-failed';
      value.incomplete = true;
    }
    return JSON.parse(JSON.stringify(value));
  };
  const disconnectOwnedResizeObserver = (phase) => {
    if (!resizeObserver || !resizeObserverDisconnectPending) return;
    counters.resizeObserverDisconnectAttempts = increment(
      counters.resizeObserverDisconnectAttempts,
    );
    try {
      resizeObserver.disconnect();
      resizeObserverDisconnected = true;
      resizeObserverDisconnectPending = false;
      resizeObserverObserved = false;
      retain(phase, { outcome: 'disconnected' });
      resizeObserver = undefined;
    } catch {
      resizeObserverDisconnected = false;
      counters.resizeObserverDisconnectFailures = increment(
        counters.resizeObserverDisconnectFailures,
      );
      unavailable('resize-observer-cleanup-failed');
      retain(phase, { outcome: 'failed' });
    }
  };
  const cleanup = () => {
    if (cleaned) return;
    captureState('final-retrieval');
    cleaned = true;
    disconnectOwnedResizeObserver('final-resize-observer-cleanup');
    if (listenerInstalled) {
      try {
        renderer.removeEventListener(eventName, onBoundsInvalidated);
        listenerRemoved = true;
      } catch {
        listenerRemoved = false;
        unavailable('event-listener-cleanup-failed');
      }
    }
    listenerInstalled = false;
    if (pendingOwnAnimationFrame !== null) {
      const owned = pendingOwnAnimationFrame;
      pendingOwnAnimationFrame = null;
      try {
        renderer.cancelAnimationFrame(owned);
        ownAnimationFrameCancelled = true;
      } catch {
        ownAnimationFrameCancelled = false;
        unavailable('animation-frame-cleanup-failed');
      }
    }
    retain('cleanup', {
      resizeObserverDisconnected,
      listenerRemoved,
      ownAnimationFrameCancelled,
    });
  };
  const handle = Object.freeze({
    noteTrigger: () => {
      if (cleaned) return report();
      if (triggered) {
        unavailable('duplicate-trigger-boundary');
        return report();
      }
      const row = captureState('trigger-boundary');
      triggerRootRect = row?.rootRect ?? null;
      triggered = true;
      return row;
    },
    noteAfterFill: () => {
      if (cleaned) return report();
      if (!triggered) unavailable('missing-trigger-boundary');
      return captureState('after-fill');
    },
    report,
    finalize: () => {
      if (finalizedReport) return JSON.parse(JSON.stringify(finalizedReport));
      cleanup();
      finalizedReport = report();
      return JSON.parse(JSON.stringify(finalizedReport));
    },
  });

  if (options.enabled === false) {
    unavailable('disabled');
    retain('installation', { status: 'unavailable', reason: 'disabled' });
    return handle;
  }
  try {
    root = textbox?.closest?.('[data-chat-composer-root]');
  } catch {
    counters.readFailures = increment(counters.readFailures);
    unavailable('composer-root-read-failed');
  }
  if (!root) {
    unavailable(reason ?? 'composer-root-missing');
    retain('installation', {
      status: 'unavailable',
      reason: reason ?? 'composer-root-missing',
    });
    return handle;
  }
  try {
    slateScroller = textbox?.parentElement;
  } catch {
    counters.readFailures = increment(counters.readFailures);
    unavailable('slate-scroller-read-failed');
  }
  captureState('installation');
  if (root.isConnected !== true) return handle;
  if (
    typeof renderer.ResizeObserver !== 'function' ||
    typeof renderer.addEventListener !== 'function' ||
    typeof renderer.removeEventListener !== 'function' ||
    typeof renderer.requestAnimationFrame !== 'function' ||
    typeof renderer.cancelAnimationFrame !== 'function'
  ) {
    unavailable('renderer-observation-api-unavailable');
    return handle;
  }
  try {
    resizeObserver = new renderer.ResizeObserver(onResize);
    resizeObserverDisconnectPending = true;
    resizeObserver.observe(root);
    resizeObserverObserved = true;
  } catch {
    unavailable('resize-observer-install-failed');
    disconnectOwnedResizeObserver('setup-resize-observer-cleanup');
    return handle;
  }
  try {
    renderer.addEventListener(eventName, onBoundsInvalidated);
    listenerInstalled = true;
  } catch {
    unavailable('event-listener-install-failed');
    disconnectOwnedResizeObserver('setup-resize-observer-cleanup');
  }
  return handle;
}

/**
 * Serialized verbatim into Electron; deliberately no imported closure state.
 * Passive, finite observation adds synchronous work and promise callbacks, which
 * can influence scheduling. Entry/return are not production revision checks.
 */
export function installPresentationObserver(
  { app, ipcMain },
  target,
  seams = {},
) {
  const key = '__PROFILE_PRESENTATION_ALL_WRITERS__';
  const { AsyncLocalStorage } = process.getBuiltinModule('node:async_hooks');
  const { isPromise } = process.getBuiltinModule('node:util').types;
  const { resolve } = process.getBuiltinModule('node:path');
  if (Object.getOwnPropertyDescriptor(globalThis, key))
    throw new Error('Presentation observer already installed');
  if (resolve(app.getPath('userData')) !== resolve(target.userDataDir))
    throw new Error('Presentation observer userData identity mismatch');
  const identity = {};
  for (const name of [
    'injectionId',
    'projectId',
    'worktreeId',
    'browserId',
    'profileId',
    'dialogId',
  ]) {
    const value = target[name];
    if (
      typeof value !== 'string' ||
      !/^[a-z0-9-]{1,128}$/i.test(value) ||
      Buffer.byteLength(value) > 128
    )
      throw new Error('Presentation observer requires synthetic identities');
    identity[name] = value;
  }
  for (const name of [
    'runtimeGeneration',
    'storageGeneration',
    'ownerRendererWebContentsId',
  ]) {
    if (!Number.isSafeInteger(target[name]))
      throw new Error(
        'Presentation observer requires exact generations and owner',
      );
    identity[name] = target[name];
  }
  const targetBounds = {};
  for (const name of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(target.bounds?.[name]))
      throw new Error('Presentation observer requires finite bounds');
    targetBounds[name] = target.bounds[name];
  }
  const channels = {
    bounds: 'browser:set-bounds',
    visible: 'browser:set-visible',
  };
  const delegates = {},
    wrappers = {},
    missingOwned = {};
  for (const name of Object.keys(channels)) {
    delegates[name] = ipcMain._invokeHandlers.get(channels[name]);
    if (typeof delegates[name] !== 'function')
      throw new Error('Missing presentation handler');
  }
  const context = new AsyncLocalStorage();
  const calls = [],
    events = [],
    snapshots = [],
    cleanup = [];
  let notificationGaps = 0;
  let closed = false,
    detached = false,
    ordinal = 0,
    entries = 0;
  let eventBytes = 0,
    diagnosticFailures = 0,
    droppedCalls = 0,
    droppedEvents = 0;
  let incomplete = false,
    truncationReason = null,
    cutoff = null,
    cohortCaptured = false;
  let terminalCaptured = false,
    releaseCaptured = false,
    admissionClosedAt = null;
  let cohortAdmissionComplete = true,
    unknownAdmissions = 0;
  const controlledLaterHide = target.controlledLaterHide === true;
  let earlierGateHeld = false,
    newerGateHeld = false,
    controlledWitnessCaptured = false,
    controlledWitnessUnavailable = 0,
    controlledTriggerAfterEntry = null;
  let lastTime = 0,
    finalizedReport,
    restoration,
    frozenOrdering,
    initialState;
  const origin = process.hrtime.bigint();
  let diagnosticGetter = seams.diagnosticGetter;
  const clock =
    seams.clock ?? (() => Number(process.hrtime.bigint() - origin) / 1e6);
  const increment = (value) => Math.min(1_000_000_000, value + 1);
  const fail = () => {
    diagnosticFailures = increment(diagnosticFailures);
    incomplete = true;
  };
  const truncate = (reason) => {
    incomplete = true;
    truncationReason ??= reason;
  };
  const guard = (fn) => {
    if (!closed) {
      try {
        return fn();
      } catch {
        fail();
      }
    }
  };
  const time = () => {
    try {
      const value = clock();
      if (!Number.isFinite(value) || value < lastTime) throw new Error();
      lastTime = value;
    } catch {
      fail();
    }
    return lastTime;
  };
  // Own data descriptors only: never invoke getters on requests, errors or seam output.
  const data = (object, name) => {
    if (
      (typeof object !== 'object' && typeof object !== 'function') ||
      object === null
    )
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  };
  const integer = (value) => (Number.isSafeInteger(value) ? value : 'invalid');
  const boolean = (value) => (typeof value === 'boolean' ? value : 'invalid');
  const safeId = (value) =>
    typeof value === 'string' &&
    /^[a-z0-9-]{1,128}$/i.test(value) &&
    Buffer.byteLength(value) <= 128
      ? value
      : 'unavailable';
  const bounds = (value) => {
    const result = {};
    for (const name of ['x', 'y', 'width', 'height']) {
      const number = data(value, name);
      if (!Number.isFinite(number)) return 'invalid';
      result[name] = number;
    }
    return result;
  };
  const errorFields = (error) => ({
    code: [
      'operation_conflict',
      'stale_runtime',
      'profile_disabled',
      'not_found',
      'permission_denied',
      'e2e_arbitrary_B_error',
    ].includes(data(error, 'code'))
      ? data(error, 'code')
      : 'other',
    supersession:
      data(error, 'message') ===
      'A newer presentation request replaced this command.',
  });
  const event = (phase, callId) => {
    const row = {
      ordinal: (ordinal = increment(ordinal)),
      time: time(),
      phase,
    };
    if (callId !== undefined) row.callId = callId;
    const bytes = Buffer.byteLength(JSON.stringify(row));
    // 48 KiB is reserved for 64 capped calls, 32 KiB for four checkpoints,
    // 8 KiB for ordinary events and 8 KiB for identities/footer/cleanup.
    if (
      events.length >= 256 ||
      bytes > 2048 ||
      eventBytes + bytes > 8192 ||
      truncationReason
    ) {
      droppedEvents = increment(droppedEvents);
      truncate('ordinary-event-capacity');
    } else {
      events.push(row);
      eventBytes += bytes;
    }
    return row;
  };
  const pendingIds = () =>
    calls
      .filter(
        (row) =>
          row.state === 'pending' || row.state === 'pending-at-finalization',
      )
      .map((row) => row.id);
  const laterPending = () =>
    calls
      .filter((row) => row.state === 'pending' && row.postCutoff)
      .map((row) => row.id);
  const filteredState = () => {
    const getter =
      diagnosticGetter ??
      data(globalThis, '__CANOPY_E2E_PROFILE_OPERATION_DIAGNOSTICS__');
    if (typeof getter !== 'function')
      return { status: 'unavailable', reason: 'missing-seam' };
    const raw = getter({
      kind: 'browser-snapshot',
      scope: {
        projectId: identity.projectId,
        worktreeId: identity.worktreeId,
        browserId: identity.browserId,
      },
      deadline: Date.now() + 1000,
    });
    if (isPromise(raw)) {
      Promise.prototype.then.call(
        raw,
        () => {},
        () => {},
      );
      return { status: 'unavailable', reason: 'asynchronous-seam' };
    }
    const sessions = data(raw, 'sessions'),
      native = data(raw, 'native');
    if (!Array.isArray(sessions) || !Array.isArray(native))
      return {
        status: 'unavailable',
        reason:
          data(raw, 'reason') === 'expired-diagnostic-request'
            ? 'expired-deadline'
            : 'missing-exact-identity',
      };
    // The production seam scopes sessions to the exact owner, but can include siblings.
    const select = (array, matches) => {
      const found = [];
      for (let i = 0; i < Math.min(array.length, 8); i++) {
        const row = data(array, String(i));
        if (matches(row)) found.push(row);
      }
      return found;
    };
    const exact = select(
      sessions,
      (row) => data(row, 'browserId') === identity.browserId,
    );
    const views = select(native, (row) => data(row, 'matchesBrowser') === true);
    if (exact.length !== 1 || views.length !== 1)
      return {
        status: 'unavailable',
        reason:
          exact.length > 1 || views.length > 1
            ? 'ambiguous-exact-identity'
            : 'missing-exact-identity',
      };
    const session = exact[0],
      view = views[0];
    const runtimeMatch =
      data(session, 'runtimeGeneration') === identity.runtimeGeneration;
    const storageMatch =
      data(session, 'storageGeneration') === identity.storageGeneration;
    const exactView =
      Number.isSafeInteger(data(session, 'webContentsId')) &&
      data(session, 'webContentsId') === data(view, 'webContentsId') &&
      data(session, 'ownerRendererWebContentsId') ===
        identity.ownerRendererWebContentsId &&
      data(view, 'ownerRendererWebContentsId') ===
        identity.ownerRendererWebContentsId &&
      data(session, 'hostWindowId') === data(view, 'windowId');
    if (!exactView)
      return { status: 'unavailable', reason: 'exact-view-mismatch' };
    const dialogId = safeId(data(session, 'dialogId'));
    return {
      status: 'available',
      runtimeMatch,
      storageMatch,
      truncated:
        data(raw, 'truncated') === true ||
        sessions.length > 8 ||
        native.length > 8,
      nativeErrors:
        Array.isArray(data(raw, 'errors')) && data(raw, 'errors').length > 0,
      session: {
        browserId: identity.browserId,
        profileMatch: data(session, 'profileId') === identity.profileId,
        runtimeGeneration: integer(data(session, 'runtimeGeneration')),
        storageGeneration: integer(data(session, 'storageGeneration')),
        webContentsId: integer(data(session, 'webContentsId')),
        hostWindowId: integer(data(session, 'hostWindowId')),
        ownerRendererWebContentsId: identity.ownerRendererWebContentsId,
        cachedVisible: boolean(data(session, 'cachedVisible')),
        dialogId,
        dialogMatchesInitial: dialogId === identity.dialogId,
      },
      native: {
        webContentsId: integer(data(view, 'webContentsId')),
        hostWindowId: integer(data(view, 'windowId')),
        ownerRendererWebContentsId: identity.ownerRendererWebContentsId,
        matchesBrowser: true,
        destroyed: boolean(data(view, 'destroyed')),
        windowDestroyed: boolean(data(view, 'windowDestroyed')),
        visible: boolean(data(view, 'visible')),
        bounds: bounds(data(view, 'bounds')),
      },
    };
  };
  const capture = (phase, observedState, witnessCallId) => {
    if (snapshots.length >= 4) {
      truncate('snapshot-capacity');
      return;
    }
    let state;
    try {
      state = observedState ?? filteredState();
    } catch {
      fail();
      state = { status: 'unavailable', reason: 'diagnostic-getter-failed' };
    }
    if (
      state.status !== 'available' ||
      state.truncated ||
      state.nativeErrors ||
      !state.runtimeMatch ||
      !state.storageMatch ||
      !state.session?.profileMatch ||
      state.session?.cachedVisible === 'invalid' ||
      state.native?.destroyed !== false ||
      state.native?.windowDestroyed !== false ||
      state.native?.visible === 'invalid' ||
      state.native?.bounds === 'invalid'
    )
      incomplete = true;
    const row = {
      ordinal: (ordinal = increment(ordinal)),
      time: time(),
      phase,
      lastEntryOrdinal: entries,
      pendingIds: pendingIds(),
      postCutoffPendingIds: laterPending(),
      cutoff,
      admissionOpen: !detached,
      state,
      completeAdmissionCoverage:
        !incomplete &&
        !detached &&
        state.status === 'available' &&
        state.runtimeMatch &&
        state.storageMatch &&
        state.native.destroyed === false &&
        state.native.windowDestroyed === false,
    };
    if (witnessCallId !== undefined) row.witnessCallId = witnessCallId;
    if (Buffer.byteLength(JSON.stringify(row)) > 8192) {
      truncate('snapshot-byte-capacity');
      snapshots.push({
        ordinal: row.ordinal,
        time: row.time,
        phase,
        state: { status: 'unavailable', reason: 'snapshot-byte-capacity' },
        completeAdmissionCoverage: false,
      });
    } else {
      snapshots.push(row);
      return row;
    }
  };
  const maybeCohort = () => {
    if (
      cutoff !== null &&
      cohortAdmissionComplete &&
      !cohortCaptured &&
      !calls.some((row) => row.id <= cutoff && row.state === 'pending')
    ) {
      cohortCaptured = true;
      capture('cohort-settled');
    }
  };
  const terminal = (outcome, error, callId = context.getStore()) =>
    guard(() => {
      if (terminalCaptured || !['fulfilled', 'rejected'].includes(outcome))
        return;
      const call = calls.find((row) => row.id === callId);
      // The direct tagged catch also works when ordinary call admission overflowed.
      if (call && call.class !== 'B') return;
      terminalCaptured = true;
      cutoff = entries;
      cohortAdmissionComplete = droppedCalls === 0 && unknownAdmissions === 0;
      event(
        outcome === 'rejected'
          ? 'B-rejection-observed'
          : 'B-fulfillment-observed',
        callId,
      );
      capture(
        outcome === 'rejected'
          ? 'B-rejection-observed'
          : 'B-fulfillment-observed',
      );
      if (call && outcome === 'rejected') call.error = errorFields(error);
      maybeCohort();
    });
  const capCall = (call) => {
    if (Buffer.byteLength(JSON.stringify(call)) <= 768) return;
    truncate('call-byte-capacity');
    // Preserve admission and settlement identity, not oversized optional metadata.
    delete call.bounds;
    delete call.error;
    call.metadataTruncated = true;
  };
  const captureControlledWitness = (call) => {
    if (
      !controlledLaterHide ||
      controlledTriggerAfterEntry === null ||
      call.id <= controlledTriggerAfterEntry ||
      controlledWitnessCaptured ||
      !earlierGateHeld ||
      !newerGateHeld ||
      call.class !== 'untagged' ||
      call.generationStatus !== 'match' ||
      !call.ownerSender ||
      call.visible !== false ||
      call.reads.owner < 1 ||
      call.state !== 'fulfilled'
    )
      return;
    const earlier = calls.filter((row) => row.class === 'A');
    const newer = calls.filter((row) => row.class === 'B');
    if (
      earlier.length !== 1 ||
      newer.length !== 1 ||
      earlier[0].state !== 'pending' ||
      newer[0].state !== 'pending' ||
      earlier[0].id >= newer[0].id ||
      newer[0].id >= call.id ||
      newer[0].reads.owner < 1
    )
      return;
    const state = filteredState();
    if (
      incomplete ||
      state.status !== 'available' ||
      state.truncated ||
      state.nativeErrors ||
      !state.runtimeMatch ||
      !state.storageMatch ||
      !state.session.profileMatch ||
      !state.session.dialogMatchesInitial ||
      state.session.cachedVisible !== false ||
      state.native.destroyed !== false ||
      state.native.windowDestroyed !== false ||
      state.native.visible !== false ||
      state.native.bounds === 'invalid'
    ) {
      controlledWitnessUnavailable = increment(controlledWitnessUnavailable);
      incomplete = true;
      event('later-hide-witness-unavailable', call.id);
      return;
    }
    controlledWitnessCaptured = Boolean(
      capture('later-hide-fulfilled-while-gated', state, call.id),
    );
  };
  const settle = (id, outcome, error) =>
    guard(() => {
      const call = calls.find((row) => row.id === id);
      if (!call || call.state !== 'pending') return;
      if (call.class === 'B')
        terminal(outcome === 'threw' ? 'rejected' : outcome, error, id);
      call.state = outcome;
      call.settleTime = time();
      if (outcome !== 'fulfilled') call.error = errorFields(error);
      event('delegate-settled', id);
      capCall(call);
      captureControlledWitness(call);
      maybeCohort();
    });
  const admit = (name, eventObject, request) => {
    const browserDescriptor =
      request && Object.getOwnPropertyDescriptor(request, 'browserId');
    if (browserDescriptor && !Object.hasOwn(browserDescriptor, 'value')) {
      unknownAdmissions = increment(unknownAdmissions);
      fail();
      return undefined;
    }
    if (data(request, 'browserId') !== identity.browserId) return undefined;
    entries = increment(entries);
    if (calls.length >= 64) {
      droppedCalls = increment(droppedCalls);
      truncate('call-capacity');
      return undefined;
    }
    const generation = data(request, 'expectedRuntimeGeneration');
    const generationPresent =
      Object.getOwnPropertyDescriptor(request, 'expectedRuntimeGeneration') !==
      undefined;
    const generationStatus =
      generation === undefined
        ? generationPresent
          ? 'invalid'
          : 'missing'
        : !Number.isSafeInteger(generation)
          ? 'invalid'
          : generation === identity.runtimeGeneration
            ? 'match'
            : 'mismatch';
    const tag = data(request, 'e2ePresentationInjectionId');
    const visible = boolean(data(request, 'visible'));
    const projectedBounds = bounds(data(request, 'bounds'));
    const exactTag =
      tag === identity.injectionId && generationStatus === 'match';
    const classification =
      exactTag &&
      name === 'bounds' &&
      visible === true &&
      projectedBounds !== 'invalid' &&
      Object.keys(targetBounds).every(
        (key) => projectedBounds[key] === targetBounds[key],
      )
        ? 'A'
        : exactTag && name === 'visible' && visible === false
          ? 'B'
          : tag === undefined
            ? 'untagged'
            : 'other-tag';
    const senderId = integer(data(data(eventObject, 'sender'), 'id'));
    const call = {
      id: entries,
      class: classification,
      channel: name,
      generationStatus,
      suppliedGeneration:
        generationStatus === 'missing' ? 'missing' : integer(generation),
      senderId,
      ownerSender: senderId === identity.ownerRendererWebContentsId,
      visible,
      bounds: projectedBounds,
      enterTime: time(),
      state: 'pending',
      reads: { index: 0, owner: 0 },
      postCutoff: cutoff !== null,
    };
    capCall(call);
    calls.push(call);
    event('delegate-enter', call.id);
    return call.id;
  };
  const observeResult = (id, result) =>
    guard(() => {
      event('delegate-return', id);
      if (isPromise(result)) {
        // Side callbacks close over only the bounded call ID, never the request.
        Promise.prototype.then.call(
          result,
          () => {
            settle(id, 'fulfilled');
          },
          (error) => {
            settle(id, 'rejected', error);
          },
        );
      } else settle(id, 'fulfilled');
    });
  for (const name of Object.keys(channels)) {
    wrappers[name] = function (eventObject, request) {
      let id;
      if (!closed && !detached) {
        try {
          id = admit(name, eventObject, request);
        } catch {
          unknownAdmissions = increment(unknownAdmissions);
          fail();
        }
      }
      let result;
      try {
        result =
          id === undefined
            ? delegates[name].call(this, eventObject, request)
            : context.run(id, delegates[name].bind(this), eventObject, request);
      } catch (error) {
        if (id !== undefined) settle(id, 'threw', error);
        throw error;
      }
      if (id !== undefined) observeResult(id, result);
      return result;
    };
  }
  const noteOwnerRead = (kind) =>
    guard(() => {
      if (detached || !['index', 'owner'].includes(kind)) return;
      const id = context.getStore(),
        call = calls.find((row) => row.id === id);
      if (!call) return;
      call.reads[kind] = increment(call.reads[kind]);
      call.lastReadTime = time();
      event(`owner-read-${kind}`, id);
      capCall(call);
    });
  const noteGate = (phase) =>
    guard(() => {
      if (
        detached ||
        ![
          'gate-enter',
          'gate-release-requested',
          'gate-resumed',
          'newer-gate-enter',
          'newer-gate-release-requested',
          'newer-gate-resumed',
        ].includes(phase)
      )
        return;
      event(phase, context.getStore());
      if (phase === 'gate-enter') earlierGateHeld = true;
      if (phase === 'gate-release-requested') earlierGateHeld = false;
      if (phase === 'newer-gate-enter') newerGateHeld = true;
      if (phase === 'newer-gate-release-requested') newerGateHeld = false;
      if (phase === 'gate-release-requested' && !releaseCaptured) {
        releaseCaptured = true;
        // Controlled C replaces this one reserved slot only when its positive
        // checkpoint exists; original/no-witness paths retain release evidence.
        if (!controlledWitnessCaptured) capture('gate-release-boundary');
      }
    });
  const cleanupFailure = (channel, reason) => {
    incomplete = true;
    if (cleanup.length < 8) cleanup.push({ channel, reason });
  };
  const restoreBinding = (name) => {
    try {
      const current = ipcMain._invokeHandlers.get(channels[name]);
      if (current === delegates[name]) return true;
      if (
        current !== wrappers[name] &&
        !(current === undefined && missingOwned[name])
      ) {
        cleanupFailure(name, 'restoration-conflict');
        return false;
      }
      if (current === wrappers[name]) {
        ipcMain.removeHandler(channels[name]);
        missingOwned[name] = true;
      }
      // A conflicting replacement introduced by removeHandler is also foreign.
      if (ipcMain._invokeHandlers.has(channels[name])) {
        cleanupFailure(name, 'restoration-conflict');
        return false;
      }
      ipcMain.handle(channels[name], delegates[name]);
      missingOwned[name] = false;
      return ipcMain._invokeHandlers.get(channels[name]) === delegates[name];
    } catch {
      cleanupFailure(name, 'restoration-failed');
      return false;
    }
  };
  const detach = () => {
    if (detached || closed) return restoration;
    if (!frozenOrdering) guard(() => capture('pre-detach'));
    admissionClosedAt = time();
    detached = true;
    restoration = { restored: {} };
    for (const name of Object.keys(channels))
      restoration.restored[name] = restoreBinding(name);
    context.disable();
    return restoration;
  };
  const report = () =>
    finalizedReport ??
    JSON.parse(
      JSON.stringify({
        version: 1,
        identity,
        initialState,
        calls,
        events,
        snapshots,
        cleanup,
        incomplete,
        truncationReason,
        droppedCalls,
        droppedEvents,
        diagnosticFailures,
        notificationGaps,
        controlledWitnessCaptured,
        controlledWitnessUnavailable,
        controlledTriggerAfterEntry,
        entryCount: entries,
        cutoff,
        cohortCaptured,
        cohortAdmissionComplete,
        unknownAdmissions,
        admissionClosedAt,
        observationGap: detached,
        pendingIds: pendingIds(),
        cohortStatus:
          cutoff === null
            ? 'no-terminal-cutoff'
            : !cohortAdmissionComplete
              ? 'cohort-unavailable-admission-gap'
              : cohortCaptured
                ? 'recorded-cohort-settled'
                : 'cohort-not-settled-at-finalization',
        observationSemantics:
          'point-in-time; entry ordinals are not production revisions',
      }),
    );
  const finalize = () => {
    if (closed) return finalizedReport;
    detach();
    for (const call of calls)
      if (call.state === 'pending') {
        call.state = 'pending-at-finalization';
        incomplete = true;
        capCall(call);
      }
    if (data(globalThis, key) === handle) delete globalThis[key];
    else cleanupFailure('global', 'restoration-conflict');
    finalizedReport = report();
    closed = true;
    diagnosticGetter = undefined;
    return finalizedReport;
  };
  const handle = Object.freeze({
    noteOwnerRead,
    noteGate,
    noteControlledTrigger: () =>
      guard(() => {
        if (
          !controlledLaterHide ||
          detached ||
          !earlierGateHeld ||
          !newerGateHeld ||
          controlledTriggerAfterEntry !== null
        )
          throw new Error(
            'Controlled trigger requires both original gates held exactly once',
          );
        controlledTriggerAfterEntry = entries;
        return event('controlled-composer-trigger-armed');
      }),
    noteTerminal: terminal,
    noteGap: () =>
      guard(() => {
        notificationGaps = increment(notificationGaps);
        incomplete = true;
        event('notification-gap');
      }),
    freezeOrdering: () => {
      if (!frozenOrdering) {
        if (data(globalThis, key) !== handle)
          cleanupFailure('global', 'critical-ownership-conflict');
        for (const name of Object.keys(channels))
          if (ipcMain._invokeHandlers.get(channels[name]) !== wrappers[name])
            cleanupFailure(name, 'critical-ownership-conflict');
        guard(() => capture('final-ordering'));
        frozenOrdering = report();
      }
      return JSON.parse(JSON.stringify(frozenOrdering));
    },
    detach,
    finalize,
    report,
    contextId: () => (detached || closed ? undefined : context.getStore()),
  });
  initialState = guard(filteredState) ?? {
    status: 'unavailable',
    reason: 'initial-identity-unavailable',
  };
  globalThis[key] = handle;
  try {
    const fixture = data(
      globalThis,
      '__PROFILE_PRESENTATION_ORDERING_FIXTURE__',
    );
    if (fixture !== undefined) {
      const attach = data(fixture, 'attachPresentationObserver');
      if (typeof attach !== 'function')
        throw new Error('Missing presentation observer attachment');
      attach(handle, identity.injectionId);
    }
    for (const name of Object.keys(channels)) {
      if (ipcMain._invokeHandlers.get(channels[name]) !== delegates[name])
        throw new Error('Presentation observer installation conflict');
      ipcMain.removeHandler(channels[name]);
      missingOwned[name] = true;
      if (ipcMain._invokeHandlers.has(channels[name])) {
        missingOwned[name] = false;
        throw new Error('Presentation observer installation conflict');
      }
      ipcMain.handle(channels[name], wrappers[name]);
      missingOwned[name] = false;
    }
  } catch (error) {
    // Roll back each channel independently without claiming foreign bindings.
    for (const name of Object.keys(channels)) restoreBinding(name);
    context.disable();
    closed = true;
    if (data(globalThis, key) === handle) delete globalThis[key];
    throw error;
  }
  return handle;
}

/** Pure test oracle. Input is a detached critical-interval report, never a live
 * finalization report. Pending equivalent post-cutoff hides are not witnesses.
 * Entry IDs order observed admissions; they are not production revision IDs. */
export function verifyPresentationOrdering(input) {
  const evidence = JSON.parse(JSON.stringify(input));
  const {
    observation: report,
    beforeRelease,
    afterRelease,
    newerSettlement,
    earlierSettlement,
    rendererCheckpoints = [],
    controlledLaterHide = false,
  } = evidence;
  const reasons = [];
  const check = (condition, reason) => {
    if (!condition && reasons.length < 32) reasons.push(reason);
  };
  const calls = report?.calls ?? [];
  const events = report?.events ?? [];
  const snapshots = report?.snapshots ?? [];
  const identity = report?.identity ?? {};
  const aRows = calls.filter((row) => row.class === 'A');
  const bRows = calls.filter((row) => row.class === 'B');
  const a = aRows[0],
    b = bRows[0];
  const terminal = snapshots.find(
    (row) =>
      row.phase ===
      (b?.state === 'fulfilled'
        ? 'B-fulfillment-observed'
        : 'B-rejection-observed'),
  );
  const final = snapshots.find((row) => row.phase === 'final-ordering');
  const release = events.find((row) => row.phase === 'gate-release-requested');
  const exactSupersession = (row) =>
    row?.state === 'rejected' &&
    row.error?.code === 'operation_conflict' &&
    row.error.supersession === true;
  const eventFor = (phase, call) =>
    events.find((row) => row.phase === phase && row.callId === call?.id);
  const authorized = (call) => {
    const entry = eventFor('delegate-enter', call);
    const owner = eventFor('owner-read-owner', call);
    return (
      call?.generationStatus === 'match' &&
      call.suppliedGeneration === identity.runtimeGeneration &&
      call.ownerSender === true &&
      call.senderId === identity.ownerRendererWebContentsId &&
      call.reads?.owner > 0 &&
      entry &&
      owner &&
      owner.ordinal > entry.ordinal &&
      owner.time >= call.enterTime &&
      owner.time <= (call.settleTime ?? final?.time) &&
      call.metadataTruncated !== true
    );
  };
  const safeHide = (call) =>
    call?.class === 'untagged' &&
    (call.channel === 'visible' ||
      (call.channel === 'bounds' &&
        ['x', 'y', 'width', 'height'].every((key) =>
          Number.isFinite(call.bounds?.[key]),
        ))) &&
    call.visible === false &&
    authorized(call);
  check(
    aRows.length === 1 && bRows.length === 1 && a?.id < b?.id,
    'exact-single-tagged-A-B',
  );
  check(
    authorized(a) &&
      authorized(b) &&
      a?.channel === 'bounds' &&
      a?.visible === true &&
      b?.channel === 'visible' &&
      b?.visible === false,
    'tagged-request-identity-and-authorization',
  );
  check(
    report?.incomplete === false &&
      report.truncationReason === null &&
      report.droppedCalls === 0 &&
      report.droppedEvents === 0 &&
      report.unknownAdmissions === 0 &&
      report.diagnosticFailures === 0 &&
      report.notificationGaps === 0 &&
      report.observationGap === false &&
      report.cleanup?.length === 0,
    'complete-critical-observation',
  );
  check(
    terminal &&
      final &&
      release &&
      terminal.ordinal < release.ordinal &&
      release.ordinal < final.ordinal,
    'terminal-release-final-order',
  );
  check(
    Number.isSafeInteger(report?.cutoff) &&
      report.cohortCaptured === true &&
      report.cohortAdmissionComplete === true &&
      calls.filter((row) => row.id <= report.cutoff).length === report.cutoff &&
      calls.length === report.entryCount &&
      calls.every((row, index) => row.id === index + 1),
    'complete-finite-cohort',
  );
  const cohort = calls.filter((row) => row.id <= report?.cutoff);
  check(
    cohort.every((row) => ['fulfilled', 'rejected'].includes(row.state)),
    'finite-cohort-settled',
  );
  check(
    exactSupersession(a) &&
      earlierSettlement?.ok === false &&
      beforeRelease?.earlierSettled === false &&
      beforeRelease.gatedReleased === false &&
      beforeRelease.released === false &&
      afterRelease?.earlierSettled === true &&
      afterRelease.earlierSettledBeforeRelease === false &&
      afterRelease.earlierErrorCode === 'operation_conflict' &&
      afterRelease.gatedReleased === true &&
      afterRelease.released === true &&
      afterRelease.gatedHits === 1 &&
      a?.settleTime >= release?.time,
    'A-exact-stale-rejection-after-owned-release',
  );
  const baseline = report?.initialState;
  check(
    baseline?.status === 'available' &&
      baseline.truncated === false &&
      baseline.nativeErrors === false &&
      baseline.runtimeMatch === true &&
      baseline.storageMatch === true &&
      baseline.session?.profileMatch === true &&
      baseline.session.dialogId === identity.dialogId &&
      baseline.native?.destroyed === false &&
      baseline.native.windowDestroyed === false,
    'initial-live-native-identity',
  );
  for (const checkpoint of snapshots) {
    const state = checkpoint.state,
      session = state?.session,
      native = state?.native;
    check(
      checkpoint.admissionOpen === true &&
        checkpoint.completeAdmissionCoverage === true &&
        checkpoint.ordinal <= final?.ordinal &&
        state?.status === 'available' &&
        state.truncated === false &&
        state.nativeErrors === false &&
        state.runtimeMatch === true &&
        state.storageMatch === true &&
        session?.profileMatch === true &&
        session.browserId === identity.browserId &&
        session.runtimeGeneration === identity.runtimeGeneration &&
        session.storageGeneration === identity.storageGeneration &&
        session.dialogId === identity.dialogId &&
        session.dialogMatchesInitial === true &&
        session.ownerRendererWebContentsId ===
          identity.ownerRendererWebContentsId &&
        session.cachedVisible === false &&
        Number.isSafeInteger(session.webContentsId) &&
        Number.isSafeInteger(session.hostWindowId) &&
        session.webContentsId === baseline?.session?.webContentsId &&
        session.hostWindowId === baseline?.session?.hostWindowId &&
        native?.webContentsId === session.webContentsId &&
        native.hostWindowId === session.hostWindowId &&
        native.ownerRendererWebContentsId ===
          identity.ownerRendererWebContentsId &&
        native.matchesBrowser === true &&
        native.destroyed === false &&
        native.windowDestroyed === false &&
        native.visible === false &&
        native.bounds?.width > 0 &&
        native.bounds?.height > 0,
      `safe-native-dialog-checkpoint:${checkpoint.ordinal}`,
    );
  }
  for (const phase of [
    'B-terminal-before-A-release',
    'A-rejected-same-dialog-still-usable',
  ]) {
    const row = rendererCheckpoints.find(
      (checkpoint) => checkpoint.phase === phase,
    );
    check(
      row &&
        Number.isFinite(row.time) &&
        row.modalVisible === true &&
        row.stayEnabled === true &&
        row.leaveEnabled === true &&
        row.browserBounds?.width > 0 &&
        row.browserBounds?.height > 0,
      `usable-renderer-controls:${phase}`,
    );
  }
  const strictSuccessfulB =
    bRows.length === 1 &&
    b?.state === 'fulfilled' &&
    authorized(b) &&
    b.channel === 'visible' &&
    b.visible === false &&
    newerSettlement?.ok === true &&
    beforeRelease?.newerCompleted === true &&
    beforeRelease.newerCompletedBeforeRelease === true &&
    beforeRelease.newerErrorCode === null &&
    beforeRelease.newerEntered === true &&
    beforeRelease.reads?.newerIndex === 1 &&
    beforeRelease.reads?.newerOwner === 1 &&
    afterRelease?.newerCompleted === true &&
    b.settleTime < release?.time &&
    b.settleTime <= final?.time &&
    terminal?.pendingIds?.includes(a?.id);
  const candidates = cohort.filter((row) => row.id > b?.id);
  const postCutoff = calls.filter((row) => row.id > report?.cutoff);
  const rejectedBeforeApplicationShow = (row) =>
    strictSuccessfulB &&
    row?.class === 'untagged' &&
    row.channel === 'bounds' &&
    row.visible === true &&
    ['x', 'y', 'width', 'height'].every((key) =>
      Number.isFinite(row.bounds?.[key]),
    ) &&
    row.bounds.width > 0 &&
    row.bounds.height > 0 &&
    authorized(row) &&
    row.reads?.index > 0 &&
    eventFor('owner-read-index', row) &&
    row.id > report.cutoff &&
    row.postCutoff === true &&
    row.enterTime > b.settleTime &&
    exactSupersession(row) &&
    calls.some(
      (later) =>
        later.id > row.id &&
        safeHide(later) &&
        later.enterTime < row.settleTime &&
        later.state === 'fulfilled' &&
        later.settleTime <= final?.time,
    );
  // Pre-B untagged work can resume late too; any show outside the narrow
  // rejected-before-application class, or any unknown writer, is unsuitable.
  const otherCalls = calls.filter((row) => row !== a && row !== b);
  check(
    otherCalls.every(
      (row) => safeHide(row) || rejectedBeforeApplicationShow(row),
    ),
    'only-authorized-current-runtime-hide-candidates',
  );
  const eligible = candidates.filter((row) => {
    const owner = eventFor('owner-read-owner', row);
    return (
      safeHide(row) &&
      row.enterTime >= b.enterTime &&
      owner?.ordinal < terminal?.ordinal
    );
  });
  const witnesses = eligible.filter(
    (row) => row.state === 'fulfilled' && row.settleTime <= final?.time,
  );
  // A rejected duplicate is safe only with a later admitted, authorized hide
  // that already entered before its rejection and ultimately fulfilled.
  // A fully validated fulfilled B can also settle an earlier safe hide without
  // becoming an after-B witness or broadening the untagged safe-hide class.
  const settlementTerminators = strictSuccessfulB
    ? [...otherCalls, b]
    : otherCalls;
  const safeSettlements = new Map();
  for (const row of [...otherCalls].reverse()) {
    safeSettlements.set(
      row.id,
      row.state === 'fulfilled' ||
        (exactSupersession(row) &&
          settlementTerminators.some(
            (later) =>
              later.id > row.id &&
              (later === b || safeHide(later)) &&
              later.enterTime <= row.settleTime &&
              later.settleTime <= final?.time &&
              (later === b || safeSettlements.get(later.id) === true),
          )),
    );
  }
  const safeSettlement = (row) => safeSettlements.get(row.id) === true;
  check(
    otherCalls.every(
      (row) =>
        safeSettlement(row) ||
        (row.postCutoff === true && row.state === 'pending'),
    ),
    'safe-hide-settlements-or-authorized-pending-post-cutoff',
  );
  check(
    postCutoff.every(
      (row) =>
        row.postCutoff === true &&
        (safeHide(row) || rejectedBeforeApplicationShow(row)),
    ),
    'post-cutoff-intent-known',
  );
  let branch = 'rejected';
  if (b?.state === 'fulfilled') {
    branch = 'latest-B';
    check(strictSuccessfulB, 'strict-successful-B-before-A-release');
  } else {
    branch = 'superseded-by-valid-later-hide';
    check(
      exactSupersession(b) &&
        newerSettlement?.ok === false &&
        beforeRelease?.newerCompleted === false &&
        afterRelease?.newerCompleted === false &&
        beforeRelease.newerErrorCode === 'operation_conflict',
      'B-exact-structured-supersession-and-not-completed',
    );
    check(
      candidates.length > 0 &&
        eligible.length === candidates.length &&
        witnesses.length > 0,
      'positive-authorized-pre-terminal-hide-witness',
    );
  }
  if (controlledLaterHide) {
    const checkpoint = snapshots.find(
      (row) => row.phase === 'later-hide-fulfilled-while-gated',
    );
    const witness = witnesses.find(
      (row) => row.id === checkpoint?.witnessCallId,
    );
    const bRelease = events.find(
      (row) => row.phase === 'newer-gate-release-requested',
    );
    check(
      witness &&
        bRelease &&
        checkpoint.ordinal < bRelease.ordinal &&
        witness.settleTime <= checkpoint.time &&
        checkpoint.pendingIds.includes(a?.id) &&
        checkpoint.pendingIds.includes(b?.id),
      'controlled-hide-fulfilled-before-B-release',
    );
  }
  const verdict = {
    version: 1,
    ok: reasons.length === 0,
    branch: reasons.length ? 'rejected' : branch,
    reasons,
    witnessCallIds: witnesses.map((row) => row.id),
    candidateCallIds: candidates.map((row) => row.id),
    cohortCallIds: cohort.map((row) => row.id),
    postCutoffCallIds: postCutoff.map((row) => row.id),
    checkpointOrdinals: snapshots.map((row) => row.ordinal),
    evidence,
  };
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(verdict);
}
