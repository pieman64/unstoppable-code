// CAN-5222: deterministic public-404/scoped-read transport fixture. The real
// IPC handler, cloud clients, credential store, hook and recovery surfaces run.
export const RECOVERY_SKILL_ID = 'fa522200-0000-5000-8000-000000000001';

export async function installScopedShareFailure(electronApp, mode) {
  await electronApp.evaluate(
    (_electron, { id, mode }) => {
      const originalFetch = globalThis.fetch;
      const state = { mode, publicReads: 0, scopedReads: 0, failAuth: false };
      globalThis.__can5222 = state;
      state.restore = () => {
        state.mode = 'success';
        state.release?.();
        globalThis.fetch = originalFetch;
        delete globalThis.__can5222;
      };
      const json = (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      globalThis.fetch = async (input, init) => {
        const { pathname } = new URL(String(input));
        if (state.failAuth && pathname.endsWith('/desktop-auth/token')) {
          return json({ error: 'Authentication failed' }, 401);
        }
        if (pathname === '/api/v1/marketplace/skills') {
          return json({
            skills: [
              {
                externalId: id,
                name: 'recovered-skill',
                description: 'Recovery fixture.',
                publisher: 'Fixture',
              },
            ],
          });
        }
        if (pathname.includes(`/public-shares/skills/${id}`)) {
          state.publicReads += 1;
          return json({ error: 'Not found' }, 404);
        }
        if (pathname.endsWith(`/skills/${id}`)) {
          state.scopedReads += 1;
          if (state.mode === 'pending' || state.mode === 'network-pending') {
            await new Promise((resolve) => {
              state.release = resolve;
            });
          }
          if (state.mode === 'network') throw new TypeError('Fixture offline');
          if (typeof state.mode === 'number')
            return json({ error: 'Unavailable' }, state.mode);
          return json({
            id,
            name: 'Recovered scoped skill',
            description: 'Scoped recovery fixture.',
            rawSkill:
              '---\nname: recovered-skill\ndescription: Recovery.\n---\n\nRecovered.\n',
            contentHash: 'b'.repeat(64),
            shareScope: 'team',
            owner: {
              type: 'team',
              id: 'team-1',
              name: 'Platform',
              organization: { id: 'org-1', name: 'Fixture' },
            },
            createdBy: { id: 'creator', name: 'Creator', email: null },
            createdAt: '2026-10-29T00:00:00.000Z',
            updatedAt: '2026-10-29T00:00:00.000Z',
            canUpdate: false,
            canDelete: false,
            publicShare: null,
          });
        }
        return originalFetch(input, init);
      };
    },
    { id: RECOVERY_SKILL_ID, mode },
  );
}

export async function setScopedShareMode(electronApp, mode) {
  await electronApp.evaluate((_electron, mode) => {
    globalThis.__can5222.mode = mode;
    globalThis.__can5222.release?.();
  }, mode);
}

export async function openRecoveryShare(electronApp) {
  await electronApp.evaluate(({ app }, id) => {
    app.emit(
      'open-url',
      { preventDefault() {} },
      `canopy://share/skills/${id}`,
    );
  }, RECOVERY_SKILL_ID);
}

export async function restoreScopedShareFetch(electronApp) {
  await electronApp.evaluate(() => globalThis.__can5222?.restore());
}
