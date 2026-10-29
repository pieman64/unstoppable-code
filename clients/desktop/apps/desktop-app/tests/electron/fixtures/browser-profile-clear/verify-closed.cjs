// Probe a trusted, request-intercepted verification document. No site script or
// network response may run, including an already-registered service worker.
module.exports = async function verifyClosed(
  control,
  origin,
  topLevelOrigin = origin,
  progress = [],
) {
  // Destroy the fixture-owned inert control on deadline; never leave a raced
  // evaluation alive behind teardown. The enclosing native probe retains 60s.
  let destruction;
  const deadline = setTimeout(() => {
    progress.push({ stage: 'verification-deadline', origin });
    if (!control.isDestroyed()) {
      destruction = new Promise((resolve) =>
        control.once('destroyed', resolve),
      );
      control.close({ waitForBeforeUnload: false });
    }
  }, 5_000);
  const requestErrors = [];
  progress.push({ stage: 'start', origin, topLevelOrigin });
  const send = (method, parameters, sessionId) =>
    sessionId
      ? control.debugger.sendCommand(method, parameters, sessionId)
      : control.debugger.sendCommand(method, parameters);
  const inspectUrl = `${origin}/__browser_profile_verify__`;
  const topUrl = `${topLevelOrigin}/__browser_profile_verify__`;
  const configure = async (sessionId) => {
    await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
    await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sessionId,
    );
    progress.push({ stage: 'configured', child: !!sessionId });
  };
  const handle = (_event, method, parameters, sessionId) => {
    if (method === 'Target.attachedToTarget') {
      progress.push({ stage: 'attached', type: parameters.targetInfo.type });
      void configure(parameters.sessionId)
        .then(() =>
          send('Runtime.runIfWaitingForDebugger', {}, parameters.sessionId),
        )
        .catch((error) => requestErrors.push(String(error.message)));
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    progress.push({
      stage: 'request',
      url: parameters.request.url,
      child: !!sessionId,
    });
    const body =
      '<!doctype html><title>Local storage verification</title>' +
      (parameters.request.url === topUrl && topUrl !== inspectUrl
        ? `<iframe src="${inspectUrl}"></iframe>`
        : '');
    const response =
      (parameters.request.url === inspectUrl ||
        parameters.request.url === topUrl) &&
      parameters.resourceType === 'Document'
        ? send(
            'Fetch.fulfillRequest',
            {
              requestId: parameters.requestId,
              responseCode: 200,
              responseHeaders: [
                { name: 'Content-Type', value: 'text/html' },
                {
                  name: 'Content-Security-Policy',
                  value: `default-src 'none'; frame-src ${origin}; frame-ancestors ${topLevelOrigin}`,
                },
                { name: 'Cache-Control', value: 'no-store' },
              ],
              body: Buffer.from(body).toString('base64'),
            },
            sessionId,
          )
        : send(
            'Fetch.failRequest',
            {
              requestId: parameters.requestId,
              errorReason: 'BlockedByClient',
            },
            sessionId,
          );
    void response.catch((error) => requestErrors.push(String(error.message)));
  };
  control.debugger.on('message', handle);
  try {
    await configure();
    if (topUrl !== inspectUrl)
      await control.debugger.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
      });
    progress.push({ stage: 'loading' });
    await control.loadURL(topUrl);
    progress.push({ stage: 'loaded' });
    const frame = control.mainFrame.framesInSubtree.find(
      (frame) => frame.url === inspectUrl,
    );
    if (!frame)
      throw new Error('The trusted verification frame was not loaded.');
    const inspected = await frame.executeJavaScript(`(async () => {
      const root = await navigator.storage.getDirectory(); let files = 0;
      const entries = []; let truncated = false;
      for await (const entry of root.values()) {
        files++;
        if (entries.length >= 16) { truncated = true; continue; }
        const item = { name: entry.name.slice(0,128), kind: entry.kind, nameTruncated: entry.name.length > 128 };
        if (!item.nameTruncated) delete item.nameTruncated;
        if (entry.kind === 'file') {
          try { item.size = (await entry.getFile()).size; }
          catch (error) { item.error = { name: String(error.name).slice(0,128), message: String(error.message).slice(0,240) }; }
        }
        entries.push(item);
      }
      return { metadata: { entries, truncated, count: files }, semantic: { title: document.title, origin: location.origin, localStorageCount: localStorage.length,
        databaseCount: (await indexedDB.databases()).length, cacheCount: (await caches.keys()).length,
        workerCount: (await navigator.serviceWorker.getRegistrations()).length, opfsEntries: files } };
    })()`);
    if (requestErrors.length) throw new Error(requestErrors.join('; '));
    progress.push({
      stage: 'opfs-metadata',
      origin,
      topLevelOrigin,
      ...inspected.metadata,
    });
    progress.push({ stage: 'inspected' });
    return inspected.semantic;
  } finally {
    // Keep the same deadline through inert navigation/Fetch cleanup as well.
    try {
      if (destruction) await destruction;
      if (!control.isDestroyed?.()) {
        await control.loadURL('about:blank');
        if (topUrl !== inspectUrl)
          await control.debugger.sendCommand('Target.setAutoAttach', {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          });
        await control.debugger.sendCommand('Fetch.disable');
      }
    } finally {
      if (destruction) await destruction;
      clearTimeout(deadline);
      control.debugger.removeListener('message', handle);
      progress.push({
        stage: control.isDestroyed?.() ? 'finished-destroyed' : 'finished',
        requestErrors,
      });
    }
  }
};
