// Native capability probe only. All HTTPS responses and storage are synthetic.
module.exports = async function partitioned({
  session,
  page,
  check,
  until,
  storage,
  evidence,
  verifyClosed,
  createHttpsServer,
  tls,
  servers,
}) {
  const native = session.fromPartition('persist:clear-capability-partitioned');
  let embedded;
  let hosts;
  let verificationRequests = 0;
  const limits = { maxRecords: 48, maxStringLength: 160 };
  const progress = {
    version: 1,
    limits,
    records: [],
    truncated: false,
    droppedRecords: 0,
    truncatedStrings: 0,
  };
  evidence.partitionSetupProgress = progress;
  const boundedString = (value) => {
    const text = String(value);
    if (text.length <= limits.maxStringLength) return text;
    progress.truncatedStrings++;
    return `${text.slice(0, limits.maxStringLength - 1)}…`;
  };
  const recordProgress = (stage, outcome, hostRole, expectedUrl) => {
    if (progress.records.length >= limits.maxRecords) {
      progress.truncated = true;
      progress.droppedRecords++;
      return;
    }
    progress.records.push({
      stage: boundedString(stage),
      outcome,
      hostRole: boundedString(hostRole),
      ...(expectedUrl === undefined
        ? {}
        : { expectedUrl: boundedString(expectedUrl) }),
      utcMs: Date.now(),
    });
  };
  const observe = async (stage, hostRole, operation, expectedUrl) => {
    recordProgress(stage, 'entered', hostRole, expectedUrl);
    const value = await operation();
    recordProgress(stage, 'fulfilled', hostRole, expectedUrl);
    return value;
  };
  // Real loopback TLS lets CDP Fetch observe requests. Session.protocol.handle
  // bypasses that interceptor and cannot validate the trusted-document design.
  const server = createHttpsServer(tls, (request, response) => {
    if (request.url === '/__browser_profile_verify__') verificationRequests++;
    const origin = `https://${request.headers.host}`;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      `<!doctype html><title>Partition fixture</title>
      <script>${storage}
      window.seed = async value => { await write(value); localStorage.setItem('writer', String(value));
        document.cookie = 'partition-check=' + value + '; Secure; SameSite=None; Partitioned; Path=/'; };
      window.readState = async () => ({ ...await read(), local: localStorage.getItem('writer') });
      </script>${hosts.includes(origin) ? `<iframe src="${embedded}/frame"></iframe>` : ''}`,
    );
  });
  servers.push(server);
  await observe(
    'server-listen',
    'server',
    () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    '127.0.0.1',
  );
  const port = server.address().port;
  embedded = `https://embedded.test:${port}`;
  hosts = [`https://first.test:${port}`, `https://second.test:${port}`];
  native.setCertificateVerifyProc((request, callback) =>
    callback(
      ['embedded.test', 'first.test', 'second.test'].includes(
        request.hostname,
      ) &&
        request.certificate.data.replace(/\r\n/g, '\n').trim() ===
          tls.cert.toString('utf8').replace(/\r\n/g, '\n').trim()
        ? 0
        : -2,
    ),
  );
  async function contexts(recordInitialProgress = false) {
    const tops = [];
    const children = [];
    for (let index = 0; index < hosts.length; index++) {
      const origin = hosts[index];
      const hostRole = index === 0 ? 'first' : 'second';
      const contents = recordInitialProgress
        ? await observe(
            'top-level-page',
            hostRole,
            () => page(native, origin),
            origin,
          )
        : await page(native, origin);
      tops.push(contents);
      const waitForChildFrame = () =>
        until(
          () =>
            contents.mainFrame.framesInSubtree.some(
              (frame) => frame.url === `${embedded}/frame`,
            ),
          'embedded frame ready',
        );
      if (recordInitialProgress)
        await observe(
          'child-frame-readiness',
          hostRole,
          waitForChildFrame,
          `${embedded}/frame`,
        );
      else await waitForChildFrame();
      const frame = contents.mainFrame.framesInSubtree.find(
        (frame) => frame.url === `${embedded}/frame`,
      );
      const waitForStorageScript = () =>
        until(
          () => frame.executeJavaScript('typeof readState === "function"'),
          'embedded storage script ready',
        );
      if (recordInitialProgress)
        await observe(
          'child-storage-script-readiness',
          hostRole,
          waitForStorageScript,
          `${embedded}/frame`,
        );
      else await waitForStorageScript();
      children.push(frame);
    }
    const firstParty = recordInitialProgress
      ? await observe(
          'first-party-page',
          'embedded-first-party',
          () => page(native, embedded),
          embedded,
        )
      : await page(native, embedded);
    return { tops, children, firstParty };
  }
  const before = await contexts(true);
  for (let index = 0; index < 2; index++) {
    const hostRole = index === 0 ? 'first' : 'second';
    await observe('seed', `${hostRole}-top-level`, () =>
      before.tops[index].executeJavaScript(`seed(${index + 11})`),
    );
    await observe('seed', `${hostRole}-embedded`, () =>
      before.children[index].executeJavaScript(`seed(${index + 101})`),
    );
  }
  await observe('seed', 'embedded-first-party', () =>
    before.firstParty.executeJavaScript('seed(303)'),
  );
  const read = (frame) => frame.executeJavaScript('readState()');
  const states = await observe('initial-state-read', 'partition-contexts', () =>
    Promise.all([...before.children, before.firstParty].map(read)),
  );
  check(
    'embedded durable stores are isolated by top-level site',
    states.map((state) => state.indexed),
    [101, 102, 303],
  );
  check(
    'embedded local storage is isolated by top-level site',
    states.map((state) => state.local),
    ['101', '102', '303'],
  );
  evidence.partitionCookieInspection = {
    nativeCount: (await native.cookies.get({ domain: 'embedded.test' })).length,
    documentValues: await Promise.all(
      [...before.children, before.firstParty].map((frame) =>
        frame.executeJavaScript('document.cookie'),
      ),
    ),
  };
  check(
    'partitioned cookies expose only their own top-level context value',
    evidence.partitionCookieInspection.documentValues,
    ['partition-check=101', 'partition-check=102', 'partition-check=303'],
  );
  // Electron's own Cookies instance supplies Session-scoped totals. CDP
  // Storage.getCookies on a page target did not select this native Session;
  // passing browserContextId is rejected unless attached to a Browser target.
  const cookiesBefore = (await native.cookies.get({})).filter(
    (cookie) =>
      cookie.name === 'partition-check' && cookie.domain === 'embedded.test',
  );
  check(
    'native partition cookies exist in three contexts',
    cookiesBefore.length,
    3,
  );
  await native.clearCache();
  check(
    'HTTP cache clear preserves first and third party durable stores',
    await Promise.all([...before.children, before.firstParty].map(read)),
    states,
  );
  check(
    'HTTP cache clear preserves partition cookies',
    (await native.cookies.get({})).filter(
      (cookie) =>
        cookie.name === 'partition-check' && cookie.domain === 'embedded.test',
    ),
    cookiesBefore,
  );
  for (const contents of [...before.tops, before.firstParty])
    contents.close({ waitForBeforeUnload: false });
  await until(
    () =>
      [...before.tops, before.firstParty].every((contents) =>
        contents.isDestroyed(),
      ),
    'all partition writers closed',
  );
  const control = await page(native, 'about:blank');
  control.debugger.attach('1.3');
  native.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.webContentsId !== control.id }),
  );
  const inspect = async () => {
    const results = [];
    for (const top of [...hosts, embedded])
      results.push(await verifyClosed(control, embedded, top));
    return results;
  };
  const trustedBefore = await inspect();
  check(
    'trusted cross-site verifier observes all three partitioned stores',
    trustedBefore.map((value) => [
      value.localStorageCount,
      value.databaseCount,
      value.cacheCount,
      value.opfsEntries,
    ]),
    [
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ],
  );
  await native.clearData({
    origins: [embedded],
    dataTypes: [
      'cookies',
      'fileSystems',
      'indexedDB',
      'localStorage',
      'serviceWorkers',
      'cache',
    ],
    originMatchingMode: 'origin-in-all-contexts',
  });
  const trustedAfter = await inspect();
  check(
    'trusted cross-site verifier confirms every declared store cleared',
    trustedAfter.map((value) => [
      value.localStorageCount,
      value.databaseCount,
      value.cacheCount,
      value.opfsEntries,
    ]),
    [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  );
  check(
    'trusted partition verifier never loads site responses',
    verificationRequests,
    0,
  );
  native.webRequest.onBeforeRequest(null);
  control.close({ waitForBeforeUnload: false });
  const after = await contexts();
  const cleared = await Promise.all(
    [...after.children, after.firstParty].map(read),
  );
  const empty = {
    indexed: null,
    cache: null,
    opfs: null,
    worker: false,
    local: null,
  };
  check(
    'origin-in-all-contexts clears declared stores in first and third party contexts',
    cleared,
    [empty, empty, empty],
  );
  const retained = await Promise.all(after.tops.map(read));
  check(
    'other top-level origins retain every seeded durable class',
    retained.map((state) => ({
      indexed: state.indexed,
      cache: state.cache,
      opfs: state.opfs,
      local: state.local,
    })),
    [11, 12].map((value) => ({
      indexed: value,
      cache: String(value),
      opfs: String(value),
      local: String(value),
    })),
  );
  const cookiesAfter = (await native.cookies.get({})).filter(
    (cookie) => cookie.name === 'partition-check',
  );
  check(
    'selected origin partition cookies cleared and other domains retained',
    cookiesAfter.map((cookie) => cookie.domain).sort(),
    ['first.test', 'second.test'],
  );
  return {
    mode: 'origin-in-all-contexts',
    contexts: 3,
    before: states,
    after: cleared,
    retained,
    trustedBefore,
    trustedAfter,
    observedTopLevelContexts: [...hosts, embedded],
  };
};
