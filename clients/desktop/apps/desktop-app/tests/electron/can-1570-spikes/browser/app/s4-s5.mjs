import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const S4_PAGE_ROUTE = '/s4-s5/download-page';
const S5_PRINT_PAGE_ROUTE = '/s4-s5/print-page';
const SAME_FRAME_ROUTE = '/s4-s5/same-frame';
const CROSS_FRAME_ROUTE = '/s4-s5/cross-frame';
const LONG_PAGE_ROUTE = '/s4-s5/long-page';
const BINDING_NAME = '__can1570PrintRequested';

const cdpPrintSource = `(() => {
  if (globalThis.__can1570CdpPrintInstalled) return;
  const calls = [];
  Object.defineProperty(globalThis, '__can1570CdpPrintCalls', {
    configurable: true,
    value: calls,
  });
  Object.defineProperty(globalThis, 'print', {
    configurable: true,
    writable: true,
    value: function can1570CdpPrintProbe() {
      const detail = JSON.stringify({ href: String(location.href), isTop: window === window.top });
      calls.push(JSON.parse(detail));
      if (typeof globalThis.${BINDING_NAME} === 'function') {
        globalThis.${BINDING_NAME}(detail);
      }
    },
  });
  Object.defineProperty(globalThis, '__can1570CdpPrintInstalled', {
    configurable: true,
    value: true,
  });
})();`;

const preloadMarkerExpression = `({
  installed: globalThis.__can1570ExecuteInMainWorldInstalled === true,
  calls: globalThis.__can1570ExecuteInMainWorldCalls || [],
})`;

const cdpMarkerExpression = `({
  installed: globalThis.__can1570CdpPrintInstalled === true,
  calls: globalThis.__can1570CdpPrintCalls || [],
})`;

function errorText(error) {
  return String(error?.stack ?? error);
}

function safeLeaf(value, fallback) {
  const leaf = String(value ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+$/, '');
  return leaf || fallback;
}

function directorySnapshot(directory) {
  try {
    return readdirSync(directory)
      .sort()
      .map((name) => {
        const filePath = path.join(directory, name);
        try {
          const info = statSync(filePath);
          return { name, size: info.size, isFile: info.isFile() };
        } catch (error) {
          return { name, error: String(error) };
        }
      });
  } catch (error) {
    return [{ error: String(error) }];
  }
}

function makeS4Page(origin) {
  return `<!doctype html>
    <meta charset="utf-8">
    <title>CAN-1570 S4 download sources</title>
    <a id="link-attachment" href="${origin}/s4-s5/link-attachment">link attachment</a>
    <a id="attribute-download" download="attribute-download.txt" href="${origin}/s4-s5/plain">a download</a>
    <a id="blob-download" download="blob-download.txt">blob download</a>
    <a id="data-download" download="data-download.txt">data download</a>
    <a id="slow-download" href="${origin}/s4-s5/slow">slow cancel</a>
    <script>
      const blob = new Blob(['synthetic blob download\\n'], { type: 'text/plain' });
      document.getElementById('blob-download').href = URL.createObjectURL(blob);
      document.getElementById('data-download').href = 'data:text/plain;charset=utf-8,' + encodeURIComponent('synthetic data download\\n');
    </script>`;
}

function makePrintFrame(title) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
    <script>
      addEventListener('message', (event) => {
        if (event.data === 'can1570-print') window.print();
      });
    </script>
    <button onclick="window.print()">Print from ${title}</button>`;
}

function makePrintPage(mainOrigin, crossOrigin) {
  return `<!doctype html><meta charset="utf-8"><title>CAN-1570 print probe</title>
    <button id="print-main" onclick="window.print()">Print main</button>
    <iframe id="same-frame" title="same-process frame" src="${mainOrigin}${SAME_FRAME_ROUTE}"></iframe>
    <iframe id="cross-frame" title="cross-site frame" src="${crossOrigin}${CROSS_FRAME_ROUTE}"></iframe>`;
}

function makeLongPage() {
  const rows = Array.from(
    { length: 720 },
    (_, index) => `<p>synthetic print probe row ${index + 1}: CAN-1570</p>`,
  ).join('');
  return `<!doctype html><meta charset="utf-8"><title>CAN-1570 long print</title>
    <style>@page { size: letter; margin: 0.5in; } p { margin: 0; height: 24px; font: 12px sans-serif; }</style>
    <main>${rows}</main>`;
}

function registerFixtures(server) {
  const attachment =
    (filename, body = `synthetic ${filename}\n`) =>
    (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
    };

  server.register(S4_PAGE_ROUTE, makeS4Page(server.mainOrigin));
  server.register(
    S5_PRINT_PAGE_ROUTE,
    makePrintPage(server.mainOrigin, server.crossOrigin),
  );
  server.register('/s4-s5/link-attachment', attachment('link-attachment.txt'));
  server.register('/s4-s5/plain', (_req, res) => {
    const body = 'synthetic a-download source\n';
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
  server.register('/s4-s5/navigation', attachment('navigation-attachment.txt'));
  server.register(
    '/s4-s5/enospc',
    attachment('enospc-synthetic.txt', 'synthetic ENOSPC target\n'),
  );
  server.register(
    '/s4-s5/invalid-path',
    attachment('invalid-path-synthetic.txt'),
  );
  server.register('/s4-s5/slow', (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="cancel-slow.bin"',
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    });
    res.flushHeaders();
    let chunks = 0;
    const timer = setInterval(() => {
      if (res.destroyed || res.writableEnded || chunks >= 256) {
        clearInterval(timer);
        if (!res.destroyed && !res.writableEnded) res.end();
        return;
      }
      chunks += 1;
      res.write(Buffer.alloc(32 * 1024, 0x53));
    }, 100);
    res.on('close', () => clearInterval(timer));
  });
  server.register(SAME_FRAME_ROUTE, makePrintFrame('same-origin frame'));
  server.register(CROSS_FRAME_ROUTE, makePrintFrame('cross-site frame'));
  server.register(LONG_PAGE_ROUTE, makeLongPage());
}

function readQuarantineAttribute(filePath) {
  if (process.platform !== 'darwin') {
    return {
      status: 'unverified',
      reason: `macOS xattr check is not applicable on ${process.platform}`,
    };
  }
  if (!filePath || !existsSync(filePath)) {
    return {
      status: 'unverified',
      reason: 'No completed synthetic output file was available.',
    };
  }
  const result = spawnSync(
    '/usr/bin/xattr',
    ['-p', 'com.apple.quarantine', filePath],
    {
      encoding: 'utf8',
      timeout: 3000,
    },
  );
  if (result.error) {
    return { status: 'unverified', reason: String(result.error) };
  }
  if (result.status === 0) {
    return { status: 'observed', present: true, value: result.stdout.trim() };
  }
  if (result.status === 1) {
    return {
      status: 'observed',
      present: false,
      stderr: result.stderr.trim(),
    };
  }
  return {
    status: 'unverified',
    exitCode: result.status,
    stderr: result.stderr.trim(),
  };
}

function inspectFullDevice() {
  if (process.platform === 'win32') {
    return {
      available: false,
      reason: 'The safe /dev/full sink is unavailable on Windows.',
    };
  }
  try {
    const info = statSync('/dev/full');
    if (!info.isCharacterDevice()) {
      return {
        available: false,
        reason: '/dev/full exists but is not a character device.',
      };
    }
    return { available: true, path: '/dev/full', characterDevice: true };
  } catch (error) {
    return {
      available: false,
      reason: `/dev/full is unavailable: ${String(error)}`,
    };
  }
}

async function runS4(ctx) {
  const outputDir = path.resolve(ctx.config.workDir, 'can1570-s4-downloads');
  const report = {
    status: 'recorded',
    question:
      'Synchronous DownloadItem.setSavePath before pause for all sources; partial files, cancellation, disk-full distinction, and origin marks.',
    sources: [],
    cancel: null,
    enospc: null,
    invalidPath: null,
    macOSQuarantine: {
      status: 'unverified',
      reason: 'No completed synthetic output was inspected.',
    },
    windowsMarkOfTheWeb: {
      status: 'unverified',
      reason: 'Windows Mark-of-the-Web was not exercised by this platform run.',
    },
    errors: [],
  };
  let view;
  let session;
  let willDownload;
  let activeLabel = null;
  const downloads = [];
  const liveItems = new WeakMap();
  let nextOrdinal = 0;

  try {
    mkdirSync(outputDir, { recursive: true });
    registerFixtures(ctx.server);
    view = await ctx.newView(`${ctx.server.mainOrigin}${S4_PAGE_ROUTE}`);
    session = view.wc.session;

    willDownload = (_event, item) => {
      const label = activeLabel ?? `unexpected-${downloads.length + 1}`;
      const suggestedName = item.getFilename();
      const record = {
        label,
        url: item.getURL(),
        suggestedName,
        contentDisposition: item.getContentDisposition?.() ?? null,
        startedMs: performance.now(),
        operationOrder: [],
        updates: [],
        done: false,
        initialSavePath: item.getSavePath(),
      };
      downloads.push(record);
      liveItems.set(record, item);
      const ordinal = ++nextOrdinal;
      if (label === 'enospc') {
        record.targetSavePath = '/dev/full';
      } else if (label === 'invalid-path') {
        record.targetSavePath = path.join(
          outputDir,
          'missing-parent',
          'invalid-path.txt',
        );
      } else {
        record.targetSavePath = path.join(
          outputDir,
          `${ordinal}-${safeLeaf(suggestedName, 'download.bin')}`,
        );
      }

      try {
        item.setSavePath(record.targetSavePath);
        record.operationOrder.push('setSavePath');
        record.savePathAfterSet = item.getSavePath();
      } catch (error) {
        record.setSavePathError = String(error);
      }

      // This intentionally mirrors the proposed production order: choose the
      // task-owned path synchronously in will-download, then pause.
      try {
        item.pause();
        record.operationOrder.push('pause');
        record.pausedAfterPause = item.isPaused?.() ?? null;
      } catch (error) {
        record.pauseError = String(error);
      }
      const savePathCallIndex = record.operationOrder.indexOf('setSavePath');
      const pauseCallIndex = record.operationOrder.indexOf('pause');
      record.setSavePathBeforePause =
        savePathCallIndex >= 0 &&
        pauseCallIndex >= 0 &&
        savePathCallIndex < pauseCallIndex;
      record.willDownloadHandlerSynchronous = true;

      item.on('updated', (_updateEvent, state) => {
        record.lastState = state;
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        record.lastUpdateMs = performance.now();
        const files = directorySnapshot(outputDir);
        if (record.updates.length < 40) {
          record.updates.push({
            state,
            receivedBytes: record.receivedBytes,
            totalBytes: record.totalBytes,
            files,
            atMs: record.lastUpdateMs,
          });
        }
        record.currentFiles = files;
      });
      item.once('done', (_doneEvent, state) => {
        record.done = true;
        record.doneState = state;
        record.finishedMs = performance.now();
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        record.lastError =
          typeof item.getLastError === 'function' ? item.getLastError() : null;
        record.finalSavePath = item.getSavePath();
        record.finalFiles = directorySnapshot(outputDir);
        record.targetPathExists =
          label !== 'enospc' && existsSync(record.targetSavePath);
      });

      // Resume after the synchronous pause for ordinary/cancel/path probes.
      // The slow case is left running after this point so its partial paths can
      // be observed before cancellation. ENOSPC gets the same resume so an
      // available /dev/full can report a real write interruption.
      setTimeout(
        () => {
          if (record.done) return;
          try {
            if (item.isPaused?.()) {
              item.resume();
              record.operationOrder.push('resume');
            }
          } catch (error) {
            record.resumeError = String(error);
          }
        },
        label === 'cancel' ? 35 : 0,
      );
    };

    session.on('will-download', willDownload);
    await ctx.until(() => view.wc.getURL().includes(S4_PAGE_ROUTE), 5000);

    const trigger = async (label, expression, description) => {
      activeLabel = label;
      const startedMs = performance.now();
      let triggerError;
      try {
        await view.evaluate(expression, undefined, { userGesture: true });
      } catch (error) {
        triggerError = errorText(error);
      }
      let itemRecord;
      try {
        itemRecord = await ctx.until(
          () => downloads.find((candidate) => candidate.label === label),
          6000,
        );
        await ctx.until(() => itemRecord.done, 9000);
      } catch (error) {
        report.errors.push(`${label}: ${errorText(error)}`);
      }
      await ctx.sleep(80);
      activeLabel = null;
      return {
        label,
        trigger: description,
        triggerDurationMs: performance.now() - startedMs,
        triggerError,
        download: itemRecord ?? null,
      };
    };

    for (const scenario of [
      {
        label: 'link-attachment',
        expression: `document.getElementById('link-attachment').click(); true`,
        description: 'same-origin link returns Content-Disposition: attachment',
      },
      {
        label: 'attribute-download',
        expression: `document.getElementById('attribute-download').click(); true`,
        description:
          'same-origin anchor with download attribute and inline response',
      },
      {
        label: 'blob-download',
        expression: `document.getElementById('blob-download').click(); true`,
        description: 'page-created synthetic Blob URL with download attribute',
      },
      {
        label: 'data-download',
        expression: `document.getElementById('data-download').click(); true`,
        description: 'synthetic data: URL with download attribute',
      },
      {
        label: 'navigation',
        expression: `location.href = '${ctx.server.mainOrigin}/s4-s5/navigation'; true`,
        description:
          'top-level navigation receives Content-Disposition: attachment',
      },
    ]) {
      report.sources.push(
        await trigger(
          scenario.label,
          scenario.expression,
          scenario.description,
        ),
      );
    }

    activeLabel = 'cancel';
    const cancelStart = performance.now();
    let cancelTriggerError;
    try {
      await view.evaluate(
        `document.getElementById('slow-download').click(); true`,
        undefined,
        {
          userGesture: true,
        },
      );
    } catch (error) {
      cancelTriggerError = errorText(error);
    }
    let cancelRecord;
    try {
      cancelRecord = await ctx.until(
        () => downloads.find((candidate) => candidate.label === 'cancel'),
        6000,
      );
      await ctx.until(
        () =>
          cancelRecord.receivedBytes > 0 ||
          directorySnapshot(outputDir).some(
            ({ name }) =>
              name.includes('cancel-slow') || name.includes('.crdownload'),
          ),
        8000,
      );
      cancelRecord.filesBeforeCancel = directorySnapshot(outputDir);
      cancelRecord.receivedBytesBeforeCancel = cancelRecord.receivedBytes ?? 0;
      cancelRecord.pathExistsBeforeCancel = existsSync(
        cancelRecord.targetSavePath,
      );
      cancelRecord.intermediatePathsBeforeCancel =
        cancelRecord.filesBeforeCancel
          .filter(
            ({ name }) =>
              name.includes('cancel-slow') || name.endsWith('.crdownload'),
          )
          .map(({ name }) => path.join(outputDir, name));
      cancelRecord.cancelRequestedMs = performance.now();
      liveItems.get(cancelRecord)?.cancel();
      await ctx.until(() => cancelRecord.done, 6000);
      cancelRecord.filesAfterCancel = directorySnapshot(outputDir);
      const beforeCancelNames = new Set(
        cancelRecord.filesBeforeCancel.map(({ name }) => name),
      );
      const afterCancelNames = new Set(
        cancelRecord.filesAfterCancel.map(({ name }) => name),
      );
      cancelRecord.pathsRemovedByCancel = [...beforeCancelNames]
        .filter((name) => !afterCancelNames.has(name))
        .map((name) => path.join(outputDir, name));
      cancelRecord.intermediatePathsAfterCancel =
        cancelRecord.intermediatePathsBeforeCancel.filter((filePath) =>
          existsSync(filePath),
        );
      cancelRecord.finalPathExistsAfterCancel = existsSync(
        cancelRecord.targetSavePath,
      );
      cancelRecord.elapsedMs = performance.now() - cancelStart;
    } catch (error) {
      report.errors.push(`slow cancel: ${errorText(error)}`);
    }
    report.cancel = {
      trigger:
        'slow synthetic attachment; inspect directory and byte progress, then cancel',
      triggerError: cancelTriggerError,
      download: cancelRecord ?? null,
    };
    activeLabel = null;

    const fullDevice = inspectFullDevice();
    report.enospc = {
      status: fullDevice.available ? 'attempted-safe-sink' : 'unverified',
      sink: fullDevice,
      finding: fullDevice.available
        ? 'Only /dev/full is used; exact ENOSPC is reported only when Electron exposes a no-space interruption reason.'
        : 'No safe synthetic full sink is available; actual ENOSPC remains unverified.',
    };
    if (fullDevice.available) {
      const attempt = await trigger(
        'enospc',
        `location.href = '${ctx.server.mainOrigin}/s4-s5/enospc'; true`,
        'synthetic attachment writes only to the /dev/full character-device sink',
      );
      report.enospc.download = attempt.download;
      report.enospc.triggerError = attempt.triggerError;
      const rawError = attempt.download?.lastError;
      const normalizedError = String(rawError ?? '').toLowerCase();
      if (
        normalizedError.includes('no_space') ||
        normalizedError.includes('no space') ||
        normalizedError.includes('enospc') ||
        rawError === 3
      ) {
        report.enospc.status = 'observed-enospc';
        report.enospc.finding =
          'The safe sink produced an Electron no-space error.';
      } else {
        report.enospc.status = 'unverified';
        report.enospc.finding =
          'The safe sink was exercised, but the available Electron result did not identify the failure as ENOSPC.';
      }
    }

    const invalidPathAttempt = await trigger(
      'invalid-path',
      `location.href = '${ctx.server.mainOrigin}/s4-s5/invalid-path'; true`,
      'synthetic attachment targets a missing parent directory inside the disposable workDir',
    );
    report.invalidPath = {
      ...invalidPathAttempt,
      target: path.join(outputDir, 'missing-parent', 'invalid-path.txt'),
      parentExists: existsSync(path.join(outputDir, 'missing-parent')),
      classification:
        'invalid-path comparison only; never treat this as ENOSPC',
    };

    const quarantineSource = downloads.find(
      (record) =>
        record.label === 'link-attachment' &&
        record.doneState === 'completed' &&
        record.finalSavePath &&
        existsSync(record.finalSavePath),
    );
    report.macOSQuarantine = readQuarantineAttribute(
      quarantineSource?.finalSavePath,
    );
    report.macOSQuarantine.syntheticFile =
      quarantineSource?.finalSavePath ?? null;
    report.windowsMarkOfTheWeb = {
      status: 'unverified',
      reason:
        'Windows Mark-of-the-Web is a Windows-specific filesystem behavior and was not exercised here.',
    };
  } catch (error) {
    report.errors.push(`S4 setup: ${errorText(error)}`);
  } finally {
    if (session && willDownload)
      session.removeListener('will-download', willDownload);
  }

  report.downloadEventCount = downloads.length;
  report.downloadEventRecords = downloads;
  report.evidence = view?.evidence() ?? {
    unavailable: 'S4 view was not created.',
  };
  view?.dispose();
  return report;
}

function findCrossSessionCached(view, crossOrigin) {
  for (const [sessionId, targetInfo] of view.sessions) {
    if (String(targetInfo.url ?? '').startsWith(crossOrigin)) return sessionId;
  }
  for (const event of view.events) {
    if (
      event.method === 'Target.attachedToTarget' &&
      String(event.params?.targetInfo?.url ?? '').startsWith(crossOrigin)
    ) {
      return event.params.sessionId;
    }
  }
  return null;
}

async function readFrameEvidence(view, crossOrigin, crossSessionId) {
  const result = {
    requestedSameOriginFrame: `${view.wc.getURL().split('/').slice(0, 3).join('/')}${SAME_FRAME_ROUTE}`,
    requestedCrossSiteFrame: `${crossOrigin}${CROSS_FRAME_ROUTE}`,
    crossSiteSessionId: crossSessionId,
    attachedIframeTargets: view.events
      .filter(
        (event) =>
          event.method === 'Target.attachedToTarget' &&
          event.params?.targetInfo?.type === 'iframe',
      )
      .map((event) => ({
        sessionId: event.params.sessionId,
        targetId: event.params.targetInfo.targetId,
        url: event.params.targetInfo.url,
      })),
  };
  try {
    const { frameTree } = await view.send('Page.getFrameTree');
    const frames = [];
    const visit = (tree) => {
      if (!tree) return;
      if (tree.frame) {
        frames.push({
          id: tree.frame.id,
          parentId: tree.frame.parentId ?? null,
          url: tree.frame.url,
          securityOrigin: tree.frame.securityOrigin,
        });
      }
      for (const child of tree.childFrames ?? []) visit(child);
    };
    visit(frameTree);
    result.pageFrameTree = frames;
    result.sameOriginFrameInRootTree = frames.some((frame) =>
      frame.url.startsWith(result.requestedSameOriginFrame),
    );
    result.crossSiteFrameInRootTree = frames.some((frame) =>
      frame.url.startsWith(result.requestedCrossSiteFrame),
    );
    result.sameOriginProcessEvidence =
      'Same-origin iframe has no separate attached iframe target when only the cross-site target is listed; this is consistent with same-process framing, not a direct OS process-id assertion.';
  } catch (error) {
    result.frameTreeError = errorText(error);
  }
  return result;
}

async function waitForCrossSession(view, crossOrigin) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const sessionId = findCrossSessionCached(view, crossOrigin);
    if (sessionId) return sessionId;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  // TargetInfo on the attach event can still say about:blank. Ask the browser
  // target list once, then correlate the now-current target id to its flattened
  // attached session rather than assuming the cached URL was refreshed.
  try {
    const { targetInfos = [] } = await view.send('Target.getTargets');
    const crossTargets = new Set(
      targetInfos
        .filter((target) => String(target.url ?? '').startsWith(crossOrigin))
        .map((target) => target.targetId),
    );
    for (const [sessionId, targetInfo] of view.sessions) {
      if (crossTargets.has(targetInfo.targetId)) return sessionId;
    }
    for (const event of view.events) {
      if (
        event.method === 'Target.attachedToTarget' &&
        crossTargets.has(event.params?.targetInfo?.targetId)
      ) {
        return event.params.sessionId;
      }
    }
  } catch {
    // Lack of a discoverable iframe target remains an explicit finding below.
  }
  return null;
}

async function installCdpInterception(view, sessionId) {
  if (sessionId) await view.send('Runtime.enable', {}, sessionId);
  await view.send('Runtime.addBinding', { name: BINDING_NAME }, sessionId);
  return view.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: cdpPrintSource },
    sessionId,
  );
}

async function navigateCrossFrame(view, sessionId, crossOrigin) {
  if (!sessionId)
    return {
      status: 'unverified',
      reason: 'No attached cross-site iframe target was observed.',
    };
  const url = `${crossOrigin}${CROSS_FRAME_ROUTE}`;
  try {
    await view.send('Page.enable', {}, sessionId);
    await installCdpInterception(view, sessionId);
    await view.send('Page.navigate', { url }, sessionId);
    await ctxUntilFrame(view, sessionId);
    return { status: 'ready', sessionId, url };
  } catch (error) {
    return { status: 'error', sessionId, url, error: errorText(error) };
  }
}

async function ctxUntilFrame(view, sessionId) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    try {
      if (
        (await view.evaluate(
          'document.readyState === "complete"',
          sessionId,
        )) === true
      )
        return true;
    } catch {
      // Frame navigation is in flight.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Cross-site iframe did not reach readyState=complete.');
}

async function readFrameMarker(view, kind, sessionId) {
  const expression =
    kind === 'cdp' ? cdpMarkerExpression : preloadMarkerExpression;
  return view.evaluate(expression, sessionId);
}

async function collectPrintCaptures(view, kind, crossSessionId) {
  const top = await readFrameMarker(view, kind);
  let same = {
    installed: false,
    calls: [],
    readError: 'same-process frame was not readable',
  };
  try {
    const expression =
      kind === 'cdp'
        ? `({installed: frames[0]?.__can1570CdpPrintInstalled === true, calls: frames[0]?.__can1570CdpPrintCalls || []})`
        : `({installed: frames[0]?.__can1570ExecuteInMainWorldInstalled === true, calls: frames[0]?.__can1570ExecuteInMainWorldCalls || []})`;
    same = await view.evaluate(expression);
  } catch (error) {
    same.readError = errorText(error);
  }
  let cross = {
    installed: false,
    calls: [],
    readError: 'cross-site iframe target was not attached',
  };
  if (crossSessionId) {
    try {
      cross = await readFrameMarker(view, kind, crossSessionId);
    } catch (error) {
      cross.readError = errorText(error);
    }
  }
  return { main: top, sameProcessFrame: same, crossSiteFrame: cross };
}

async function triggerPrints(view, kind, crossSessionId, label) {
  const before = await collectPrintCaptures(view, kind, crossSessionId);
  const firstNewEventSeq = view.events.length;
  const output = {
    label,
    installedBefore: {
      main: before.main.installed,
      sameProcessFrame: before.sameProcessFrame.installed,
      crossSiteFrame: before.crossSiteFrame.installed,
    },
    invoked: [],
    errors: [],
  };

  // Only call print after confirming each interception is present. This keeps
  // the probe safe even when one candidate mechanism is unsupported.
  if (before.main.installed) {
    try {
      await view.evaluate('window.print(); true', undefined, {
        userGesture: true,
      });
      output.invoked.push('main');
    } catch (error) {
      output.errors.push(`main: ${errorText(error)}`);
    }
  }
  if (before.sameProcessFrame.installed) {
    try {
      await view.evaluate(
        `document.getElementById('same-frame').contentWindow.postMessage('can1570-print', '*'); true`,
        undefined,
        { userGesture: true },
      );
      output.invoked.push('same-process-frame');
    } catch (error) {
      output.errors.push(`same-process frame: ${errorText(error)}`);
    }
  }
  if (before.crossSiteFrame.installed) {
    try {
      await view.evaluate(
        `document.getElementById('cross-frame').contentWindow.postMessage('can1570-print', '*'); true`,
        undefined,
        { userGesture: true },
      );
      output.invoked.push('cross-site-frame');
    } catch (error) {
      output.errors.push(`cross-site frame: ${errorText(error)}`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  output.capturesAfter = await collectPrintCaptures(view, kind, crossSessionId);
  output.bindingEvents = view.events
    .filter(
      (event) =>
        event.method === 'Runtime.bindingCalled' &&
        event.params?.name === BINDING_NAME,
    )
    .map((event) => ({
      sessionId: event.sessionId,
      executionContextId: event.params.executionContextId,
      payload: event.params.payload,
      seq: event.seq,
      atMs: event.atMs,
    }));
  output.interceptedCalls = Object.fromEntries(
    Object.entries(output.capturesAfter).map(([frame, capture]) => [
      frame,
      capture.calls.length,
    ]),
  );
  output.newCallsSinceBefore = Object.fromEntries(
    Object.entries(output.capturesAfter).map(([frame, capture]) => [
      frame,
      Math.max(0, capture.calls.length - (before[frame]?.calls.length ?? 0)),
    ]),
  );
  output.bindingEvents = output.bindingEvents.filter(
    (event) => event.seq >= firstNewEventSeq,
  );
  return output;
}

async function reloadMainAndWait(view, kind) {
  const beforeTimeOrigin = await view.evaluate('performance.timeOrigin');
  await view.send('Page.reload', { ignoreCache: true });
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    try {
      const current = await view.evaluate('performance.timeOrigin');
      const marker = await readFrameMarker(view, kind);
      if (current !== beforeTimeOrigin && marker.installed) {
        return {
          status: 'reloaded',
          beforeTimeOrigin,
          afterTimeOrigin: current,
        };
      }
    } catch {
      // Navigation is in flight.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return {
    status: 'unverified',
    beforeTimeOrigin,
    reason: 'Reload did not re-establish the main-frame interception marker.',
  };
}

async function runInterceptionStrategy(ctx, kind) {
  const preloadPath = fileURLToPath(
    new URL('./s5-preload.cjs', import.meta.url),
  );
  const result = {
    mechanism:
      kind === 'cdp'
        ? 'Page.addScriptToEvaluateOnNewDocument + Runtime.addBinding'
        : 'sandbox preload contextBridge.executeInMainWorld',
    initial: null,
    reload: null,
    setupErrors: [],
  };
  let view;
  try {
    registerFixtures(ctx.server);
    view = await ctx.newView(
      undefined,
      kind === 'preload' ? { preload: preloadPath } : {},
    );
    let crossSessionId = null;

    if (kind === 'cdp') {
      try {
        await installCdpInterception(view);
      } catch (error) {
        result.setupErrors.push(`main target injection: ${errorText(error)}`);
      }
    }

    await view.wc.loadURL(`${ctx.server.mainOrigin}${S5_PRINT_PAGE_ROUTE}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      crossSessionId = await waitForCrossSession(view, ctx.server.crossOrigin);
      if (!crossSessionId)
        throw new Error('No flattened cross-site iframe session was attached.');
    } catch (error) {
      result.setupErrors.push(`cross-site target: ${errorText(error)}`);
    }
    result.frameEvidence = await readFrameEvidence(
      view,
      ctx.server.crossOrigin,
      crossSessionId,
    );

    if (kind === 'cdp' && crossSessionId) {
      const cross = await navigateCrossFrame(
        view,
        crossSessionId,
        ctx.server.crossOrigin,
      );
      result.crossSiteSetup = cross;
    }

    try {
      await ctx.until(async () => {
        const markers = await collectPrintCaptures(view, kind, crossSessionId);
        return markers.main.installed && markers.sameProcessFrame.installed;
      }, 5000);
    } catch (error) {
      result.setupErrors.push(
        `main/same-process injection readiness: ${errorText(error)}`,
      );
    }
    if (crossSessionId) {
      try {
        await ctx.until(
          async () =>
            (await readFrameMarker(view, kind, crossSessionId)).installed,
          5000,
        );
      } catch (error) {
        result.setupErrors.push(
          `cross-site injection readiness: ${errorText(error)}`,
        );
      }
    }

    try {
      result.initial = await triggerPrints(
        view,
        kind,
        crossSessionId,
        'before-reload',
      );
    } catch (error) {
      result.initial = {
        status: 'unverified',
        errors: [errorText(error)],
        invoked: [],
      };
    }
    try {
      result.reload = await reloadMainAndWait(view, kind);
    } catch (error) {
      result.reload = { status: 'unverified', error: errorText(error) };
    }
    if (result.reload.status === 'reloaded') {
      crossSessionId =
        (await waitForCrossSession(view, ctx.server.crossOrigin)) ??
        crossSessionId;
      result.frameEvidenceAfterReload = await readFrameEvidence(
        view,
        ctx.server.crossOrigin,
        crossSessionId,
      );
      if (kind === 'cdp' && crossSessionId) {
        const currentMarker = await readFrameMarker(
          view,
          kind,
          crossSessionId,
        ).catch(() => ({ installed: false }));
        if (!currentMarker.installed) {
          result.crossSiteReloadSetup = await navigateCrossFrame(
            view,
            crossSessionId,
            ctx.server.crossOrigin,
          );
        }
      }
      try {
        await ctx.until(async () => {
          const markers = await collectPrintCaptures(
            view,
            kind,
            crossSessionId,
          );
          return (
            markers.main.installed &&
            markers.sameProcessFrame.installed &&
            (!crossSessionId || markers.crossSiteFrame.installed)
          );
        }, 5000);
      } catch (error) {
        result.reloadFrameReadinessError = errorText(error);
      }
      try {
        result.afterReload = await triggerPrints(
          view,
          kind,
          crossSessionId,
          'after-reload',
        );
      } catch (error) {
        result.afterReload = {
          status: 'unverified',
          errors: [errorText(error)],
          invoked: [],
        };
      }
    } else {
      result.afterReload = {
        status: 'unverified',
        reason:
          'Print was not invoked after reload because the main-frame interception marker was not confirmed.',
      };
    }
  } catch (error) {
    result.setupErrors.push(errorText(error));
  } finally {
    result.evidence = view?.evidence() ?? {
      unavailable: 'Strategy view was not created.',
    };
    view?.dispose();
  }
  return result;
}

async function measurePrintToPdf(ctx) {
  const result = {
    status: 'recorded',
    fixture:
      '720 deterministic synthetic rows, CSS letter page size, no native print dialog',
  };
  let view;
  try {
    registerFixtures(ctx.server);
    view = await ctx.newView(`${ctx.server.mainOrigin}${LONG_PAGE_ROUTE}`);
    await ctx.until(() => view.wc.getURL().includes(LONG_PAGE_ROUTE), 5000);
    const startedMs = performance.now();
    const pdf = await ctx.bounded(
      view.wc.printToPDF({ printBackground: true, preferCSSPageSize: true }),
      30_000,
    );
    result.durationMs = performance.now() - startedMs;
    result.bytes = pdf.length;
    result.pdfHeader = pdf.subarray(0, 5).toString('ascii');
    result.pageCount = (
      pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []
    ).length;
  } catch (error) {
    result.error = errorText(error);
  } finally {
    result.evidence = view?.evidence() ?? {
      unavailable: 'PDF timing view was not created.',
    };
    view?.dispose();
  }
  return result;
}

export async function runS4S5(ctx) {
  const output = {};
  try {
    output.S4 = await runS4(ctx);
  } catch (error) {
    output.S4 = {
      status: 'recorded',
      errors: [`S4 uncaught finding error: ${errorText(error)}`],
      evidence: { unavailable: 'S4 threw before returning view evidence.' },
    };
  }

  const s5 = {
    status: 'recorded',
    question:
      'Compare main-world CDP binding injection with sandbox preload contextBridge.executeInMainWorld; capture main/same-process/cross-site print and reload behavior.',
    strategies: {},
    printToPdf: null,
    errors: [],
  };
  try {
    s5.strategies.cdp = await runInterceptionStrategy(ctx, 'cdp');
  } catch (error) {
    s5.errors.push(`CDP interception finding: ${errorText(error)}`);
    s5.strategies.cdp = {
      status: 'unverified',
      evidence: { unavailable: String(error) },
    };
  }
  try {
    s5.strategies.contextBridge = await runInterceptionStrategy(ctx, 'preload');
  } catch (error) {
    s5.errors.push(`contextBridge finding: ${errorText(error)}`);
    s5.strategies.contextBridge = {
      status: 'unverified',
      evidence: { unavailable: String(error) },
    };
  }
  try {
    s5.printToPdf = await measurePrintToPdf(ctx);
  } catch (error) {
    s5.errors.push(`printToPDF timing finding: ${errorText(error)}`);
    s5.printToPdf = {
      status: 'recorded',
      error: errorText(error),
      evidence: { unavailable: true },
    };
  }
  output.S5 = s5;
  return output;
}
