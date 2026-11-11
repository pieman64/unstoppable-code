const startDesktopOperation = jest.fn();
const succeedDesktopOperation = jest.fn();

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  startDesktopOperation: (...args: unknown[]): unknown =>
    startDesktopOperation(...args),
  succeedDesktopOperation: (...args: unknown[]): unknown =>
    succeedDesktopOperation(...args),
}));

const mockUnreachable = new Error('daemon unreachable');

jest.mock('../../code-graph/daemon-code-graph-route', () => ({
  noteDaemonCodeGraphFallback: (error: unknown): boolean =>
    error === mockUnreachable,
}));

import { DESKTOP_OPERATIONS } from '@canopy/desktop-instrumentation/operations';
import {
  onDaemonCodeGraphRoute,
  withDaemonCodeGraphRoute,
  type DaemonCodeGraphRouteOutcome,
} from '../../code-graph/daemon-code-graph-route-context';
import {
  DAEMON_ROUTE_REASONS,
  daemonRouteLabels,
  recordDaemonRoute,
  recordDaemonRouteDecision,
} from '../daemon-route-telemetry';

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function contexts(): unknown[] {
  return succeedDesktopOperation.mock.calls.map(
    ([, options]: [unknown, { context: unknown }]) => options.context,
  );
}

beforeEach(() => {
  startDesktopOperation.mockClear();
  succeedDesktopOperation.mockClear();
});

describe('daemon route outcome telemetry (CAN-5093)', () => {
  it('declares only the family, host and reason keys', () => {
    expect(DESKTOP_OPERATIONS['canopy.daemon_route']).toEqual({
      kind: 'product',
      posthogEvent: 'daemon:route_select',
      contextKeys: ['route_family', 'route_host', 'route_reason'],
    });
  });

  it('sends a served route as the daemon and every other reason as in process', async () => {
    recordDaemonRoute('scripts', 'served');
    recordDaemonRoute('workflows', 'model_alias');
    recordDaemonRoute('terminals', 'capacity');
    recordDaemonRoute('code_graph', 'unreachable');
    // Never on the caller's own task.
    expect(succeedDesktopOperation).not.toHaveBeenCalled();
    await settle();
    expect(contexts()).toEqual([
      { route_family: 'scripts', route_host: 'daemon', route_reason: 'served' },
      {
        route_family: 'workflows',
        route_host: 'in_process',
        route_reason: 'model_alias',
      },
      {
        route_family: 'terminals',
        route_host: 'in_process',
        route_reason: 'capacity',
      },
      {
        route_family: 'code_graph',
        route_host: 'in_process',
        route_reason: 'unreachable',
      },
    ]);
    for (const [name] of succeedDesktopOperation.mock.calls)
      expect(name).toBe('canopy.daemon_route');
  });

  it('maps any value outside the fixed lists to the fixed code other', async () => {
    // Untyped input, as a caller outside the typed lists could send.
    const record = (family: string, reason: string): void => {
      Reflect.apply(recordDaemonRoute, undefined, [family, reason]);
    };
    record('scripts', 'capacity');
    record('terminals', '/Users/someone/project');
    record('code_graph', 'served ');
    record('workflows', 'ws-1234/worktree-5678');
    record('/Users/someone', 'served');
    await settle();
    expect(contexts()).toEqual([
      {
        route_family: 'scripts',
        route_host: 'in_process',
        route_reason: 'other',
      },
      {
        route_family: 'terminals',
        route_host: 'in_process',
        route_reason: 'other',
      },
      {
        route_family: 'code_graph',
        route_host: 'in_process',
        route_reason: 'other',
      },
      {
        route_family: 'workflows',
        route_host: 'in_process',
        route_reason: 'other',
      },
      {
        route_family: 'other',
        route_host: 'in_process',
        route_reason: 'other',
      },
    ]);
  });

  it('sends only fixed labels for any input', () => {
    const families = new Set([...Object.keys(DAEMON_ROUTE_REASONS), 'other']);
    const reasons = new Set([
      ...Object.values(DAEMON_ROUTE_REASONS).flat(),
      'other',
    ]);
    const inputs = [
      'served',
      'scripts',
      '',
      '../etc/passwd',
      'user@example.com',
      '0f0e2b6c-6f5e-4c7d-9b7a-1f2e3d4c5b6a',
      'Model Alias',
    ];
    for (const family of inputs.concat(Object.keys(DAEMON_ROUTE_REASONS)))
      for (const reason of inputs) {
        const labels = daemonRouteLabels(family, reason);
        expect(Object.keys(labels).sort()).toEqual([
          'route_family',
          'route_host',
          'route_reason',
        ]);
        expect(families.has(labels.route_family)).toBe(true);
        expect(reasons.has(labels.route_reason)).toBe(true);
        expect(['daemon', 'in_process']).toContain(labels.route_host);
      }
  });

  it('keeps every reason a short lower-case code', () => {
    for (const reasons of Object.values(DAEMON_ROUTE_REASONS))
      for (const reason of reasons) expect(reason).toMatch(/^[a-z_]{3,24}$/);
  });
});

describe('one route decision is recorded exactly once (CAN-5093)', () => {
  beforeEach(() => {
    succeedDesktopOperation.mockClear();
  });
  const reasons = (): unknown[] =>
    contexts().map((context): unknown =>
      typeof context === 'object' &&
      context !== null &&
      'route_reason' in context
        ? context.route_reason
        : undefined,
    );

  it('passes a result through with its first noted reason only', async () => {
    await expect(
      recordDaemonRouteDecision('workflows', (note) => {
        note('served');
        note('unreachable');
        return Promise.resolve('handle');
      }),
    ).resolves.toBe('handle');
    await settle();
    expect(reasons()).toEqual(['served']);
  });

  it('records refused once when the daemon refuses, and rethrows its error', async () => {
    const refusal = new Error('worker.pipeline.launchRefused');
    await expect(
      recordDaemonRouteDecision('workflows', () => Promise.reject(refusal)),
    ).rejects.toBe(refusal);
    await settle();
    expect(reasons()).toEqual(['refused']);
  });

  it('keeps a fallback reason when the in-process run then fails', async () => {
    const failed = new Error('script failed');
    await expect(
      recordDaemonRouteDecision('scripts', (note) => {
        note('unreachable');
        return Promise.reject(failed);
      }),
    ).rejects.toBe(failed);
    await settle();
    expect(reasons()).toEqual(['unreachable']);
  });
});

describe('code-graph build route outcomes (CAN-5093)', () => {
  async function settle(
    selected: boolean,
    inDaemon: () => Promise<string>,
    inProcess: () => Promise<string>,
  ): Promise<{ outcomes: DaemonCodeGraphRouteOutcome[]; error: unknown }> {
    const outcomes: DaemonCodeGraphRouteOutcome[] = [];
    let error: unknown;
    try {
      await withDaemonCodeGraphRoute(
        selected,
        () => onDaemonCodeGraphRoute(inDaemon, inProcess),
        (outcome) => outcomes.push(outcome),
      );
    } catch (thrown) {
      error = thrown;
    }
    return { outcomes, error };
  }
  const failed = new Error('build failed');

  it('reports a served build once', async () => {
    const run = await settle(
      true,
      () => Promise.resolve('daemon'),
      () => Promise.resolve('local'),
    );
    expect(run).toEqual({ outcomes: ['served'], error: undefined });
  });

  it('reports a build the daemon refused once, and still throws', async () => {
    const run = await settle(
      true,
      () => Promise.reject(failed),
      () => Promise.resolve('local'),
    );
    expect(run).toEqual({ outcomes: ['refused'], error: failed });
  });

  it('reports a fallback once when the in-process build then fails', async () => {
    const run = await settle(
      true,
      () => Promise.reject(mockUnreachable),
      () => Promise.reject(failed),
    );
    expect(run).toEqual({ outcomes: ['fallback'], error: failed });
  });

  it('reports a selected route nothing took, and nothing for an unselected one', async () => {
    const outcomes: DaemonCodeGraphRouteOutcome[] = [];
    await expect(
      withDaemonCodeGraphRoute(
        true,
        () => Promise.reject(failed),
        (outcome) => outcomes.push(outcome),
      ),
    ).rejects.toBe(failed);
    await withDaemonCodeGraphRoute(
      false,
      () => Promise.resolve('local'),
      (outcome) => outcomes.push(outcome),
    );
    expect(outcomes).toEqual(['not_dispatched']);
  });
});
