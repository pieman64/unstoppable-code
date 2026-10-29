import {
  consumePendingTerminalSpawn,
  requestTerminalSpawn,
  terminalSpawnRequestTargets,
  TERMINAL_SPAWN_REQUEST_TTL_MS,
} from '../terminal-spawn-requests';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const MAIN_LAYOUT_KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const AUX_LAYOUT_KEY = `${MAIN_LAYOUT_KEY}#aux:terminal-window`;

const PANEL_ID = 'panel-terminal-a';
const OTHER_PANEL_ID = 'panel-terminal-b';

function consumeAll(layoutKey?: string, panelId?: string): string[] {
  const modes: string[] = [];
  let request = consumePendingTerminalSpawn(
    PROJECT_ID,
    WORKTREE_ID,
    layoutKey,
    panelId,
  );
  while (request !== null) {
    modes.push(request.mode);
    request = consumePendingTerminalSpawn(
      PROJECT_ID,
      WORKTREE_ID,
      layoutKey,
      panelId,
    );
  }
  return modes;
}

describe('terminalSpawnRequests', () => {
  afterEach(() => {
    jest.useRealTimers();
    consumeAll(MAIN_LAYOUT_KEY, PANEL_ID);
    consumeAll(MAIN_LAYOUT_KEY, OTHER_PANEL_ID);
    consumeAll(AUX_LAYOUT_KEY, PANEL_ID);
    consumeAll(MAIN_LAYOUT_KEY);
    consumeAll(AUX_LAYOUT_KEY);
    consumeAll();
  });

  it('preserves every new-tab request in FIFO order before mount', () => {
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'new-tab',
    });
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'ensure',
    });
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'new-tab',
    });

    expect(consumeAll()).toEqual(['new-tab', 'ensure', 'new-tab']);
  });

  it('coalesces only redundant ensure requests', () => {
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'ensure',
    });
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'ensure',
    });
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'new-tab',
    });

    expect(consumeAll()).toEqual(['ensure', 'new-tab']);
  });

  it('allows only the originating layout to claim a scoped request', () => {
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      layoutKey: AUX_LAYOUT_KEY,
      mode: 'new-tab',
    });

    expect(
      consumePendingTerminalSpawn(PROJECT_ID, WORKTREE_ID, MAIN_LAYOUT_KEY),
    ).toBeNull();
    expect(
      consumePendingTerminalSpawn(PROJECT_ID, WORKTREE_ID, AUX_LAYOUT_KEY),
    ).toEqual(
      expect.objectContaining({
        layoutKey: AUX_LAYOUT_KEY,
        mode: 'new-tab',
      }),
    );
  });
  // Regression: a reveal resolves a SPECIFIC unbound placeholder, but the
  // request used to carry only worktree + layout. Every active terminal
  // surface in the layout was then an equally valid claimant, so an
  // already-bound sibling could claim it and merely re-focus itself —
  // leaving the revealed tab unbound and the caret on an unrelated terminal,
  // non-deterministically by mount order.
  it('lets only the targeted panel claim a panel-scoped request', () => {
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      layoutKey: MAIN_LAYOUT_KEY,
      panelId: PANEL_ID,
      mode: 'ensure',
    });

    expect(
      consumePendingTerminalSpawn(
        PROJECT_ID,
        WORKTREE_ID,
        MAIN_LAYOUT_KEY,
        OTHER_PANEL_ID,
      ),
    ).toBeNull();
    expect(
      consumePendingTerminalSpawn(
        PROJECT_ID,
        WORKTREE_ID,
        MAIN_LAYOUT_KEY,
        PANEL_ID,
      ),
    ).toEqual(expect.objectContaining({ panelId: PANEL_ID, mode: 'ensure' }));
  });

  it('keeps untargeted requests claimable by any panel in the layout', () => {
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      layoutKey: MAIN_LAYOUT_KEY,
      mode: 'ensure',
    });

    expect(
      consumePendingTerminalSpawn(
        PROJECT_ID,
        WORKTREE_ID,
        MAIN_LAYOUT_KEY,
        OTHER_PANEL_ID,
      ),
    ).toEqual(expect.objectContaining({ mode: 'ensure' }));
  });

  it('coalesces ensure requests per panel, not across panels', () => {
    for (const panelId of [PANEL_ID, PANEL_ID, OTHER_PANEL_ID]) {
      requestTerminalSpawn({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        layoutKey: MAIN_LAYOUT_KEY,
        panelId,
        mode: 'ensure',
      });
    }

    expect(consumeAll(MAIN_LAYOUT_KEY, PANEL_ID)).toEqual(['ensure']);
    expect(consumeAll(MAIN_LAYOUT_KEY, OTHER_PANEL_ID)).toEqual(['ensure']);
  });

  // A targeted reveal whose panel never becomes active would otherwise sit
  // pending forever and be claimed by that panel's eventual PASSIVE
  // activation, spawning a PTY with no gesture behind it (CAN-2309).
  it('expires a stale targeted request instead of holding it forever', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      layoutKey: MAIN_LAYOUT_KEY,
      panelId: PANEL_ID,
      mode: 'ensure',
      requestedAt: Date.now(),
    });

    jest.advanceTimersByTime(TERMINAL_SPAWN_REQUEST_TTL_MS + 1);

    expect(
      consumePendingTerminalSpawn(
        PROJECT_ID,
        WORKTREE_ID,
        MAIN_LAYOUT_KEY,
        PANEL_ID,
      ),
    ).toBeNull();
  });

  it('keeps a targeted request claimable within its window', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      layoutKey: MAIN_LAYOUT_KEY,
      panelId: PANEL_ID,
      mode: 'ensure',
      requestedAt: Date.now(),
    });

    jest.advanceTimersByTime(TERMINAL_SPAWN_REQUEST_TTL_MS - 1);

    expect(
      consumePendingTerminalSpawn(
        PROJECT_ID,
        WORKTREE_ID,
        MAIN_LAYOUT_KEY,
        PANEL_ID,
      ),
    ).not.toBeNull();
  });

  // Coalescing must not let a stale request swallow a fresh gesture and then
  // expire moments later: the TTL measures from the LATEST reveal, not the
  // first. Otherwise the user's most recent click produces no terminal.
  it('restarts the expiry window when a fresh gesture coalesces', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      layoutKey: MAIN_LAYOUT_KEY,
      panelId: PANEL_ID,
      mode: 'ensure',
      requestedAt: Date.now(),
    });

    // Almost expired, then the user gestures again.
    jest.advanceTimersByTime(TERMINAL_SPAWN_REQUEST_TTL_MS - 1);
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      layoutKey: MAIN_LAYOUT_KEY,
      panelId: PANEL_ID,
      mode: 'ensure',
      requestedAt: Date.now(),
    });

    // Past the FIRST gesture's deadline, but well inside the second's.
    jest.advanceTimersByTime(2);

    expect(
      consumePendingTerminalSpawn(
        PROJECT_ID,
        WORKTREE_ID,
        MAIN_LAYOUT_KEY,
        PANEL_ID,
      ),
    ).not.toBeNull();
  });

  it('does not give an untargeted request an expiry by coalescing', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      layoutKey: MAIN_LAYOUT_KEY,
      mode: 'ensure',
    });
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      layoutKey: MAIN_LAYOUT_KEY,
      mode: 'ensure',
    });

    jest.advanceTimersByTime(TERMINAL_SPAWN_REQUEST_TTL_MS * 10);

    expect(consumeAll(MAIN_LAYOUT_KEY)).toEqual(['ensure']);
  });

  it('never expires an untargeted shortcut request', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'new-tab',
    });

    jest.advanceTimersByTime(TERMINAL_SPAWN_REQUEST_TTL_MS * 10);

    expect(consumePendingTerminalSpawn(PROJECT_ID, WORKTREE_ID)).not.toBeNull();
  });

  // "Targeted implies expiring" is a property of the bus, not a convention
  // callers must remember. An unstamped targeted request would be immortal:
  // it coalesces as the retained entry, is never refreshed, never expires,
  // and eventually fires on a passive activation (CAN-2309) — failing open.
  it('stamps a targeted request that arrived without one', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    requestTerminalSpawn({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      layoutKey: MAIN_LAYOUT_KEY,
      panelId: PANEL_ID,
      mode: 'ensure',
    });

    jest.advanceTimersByTime(TERMINAL_SPAWN_REQUEST_TTL_MS + 1);

    expect(
      consumePendingTerminalSpawn(
        PROJECT_ID,
        WORKTREE_ID,
        MAIN_LAYOUT_KEY,
        PANEL_ID,
      ),
    ).toBeNull();
  });

  describe('terminalSpawnRequestTargets', () => {
    it('mirrors the claim rules the surface subscription filters on', () => {
      const request = {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        layoutKey: MAIN_LAYOUT_KEY,
        panelId: PANEL_ID,
        mode: 'ensure',
      } as const;

      expect(
        terminalSpawnRequestTargets(
          request,
          PROJECT_ID,
          WORKTREE_ID,
          MAIN_LAYOUT_KEY,
          PANEL_ID,
        ),
      ).toBe(true);
      expect(
        terminalSpawnRequestTargets(
          request,
          PROJECT_ID,
          WORKTREE_ID,
          MAIN_LAYOUT_KEY,
          OTHER_PANEL_ID,
        ),
      ).toBe(false);
      expect(
        terminalSpawnRequestTargets(
          request,
          PROJECT_ID,
          WORKTREE_ID,
          AUX_LAYOUT_KEY,
          PANEL_ID,
        ),
      ).toBe(false);
    });
  });
});
