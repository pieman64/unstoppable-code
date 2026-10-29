// Baseline lifecycle evidence uses the real BrowserService and a fixture-owned
// Session, without deriving a partition name or using proposed profile APIs.
export async function seedBrowserProfileState(electronApp, window, owner) {
  const url = `${(process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011').replace(/\/+$/, '')}/browser-fixture/one`;
  const browser = await window.evaluate(
    (request) => window.api.browser.create(request),
    { ...owner, url },
  );
  const webContentsId = await electronApp.evaluate(
    async ({ webContents }, fixtureUrl) => {
      const matches = webContents
        .getAllWebContents()
        .filter((contents) => contents.getURL() === fixtureUrl);
      if (matches.length !== 1)
        throw new Error('Expected one fixture-owned browser');
      const contents = matches[0];
      globalThis.__browserProfileFixtureSessions ??= new Map();
      globalThis.__browserProfileFixtureSessions.set(
        contents.id,
        contents.session,
      );
      await contents.session.cookies.set({
        url: fixtureUrl,
        name: 'profile-lifecycle',
        value: 'synthetic',
        expirationDate: Math.floor(Date.now() / 1000) + 3600,
      });
      return contents.id;
    },
    url,
  );
  return {
    browserId: browser.id,
    profile: browser.profile,
    webContentsId,
    url,
  };
}

export async function readBrowserProfileState(electronApp, fixture) {
  return electronApp.evaluate(
    async ({ webContents }, { webContentsId, url }) => {
      const contents = webContents.fromId(webContentsId);
      const native =
        globalThis.__browserProfileFixtureSessions?.get(webContentsId);
      if (!native) throw new Error('Missing fixture-owned Session');
      const cookies = await native.cookies.get({
        url,
        name: 'profile-lifecycle',
      });
      return {
        live: Boolean(contents && !contents.isDestroyed()),
        retained: cookies.some((cookie) => cookie.value === 'synthetic'),
      };
    },
    fixture,
  );
}

export async function openRestoredBrowserProfileState(
  electronApp,
  window,
  owner,
  fixture,
) {
  const browser = await window.evaluate(
    (request) => window.api.browser.create(request),
    { ...owner, url: fixture.url },
  );
  const retained = await electronApp.evaluate(async ({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .filter((entry) => entry.getURL() === url);
    if (contents.length !== 1)
      throw new Error('Expected one restored fixture browser');
    return (
      await contents[0].session.cookies.get({ url, name: 'profile-lifecycle' })
    ).some((cookie) => cookie.value === 'synthetic');
  }, fixture.url);
  return { profile: browser.profile, retained };
}

export async function measureEntryProfileIsolation(
  electronApp,
  window,
  owner,
  fixture,
) {
  const otherEntry = await window.evaluate(
    (projectId) =>
      window.api.workEntries.create({ projectId, title: 'Other browser task' }),
    owner.projectId,
  );
  const results = [];
  for (const [label, worktreeId] of [
    ['shared', owner.worktreeId],
    ['isolated', otherEntry.entry.id],
  ]) {
    const url = `${fixture.url}?profile-check=${label}`;
    const browser = await window.evaluate(
      (request) => window.api.browser.create(request),
      { projectId: owner.projectId, worktreeId, url },
    );
    const retained = await electronApp.evaluate(
      async ({ webContents }, fixtureUrl) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL() === fixtureUrl);
        if (!contents) throw new Error('Missing isolation fixture');
        return (
          await contents.session.cookies.get({
            url: fixtureUrl,
            name: 'profile-lifecycle',
          })
        ).some((cookie) => cookie.value === 'synthetic');
      },
      url,
    );
    results.push({ profileId: browser.profile.resolvedProfileId, retained });
    await window.evaluate(
      (browserId) => window.api.browser.destroy({ browserId }),
      browser.id,
    );
  }
  return results;
}

/** Add deterministic entry owners to an already-seeded, stopped test app. */
export async function seedBrowserProfileEntryOwners(userDataDir) {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const createdAt = '2026-09-01T00:00:00.000Z';
  const owners = [
    { projectId: 'profile-data-cowork', worktreeId: 'profile-cowork-entry' },
    { projectId: 'app-advisor', worktreeId: 'profile-advisor-entry' },
  ];
  const indexPath = join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.workspaces.push({
    id: owners[0].projectId,
    name: 'Profile data work',
    type: 'cowork',
    color: '#7C3AED',
    order: 99,
    collapsed: false,
    cowork: { createdAt, archiveRetentionDays: 7 },
  });
  await writeFile(indexPath, JSON.stringify(index));
  for (const owner of owners) {
    const directory =
      owner.projectId === 'app-advisor'
        ? join(userDataDir, 'app-workspaces', owner.projectId)
        : join(userDataDir, 'workspaces', owner.projectId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'work-entries.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { id: owner.worktreeId, title: 'Browser data task', createdAt },
        ],
      }),
    );
    if (owner.projectId !== 'app-advisor')
      await writeFile(
        join(directory, 'workspace.json'),
        JSON.stringify({
          version: 1,
          type: 'cowork',
          repos: [],
          cowork: { createdAt, archiveRetentionDays: 7 },
        }),
      );
  }
  return owners;
}
