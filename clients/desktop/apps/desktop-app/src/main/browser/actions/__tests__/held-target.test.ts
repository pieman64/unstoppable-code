import type {
  BrowserAutomationCommand,
  BrowserJavaScriptDialog,
} from '@canopy/desktop-shared/types/browser';
import type {
  ActionTargetRequest,
  ActionTargetResolution,
  ResolvedActionTarget,
} from '../../frames/action-targets';
import { ActionLane, type ActionLaneContext } from '../action-lane';
import {
  actionTargetRequest,
  holdActionTarget,
  TargetDialogError,
  TargetResolutionError,
} from '../held-target';

const TARGET: ResolvedActionTarget = {
  identity: {
    sessionId: 'child',
    frameId: 'frame-1',
    loaderId: 'loader-1',
    backendNodeId: 9,
  },
  frameRef: 'f-1',
  objectId: 'object-1',
  objectGroup: 'group-1',
  outOfProcess: true,
};

const DIALOG: BrowserJavaScriptDialog = {
  id: 'dialog-1',
  browserId: 'browser',
  type: 'alert',
  message: 'Stop',
  url: 'https://example.test/',
  openedAt: 1,
};

function lane(): ActionLane {
  return new ActionLane({
    runtimeKey: {},
    generation: 1,
    isCurrent: () => true,
  });
}

interface Harness {
  releases: ResolvedActionTarget[];
  resolve(resolution: ActionTargetResolution): void;
  openDialog(dialog: BrowserJavaScriptDialog): void;
  hold(context: ActionLaneContext): Promise<ResolvedActionTarget>;
  requests: ActionTargetRequest[];
}

function harness(): Harness {
  const releases: ResolvedActionTarget[] = [];
  const requests: ActionTargetRequest[] = [];
  let settle: (resolution: ActionTargetResolution) => void = () => undefined;
  const dialogListeners = new Set<(dialog: BrowserJavaScriptDialog) => void>();
  const pending = new Promise<ActionTargetResolution>((resolve) => {
    settle = resolve;
  });
  return {
    releases,
    requests,
    resolve: (resolution) => settle(resolution),
    openDialog: (dialog) =>
      dialogListeners.forEach((listener) => listener(dialog)),
    hold: (context) =>
      holdActionTarget({
        host: {
          resolveActionTarget: (request) => {
            requests.push(request);
            return pending;
          },
          releaseActionTarget: (target) => {
            releases.push(target);
            return Promise.resolve();
          },
        },
        request: { kind: 'ref', ref: 'r-1' },
        lane: context,
        isDispatched: () => false,
        watchDialogs: (listener) => {
          dialogListeners.add(listener);
          return (): void => {
            dialogListeners.delete(listener);
          };
        },
      }),
  };
}

describe('the target request of a command', () => {
  it('prefers a ref, then a locator with its frame, then coordinates, then the focus of an untargeted press', () => {
    const cases: Array<
      [
        Exclude<BrowserAutomationCommand, { kind: 'inspect' | 'wait_for' }>,
        ActionTargetRequest | undefined,
      ]
    > = [
      [
        { kind: 'click', ref: 'r-1', locator: 'x' },
        { kind: 'ref', ref: 'r-1' },
      ],
      [
        { kind: 'fill', locator: "page.locator('#a')", frame: 'f-2', text: '' },
        { kind: 'locator', locator: "page.locator('#a')", frame: 'f-2' },
      ],
      [
        { kind: 'focus', locator: "page.locator('#a')" },
        { kind: 'locator', locator: "page.locator('#a')" },
      ],
      [
        { kind: 'click', x: 3, y: 4 },
        { kind: 'point', x: 3, y: 4 },
      ],
      [{ kind: 'press', key: 'Enter' }, { kind: 'focused' }],
      [{ kind: 'type', text: 'next' }, { kind: 'focused' }],
      [
        { kind: 'type', text: 'next', ref: 'r-2' },
        { kind: 'ref', ref: 'r-2' },
      ],
      [{ kind: 'click', x: 3 }, undefined],
      [{ kind: 'fill', text: 'a' }, undefined],
      [{ kind: 'focus' }, undefined],
    ];
    for (const [command, request] of cases)
      expect([command, actionTargetRequest(command)]).toEqual([
        command,
        request,
      ]);
  });
});

describe('holding the resolved target for one action (D7)', () => {
  it('resolves once and releases exactly once in the lane cleanup', async () => {
    const test = harness();
    const outcome = await lane().run(async (context) => {
      const held = test.hold(context);
      test.resolve({ status: 'found', target: TARGET });
      const target = await held;
      context.beginDispatch();
      return target;
    });
    expect(outcome).toMatchObject({ status: 'executed', value: TARGET });
    await Promise.resolve();
    expect(test.requests).toEqual([{ kind: 'ref', ref: 'r-1' }]);
    expect(test.releases).toEqual([TARGET]);
  });

  it('maps each unresolved status to its action error', async () => {
    const statuses: Array<
      [Exclude<ActionTargetResolution, { status: 'found' }>, string]
    > = [
      [{ status: 'target_stale', message: 'gone' }, 'target_stale'],
      [{ status: 'target_not_found', message: 'none' }, 'target_not_found'],
      [
        { status: 'frame_unavailable', message: 'no frame' },
        'frame_unavailable',
      ],
      [
        {
          status: 'target_ambiguous',
          message: 'The locator matched 2 elements in frames f-1, f-2.',
          matchCount: 2,
          candidates: [],
        },
        'target_ambiguous',
      ],
      [
        { status: 'invalid_locator', message: 'Invalid CSS' },
        'execution_failed',
      ],
    ];
    for (const [resolution, code] of statuses) {
      const test = harness();
      let caught: unknown;
      await lane().run(async (context) => {
        const held = test.hold(context);
        test.resolve(resolution);
        caught = await held.catch((error: unknown) => error);
      });
      expect(caught).toBeInstanceOf(TargetResolutionError);
      expect(caught).toMatchObject({ code, message: resolution.message });
      expect(test.releases).toEqual([]);
    }
  });

  it('fails with the dialog that opens while resolving, and releases the target that resolves afterwards', async () => {
    const test = harness();
    let caught: unknown;
    const outcome = await lane().run(async (context) => {
      const held = test.hold(context);
      test.openDialog(DIALOG);
      caught = await held.catch((error: unknown) => error);
      throw caught;
    });
    expect(outcome.status).toBe('not_executed');
    expect(caught).toBeInstanceOf(TargetDialogError);
    expect(caught).toMatchObject({ dialog: DIALOG });
    expect(test.releases).toEqual([]);
    test.resolve({ status: 'found', target: TARGET });
    await new Promise((resolve) => setImmediate(resolve));
    expect(test.releases).toEqual([TARGET]);
  });

  it('releases a target that resolves after the action was cancelled', async () => {
    const test = harness();
    const controller = new AbortController();
    const outcome = lane().run(
      async (context) => {
        await test.hold(context);
      },
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    expect((await outcome).status).toBe('not_executed');
    test.resolve({ status: 'found', target: TARGET });
    await new Promise((resolve) => setImmediate(resolve));
    expect(test.releases).toEqual([TARGET]);
  });

  it('registers its release before resolution can throw', async () => {
    const releases: ResolvedActionTarget[] = [];
    let thrown = false;
    await lane().run(async (context) => {
      await holdActionTarget({
        host: {
          resolveActionTarget: () => {
            thrown = true;
            throw new Error('Target closed');
          },
          releaseActionTarget: (target) => {
            releases.push(target);
            return Promise.resolve();
          },
        },
        request: { kind: 'focused' },
        lane: context,
        isDispatched: () => false,
        watchDialogs: (): (() => void) => (): void => undefined,
      }).catch(() => undefined);
    });
    expect(thrown).toBe(true);
    expect(releases).toEqual([]);
  });
});
