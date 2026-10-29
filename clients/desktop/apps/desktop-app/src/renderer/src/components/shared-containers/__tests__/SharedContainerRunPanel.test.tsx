/** @jest-environment jsdom */

/**
 * Recipient run affordance (CAN-2831): the hook that owns run state and the
 * sheet that renders it.
 *
 * Two things are pinned here that the feature is wrong without:
 *
 * 1. Every fail-closed answer from main — flag off, wrong platform, share not
 *    accepted — reaches the recipient as NO affordance, not as an error. Those
 *    are all the same rejection on the wire, and none of them is something the
 *    recipient can act on.
 * 2. The consent modal names what running actually is. The published command
 *    list is context for that decision, never a boundary around it, so the
 *    copy may not imply the commands are all that runs or that anything is
 *    sandboxed.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SharedContainerRepositorySummary,
  SharedContainerRunStatus,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { outermostReplayBlock } from '@/test-utils/replay';
import { SharedContainerRunPanel } from '../SharedContainerRunPanel';
import {
  useSharedContainerRun,
  type SharedContainerRunState,
} from '../useSharedContainerRun';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const runStatus = jest.fn();
const allowRun = jest.fn();
const revokeRun = jest.fn();
const saveRunEnvironment = jest.fn();
const refreshRunCopy = jest.fn();
const runScript = jest.fn();

function status(
  overrides: Partial<SharedContainerRunStatus> = {},
): SharedContainerRunStatus {
  return {
    allowed: false,
    run: {
      commands: [{ name: 'launch', command: 'npm run dev', repoId: 'repo-1' }],
      requiredEnv: ['DATABASE_URL', 'STRIPE_KEY'],
    },
    values: [],
    unsetRequiredEnv: ['DATABASE_URL', 'STRIPE_KEY'],
    runCopySizeBytes: '52428800',
    runCopyNeedsRefresh: false,
    hasRunningProcesses: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runScript,
      sharedContainers: {
        runStatus,
        allowRun,
        revokeRun,
        saveRunEnvironment,
        refreshRunCopy,
      },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function q(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

/** Mounts the hook and exposes its latest value for direct assertions. */
function Harness({
  containerId,
  revisionId,
  featureEnabled,
  onState,
}: {
  containerId: string | null;
  revisionId: string | null;
  featureEnabled: boolean;
  onState: (state: SharedContainerRunState) => void;
}): null {
  onState(useSharedContainerRun({ containerId, revisionId, featureEnabled }));
  return null;
}

async function mountHook(options: {
  containerId?: string | null;
  revisionId?: string | null;
  featureEnabled?: boolean;
}): Promise<() => SharedContainerRunState> {
  let latest: SharedContainerRunState | null = null;
  await act(async () => {
    root.render(
      <Harness
        containerId={options.containerId ?? 'container-1'}
        revisionId={options.revisionId ?? 'rev-1'}
        featureEnabled={options.featureEnabled ?? true}
        onState={(state): void => {
          latest = state;
        }}
      />,
    );
    await Promise.resolve();
  });
  return (): SharedContainerRunState => {
    if (latest === null) throw new Error('hook never rendered');
    return latest;
  };
}

describe('useSharedContainerRun', () => {
  it('does not expose a denied status from the previous container while the next loads', async () => {
    let resolveNext!: (value: SharedContainerRunStatus) => void;
    runStatus.mockImplementation(({ containerId }: { containerId: string }) =>
      containerId === 'container-1'
        ? Promise.resolve(status({ allowed: false }))
        : new Promise<SharedContainerRunStatus>((resolve) => {
            resolveNext = resolve;
          }),
    );
    let latest: SharedContainerRunState | null = null;
    const onState = (state: SharedContainerRunState): void => {
      latest = state;
    };
    const read = (): SharedContainerRunState => {
      if (latest === null) throw new Error('hook never rendered');
      return latest;
    };

    await act(async () => {
      root.render(
        <Harness
          containerId="container-1"
          revisionId="rev-1"
          featureEnabled
          onState={onState}
        />,
      );
      await Promise.resolve();
    });
    expect(read().availability).toBe('available');

    act(() => {
      root.render(
        <Harness
          containerId="container-2"
          revisionId="rev-2"
          featureEnabled
          onState={onState}
        />,
      );
    });

    expect(read().availability).toBe('loading');
    expect(read().status).toBeNull();

    await act(async () => {
      resolveNext(status({ allowed: true }));
      await Promise.resolve();
    });
    expect(read().availability).toBe('available');
    expect(read().status?.allowed).toBe(true);
  });

  it('reports the published run config once main resolves it', async () => {
    runStatus.mockResolvedValue(status());

    const read = await mountHook({});

    expect(runStatus).toHaveBeenCalledWith({
      containerId: 'container-1',
      revisionId: 'rev-1',
    });
    expect(read().availability).toBe('available');
    expect(read().status?.unsetRequiredEnv).toEqual([
      'DATABASE_URL',
      'STRIPE_KEY',
    ]);
  });

  // Flag off, non-macOS, and not-accepted are one rejection on the wire.
  // None is actionable, so all three must read as "no affordance" rather than
  // as an error the recipient is asked to fix.
  it('treats a fail-closed rejection as no affordance, not an error', async () => {
    runStatus.mockRejectedValue(new Error('Shared-container run is disabled.'));

    const read = await mountHook({});

    expect(read().availability).toBe('unsupported');
    expect(read().error).toBeNull();
  });

  it('never asks main for status before the feature gate passes', async () => {
    const read = await mountHook({ featureEnabled: false });

    expect(runStatus).not.toHaveBeenCalled();
    expect(read().availability).toBe('unsupported');
  });

  it('distinguishes a share that simply published no run config', async () => {
    runStatus.mockResolvedValue(status({ run: undefined }));

    const read = await mountHook({});

    expect(read().availability).toBe('unpublished');
  });

  it('seeds an empty value for every unset name and re-reads status', async () => {
    runStatus.mockResolvedValue(status());
    saveRunEnvironment.mockResolvedValue([]);

    const read = await mountHook({});
    await act(async () => {
      await read().addPlaceholders();
    });

    // Empty values are preserved by the environment normalizer, so a seeded
    // name round-trips and stays visibly unset rather than disappearing.
    expect(saveRunEnvironment).toHaveBeenCalledWith({
      containerId: 'container-1',
      values: [
        { key: 'DATABASE_URL', value: '' },
        { key: 'STRIPE_KEY', value: '' },
      ],
    });
    expect(runStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps values the recipient already set when seeding placeholders', async () => {
    runStatus.mockResolvedValue(
      status({
        values: [{ key: 'DATABASE_URL', value: 'postgres://local' }],
        unsetRequiredEnv: ['STRIPE_KEY'],
      }),
    );
    saveRunEnvironment.mockResolvedValue([]);

    const read = await mountHook({});
    await act(async () => {
      await read().addPlaceholders();
    });

    expect(saveRunEnvironment).toHaveBeenCalledWith({
      containerId: 'container-1',
      values: [
        { key: 'DATABASE_URL', value: 'postgres://local' },
        { key: 'STRIPE_KEY', value: '' },
      ],
    });
  });

  it('addresses only the open container when running a published command', async () => {
    runStatus.mockResolvedValue(status({ allowed: true }));
    runScript.mockResolvedValue({
      success: true,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 1,
    });

    const read = await mountHook({});
    await act(async () => {
      await read().runCommand('launch');
    });

    // No projectId/worktreeId on the wire: main derives the viewer sentinel
    // itself, so a renderer cannot address another workspace through this arm.
    expect(runScript).toHaveBeenCalledWith({
      target: 'shared-container',
      scriptName: 'launch',
      containerId: 'container-1',
    });
    expect(read().lastRun).toMatchObject({
      scriptName: 'launch',
      response: { success: true, exitCode: 0 },
    });
  });

  it('reports a refused run instead of reading it as started', async () => {
    // Main rejects an unpublished command name rather than resolving a no-op
    // success, so the recipient sees the refusal.
    runStatus.mockResolvedValue(status({ allowed: true }));
    runScript.mockRejectedValue(
      new Error('This share did not publish that command.'),
    );

    const read = await mountHook({});
    let outcome = true;
    await act(async () => {
      outcome = await read().runCommand('launch');
    });

    expect(outcome).toBe(false);
    expect(read().error).toBe('Could not start this command.');
  });

  it('allows revocation while an interactive command is still running', async () => {
    runStatus.mockResolvedValue(status({ allowed: true }));
    let finishRun!: (value: {
      success: boolean;
      exitCode: number;
      output: string;
      timedOut: boolean;
      durationMs: number;
    }) => void;
    runScript.mockReturnValue(
      new Promise((resolve) => {
        finishRun = resolve;
      }),
    );
    revokeRun.mockResolvedValue(undefined);

    const read = await mountHook({});
    let running!: Promise<boolean>;
    act(() => {
      running = read().runCommand('launch');
    });
    await act(async () => {
      await Promise.resolve();
    });

    let revoked = false;
    await act(async () => {
      revoked = await read().revokeRun();
    });
    expect(revoked).toBe(true);
    expect(revokeRun).toHaveBeenCalledWith({ containerId: 'container-1' });

    finishRun({
      success: true,
      exitCode: 0,
      output: 'stopped',
      timedOut: false,
      durationMs: 1,
    });
    await act(async () => {
      await running;
    });
  });

  it('reports a refused refresh instead of silently doing nothing', async () => {
    runStatus.mockResolvedValue(status({ allowed: true }));
    refreshRunCopy.mockRejectedValue(
      new Error('Stop shared-container processes before refreshing.'),
    );

    const read = await mountHook({});
    let outcome = true;
    await act(async () => {
      outcome = await read().refreshRunCopy();
    });

    expect(outcome).toBe(false);
    expect(read().error).toContain('Stop anything still running');
  });
});

describe('SharedContainerRunPanel', () => {
  function PanelHarness({
    onState,
    publisherUserId,
    repositories,
    onClose,
  }: {
    onState: (state: SharedContainerRunState) => void;
    publisherUserId: string;
    repositories?: SharedContainerRepositorySummary[];
    onClose: () => void;
  }): JSX.Element {
    const state = useSharedContainerRun({
      containerId: 'container-1',
      revisionId: 'rev-1',
      featureEnabled: true,
    });
    onState(state);
    return (
      <SharedContainerRunPanel
        run={state}
        publisherName="Dana"
        publisherUserId={publisherUserId}
        {...(repositories ? { repositories } : {})}
        onClose={onClose}
      />
    );
  }

  const onClose = jest.fn();

  async function mountPanel(
    overrides: Partial<SharedContainerRunStatus> = {},
    publisherUserId = 'user-1',
    repositories?: SharedContainerRepositorySummary[],
  ): Promise<() => SharedContainerRunState> {
    onClose.mockClear();
    runStatus.mockResolvedValue(status(overrides));
    let latest: SharedContainerRunState | null = null;
    await act(async () => {
      root.render(
        <PanelHarness
          publisherUserId={publisherUserId}
          {...(repositories ? { repositories } : {})}
          onClose={onClose}
          onState={(state): void => {
            latest = state;
          }}
        />,
      );
      await Promise.resolve();
    });
    const read = (): SharedContainerRunState => {
      if (latest === null) throw new Error('hook never rendered');
      return latest;
    };
    return read;
  }

  it('shows a command by name, and its shell string verbatim on demand', async () => {
    await mountPanel();

    // The name is what a recipient picks between, so it is the only thing on
    // the row. The shell string is reference material, one click away in both
    // consent states rather than competing with the decision.
    const row = q('shared-container-run-command-launch');
    expect(row?.textContent).toContain('Launch');
    expect(row?.textContent).not.toContain('npm run dev');
    expect(q('shared-container-run-command-details-body-launch')).toBeNull();

    await act(async () => {
      q('shared-container-run-command-details-launch')?.click();
      await Promise.resolve();
    });

    // Verbatim once revealed: a recipient deciding whether to allow this share
    // must see the exact string, never a prettified or truncated one.
    expect(
      q('shared-container-run-command-details-body-launch')?.textContent,
    ).toContain('npm run dev');
  });

  it('names the folder a command runs in instead of its repo id', async () => {
    await mountPanel();

    await act(async () => {
      q('shared-container-run-command-details-launch')?.click();
      await Promise.resolve();
    });

    // `repo-1` is a wire id. Unresolved it is shown as-is, but the workspace
    // root sentinel is never copy.
    expect(
      q('shared-container-run-command-details-body-launch')?.textContent,
    ).toContain('Runs in repo-1');
    expect(
      q('shared-container-run-command-details-body-launch')?.textContent,
    ).not.toContain('__workspace_root__');
  });

  it('resolves a command location to a repo name or the project root', async () => {
    await mountPanel(
      {
        run: {
          commands: [
            { name: 'launch', command: 'npm run dev', repoId: 'repo-1' },
            {
              name: 'Launch-UD-Web',
              command: 'npm run dev:web',
              repoId: '__workspace_root__',
            },
          ],
          requiredEnv: [],
        },
      },
      'user-1',
      [{ repoId: 'repo-1', repoName: 'unstoppable-web' }],
    );

    // A publisher-side script name reads as a name, not an identifier.
    expect(
      q('shared-container-run-command-Launch-UD-Web')?.textContent,
    ).toContain('Launch UD Web');

    await act(async () => {
      q('shared-container-run-command-details-launch')?.click();
      q('shared-container-run-command-details-Launch-UD-Web')?.click();
      await Promise.resolve();
    });

    expect(
      q('shared-container-run-command-details-body-launch')?.textContent,
    ).toContain('Runs in unstoppable-web');
    expect(
      q('shared-container-run-command-details-body-Launch-UD-Web')?.textContent,
    ).toContain('Runs in Project root');
  });

  it('lists the unset names verbatim once running is allowed', async () => {
    await mountPanel({ allowed: true });

    expect(q('shared-container-run-env-unset')?.textContent).toContain(
      'DATABASE_URL, STRIPE_KEY',
    );
  });

  it('offers no way to start a command before consent is granted', async () => {
    await mountPanel();

    expect(q('shared-container-run-command-start-launch')).toBeNull();
    expect(q('shared-container-run-allow')).not.toBeNull();
  });

  it('keeps the pre-consent screen to the decision itself', async () => {
    await mountPanel();

    // Environment editing, the run-copy note, the update control, and the
    // withheld-file disclosure are all post-consent controls. Rendering them
    // disabled ahead of the decision reads as a broken feature and buries the
    // one choice this screen exists to present.
    expect(q('shared-container-run-environment')).toBeNull();
    expect(q('shared-container-run-copy-note')).toBeNull();
    expect(q('shared-container-run-refresh')).toBeNull();
    expect(q('shared-container-run-update-available')).toBeNull();
    expect(q('shared-container-run-withheld')).toBeNull();
  });

  it('keeps consent disabled until the publisher identity is available', async () => {
    await mountPanel({}, '');

    expect(
      (q('shared-container-run-allow') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('names running as executing someone else code, unsandboxed', async () => {
    await mountPanel();

    await act(async () => {
      q('shared-container-run-allow')?.click();
      await Promise.resolve();
    });

    const modal = q('shared-container-run-allow-modal');
    const copy = modal?.textContent ?? '';
    // The modal is the security boundary's only explanation. It must say whose
    // code runs, that it runs here as this user, and that the listed commands
    // are not the limit -- a `postinstall` the recipient never sees runs too.
    expect(copy).toContain('Dana');
    expect(copy).toContain('this device');
    expect(copy).toContain('does not sandbox');
    expect(copy).toContain('not a limit');
  });

  it('records the publisher identity alongside the grant', async () => {
    allowRun.mockResolvedValue(undefined);
    await mountPanel();

    await act(async () => {
      q('shared-container-run-allow')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      q('shared-container-run-allow-confirm')?.click();
      await Promise.resolve();
    });

    expect(allowRun).toHaveBeenCalledWith({
      containerId: 'container-1',
      publisherUserId: 'user-1',
    });
  });

  it('warns that an update overwrites shared files but spares your own', async () => {
    await mountPanel({ allowed: true, runCopyNeedsRefresh: true });

    const copy = q('shared-container-run-refresh')?.parentElement?.textContent;
    expect(copy).toContain('even ones you changed');
    expect(copy).toContain('Files you added stay');
  });

  it('keeps the post-consent sheet to the next action', async () => {
    await mountPanel({ allowed: true });

    // Running opens a terminal pane with the live output, so mirroring it here
    // duplicated what the recipient is already looking at. The run-copy note,
    // withheld-file disclosure, and terminal hint went with it.
    expect(q('shared-container-run-output')).toBeNull();
    expect(q('shared-container-run-copy-note')).toBeNull();
    expect(q('shared-container-run-withheld')).toBeNull();
    expect(q('shared-container-run-panel')?.textContent).toContain(
      'Pick a command below and hit Run',
    );
  });

  it('flags a grant recorded against a different publisher account', async () => {
    await mountPanel({ allowed: true, publisherUserId: 'user-2' });

    // The one provenance fact still worth interrupting for: consent is on
    // record for an account other than the one this share now shows.
    expect(q('shared-container-run-panel')?.textContent).toContain(
      'publisher account user-2',
    );
  });

  /** The texts of the replay blocks inside `scope`. */
  function blockedTexts(scope: Element | null): string[] {
    if (scope === null) throw new Error('Missing scope');
    return Array.from(
      scope.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
      (block) => block.textContent ?? '',
    );
  }

  it("blocks the publisher's name from session replay, not the copy or controls", async () => {
    await mountPanel({
      run: {
        commands: [],
        requiredEnv: ['DATABASE_URL'],
      },
    });

    const panel = q('shared-container-run-panel');
    expect(outermostReplayBlock(panel)).toBeNull();
    const intro = panel?.querySelector('p');
    expect(intro?.textContent).toContain("Runs Dana's code on this device");
    expect(outermostReplayBlock(intro)).toBeNull();
    expect(blockedTexts(intro ?? null)).toEqual(['Dana']);
    const commands = q('shared-container-run-commands');
    expect(commands?.textContent).toContain(
      'Dana did not publish any commands.',
    );
    expect(blockedTexts(commands)).toEqual(['Dana']);
    expect(outermostReplayBlock(q('shared-container-run-allow'))).toBeNull();

    await act(async () => {
      q('shared-container-run-allow')?.click();
      await Promise.resolve();
    });
    const modal = q('shared-container-run-allow-modal');
    expect(modal?.textContent).toContain(
      "This runs Dana's code on this device",
    );
    expect(outermostReplayBlock(modal)).toBeNull();
    expect(blockedTexts(modal)).toEqual(['Dana']);
    expect(
      outermostReplayBlock(q('shared-container-run-allow-confirm')),
    ).toBeNull();
  });

  it('blocks the publisher name and the other account id in a mismatch warning', async () => {
    await mountPanel({
      allowed: true,
      publisherUserId: 'user-2',
      run: { commands: [], requiredEnv: ['DATABASE_URL'] },
    });

    const intro = q('shared-container-run-panel')?.querySelector('p');
    expect(intro?.textContent).toBe(
      'You allowed publisher account user-2 to run code here, not Dana. Turn running off if that is wrong.',
    );
    expect(outermostReplayBlock(intro)).toBeNull();
    expect(blockedTexts(intro ?? null)).toEqual(['user-2', 'Dana']);
    const environment = q('shared-container-run-environment');
    expect(environment?.textContent).toContain('Names Dana listed');
    expect(blockedTexts(environment)).toEqual(['Dana']);
  });

  it('dismisses the sheet without waiting for the command to finish', async () => {
    // `runScript` resolves on COMPLETION, so a sheet that waited for it would
    // cover the terminal for the entire run. This mock never settles, standing
    // in for a long-running `setup`.
    runScript.mockReturnValue(new Promise(() => {}));
    await mountPanel({ allowed: true });

    await act(async () => {
      q('shared-container-run-command-start-launch')?.click();
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('labels a newer sealed revision and blocks commands until the copy is updated', async () => {
    await mountPanel({ allowed: true, runCopyNeedsRefresh: true });

    expect(q('shared-container-run-update-available')?.textContent).toContain(
      'New version available',
    );
    expect(
      (q('shared-container-run-command-start-launch') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('requires an explicit stop before updating a copy with live processes', async () => {
    refreshRunCopy.mockResolvedValue(undefined);
    await mountPanel({ allowed: true, hasRunningProcesses: true });

    await act(async () => {
      q('shared-container-run-refresh')?.click();
      await Promise.resolve();
    });
    expect(refreshRunCopy).not.toHaveBeenCalled();
    expect(q('shared-container-run-refresh-modal')).not.toBeNull();

    await act(async () => {
      q('shared-container-run-refresh-confirm')?.click();
      await Promise.resolve();
    });
    expect(refreshRunCopy).toHaveBeenCalledWith({
      containerId: 'container-1',
      revisionId: 'rev-1',
      stopRunning: true,
    });
  });

  it('keeps the revoke control enabled while a command is running', async () => {
    let finishRun!: (value: {
      success: boolean;
      exitCode: number;
      output: string;
      timedOut: boolean;
      durationMs: number;
    }) => void;
    runScript.mockReturnValue(
      new Promise((resolve) => {
        finishRun = resolve;
      }),
    );
    await mountPanel({ allowed: true });

    act(() => {
      q('shared-container-run-command-start-launch')?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      (q('shared-container-run-revoke') as HTMLButtonElement).disabled,
    ).toBe(false);

    finishRun({
      success: true,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 1,
    });
    await act(async () => {
      await Promise.resolve();
    });
  });
});
