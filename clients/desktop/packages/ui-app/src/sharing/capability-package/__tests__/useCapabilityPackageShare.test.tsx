/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import {
  CapabilityPackageAnalysisError,
  useCapabilityPackageShare,
  type CapabilityPackageSharePort,
  type CapabilityPackageShareState,
} from '../useCapabilityPackageShare';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function resource(
  id: string,
  visibility: PipelinePackageResource['sourceVisibility'],
): PipelinePackageResource {
  return {
    id,
    kind: 'standalone_skill',
    displayName: id,
    sourceLabel: 'local',
    sourceVisibility: visibility,
    invocationKeys: [`/${id}`],
    dependencyResourceIds: [],
    trees: [],
  };
}

function summary(
  analysisId: string,
  resources: PipelinePackageResource[],
  boundIds: string[] = [],
): PipelinePackageAnalysisSummary {
  return {
    analysisId,
    state: 'ready',
    pipelineContentHash: 'a'.repeat(64),
    blockers: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources,
      bindings: [{ jobId: 'job', stepId: 'step', resourceIds: boundIds }],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useCapabilityPackageShare', () => {
  let container: HTMLElement;
  let root: Root;
  let latest: CapabilityPackageShareState | null = null;

  function Harness({
    port,
    enabled,
  }: {
    port: CapabilityPackageSharePort | null;
    enabled: boolean;
  }): JSX.Element {
    latest = useCapabilityPackageShare({ port, enabled });
    return <span />;
  }

  function render(
    port: CapabilityPackageSharePort | null,
    enabled = true,
  ): void {
    act(() => {
      root.render(<Harness port={port} enabled={enabled} />);
    });
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('stays idle without a port', () => {
    render(null);
    expect(latest?.active).toBe(false);
    expect(latest?.blocked).toBe(false);
    expect(latest?.ready).toBe(true);
    expect(latest?.selection()).toBeNull();
  });

  it('cancels an analysis that finishes after unmount', async () => {
    const pending = deferred<PipelinePackageAnalysisSummary>();
    const cancel = jest.fn().mockResolvedValue(undefined);
    render({ analyze: () => pending.promise, cancel });
    act(() => root.unmount());
    root = createRoot(container);
    pending.resolve(summary('late', []));
    await settle();
    expect(cancel).toHaveBeenCalledWith('late');
  });

  it('cancels the previous analysis when the port changes', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const first: CapabilityPackageSharePort = {
      analyze: jest.fn().mockResolvedValue(summary('first', [])),
      cancel,
    };
    render(first);
    await settle();
    render({
      analyze: jest.fn().mockResolvedValue(summary('second', [])),
      cancel,
    });
    await settle();
    expect(cancel).toHaveBeenCalledWith('first');
    expect(latest?.analysis?.analysisId).toBe('second');
  });

  it('analyzes once when a loading port becomes available', async () => {
    const analyze = jest.fn().mockResolvedValue(summary('ready', []));
    const port: CapabilityPackageSharePort = { analyze };
    render(null);

    render(port);
    await settle();

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(latest?.analysis?.analysisId).toBe('ready');
  });

  it('prunes optional ids the new analysis no longer contains', async () => {
    const analyze = jest
      .fn()
      .mockResolvedValueOnce(
        summary('one', [resource('a', 'public'), resource('b', 'public')]),
      )
      .mockResolvedValueOnce(summary('two', [resource('a', 'public')]));
    render({ analyze });
    await settle();
    act(() => latest?.toggleOptionalResource('a'));
    act(() => latest?.toggleOptionalResource('b'));
    expect(latest?.selectedOptionalResourceIds).toEqual(['a', 'b']);
    act(() => latest?.retry());
    await settle();
    expect(latest?.selectedOptionalResourceIds).toEqual(['a']);
  });

  it('is ready with local or private bytes and no acknowledgment', async () => {
    render({
      analyze: jest
        .fn()
        .mockResolvedValue(
          summary(
            'one',
            [resource('pub', 'public'), resource('loc', 'local')],
            ['pub'],
          ),
        ),
    });
    await settle();
    expect(latest?.ready).toBe(true);
    act(() => latest?.toggleOptionalResource('loc'));
    // Pressing Share is the publication decision: including a local file
    // asks for nothing more.
    expect(latest?.ready).toBe(true);
    expect(latest).not.toHaveProperty('consentRequired');
    expect(latest).not.toHaveProperty('setConsented');
    expect(latest?.selection()?.selectedOptionalResourceIds).toEqual(['loc']);
  });

  it('blocks while analyzing and after a failure, and retries', async () => {
    const analyze = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(summary('ok', []));
    render({ analyze });
    expect(latest?.analyzing).toBe(true);
    expect(latest?.blocked).toBe(true);
    await settle();
    expect(latest?.failed).toBe(true);
    expect(latest?.blocked).toBe(true);
    expect(latest?.relevant).toBe(true);
    act(() => latest?.retry());
    await settle();
    expect(latest?.failed).toBe(false);
    expect(latest?.blocked).toBe(false);
    expect(latest?.relevant).toBe(true);
  });

  it('exposes the reason a host gave for a failed analysis until it succeeds', async () => {
    const analyze = jest
      .fn()
      .mockRejectedValueOnce(
        new CapabilityPackageAnalysisError(
          'Model lookup failed for step build.',
        ),
      )
      .mockRejectedValueOnce(new Error('internal detail'))
      .mockResolvedValueOnce(summary('ok', []));
    render({ analyze });
    expect(latest?.failureReason).toBeNull();
    await settle();
    expect(latest?.failed).toBe(true);
    expect(latest?.failureReason).toBe('Model lookup failed for step build.');

    // A rejection the host did not mark as user-facing shows no reason.
    act(() => latest?.retry());
    await settle();
    expect(latest?.failed).toBe(true);
    expect(latest?.failureReason).toBeNull();

    act(() => latest?.retry());
    await settle();
    expect(latest?.failed).toBe(false);
    expect(latest?.failureReason).toBeNull();
  });

  it('does not re-analyze for a no-op dismissal or restore', async () => {
    // Main echoes what it actually suppressed.
    const analyze = jest.fn(
      (request: {
        dismissedInvocations?: readonly { provider: 'claude'; token: string }[];
      }): Promise<PipelinePackageAnalysisSummary> =>
        Promise.resolve({
          ...summary('one', []),
          dismissedInvocations: [
            ...(request.dismissedInvocations ?? [
              { provider: 'claude', token: '/x' },
            ]),
          ],
        }),
    );
    render({ analyze });
    await settle();
    expect(analyze).toHaveBeenCalledTimes(1);
    act(() => latest?.dismissInvocation({ provider: 'claude', token: '/x' }));
    act(() => latest?.restoreInvocation({ provider: 'claude', token: '/y' }));
    await settle();
    expect(analyze).toHaveBeenCalledTimes(1);

    act(() => latest?.dismissInvocation({ provider: 'claude', token: '/z' }));
    await settle();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze).toHaveBeenLastCalledWith({
      dismissedInvocations: [
        { provider: 'claude', token: '/x' },
        { provider: 'claude', token: '/z' },
      ],
    });
  });

  it('forwards progress events', async () => {
    let emit: (event: { stage: 'Preparing package…' }) => void = () => {};
    render({
      analyze: jest.fn().mockResolvedValue(summary('one', [])),
      subscribeProgress: (listener) => {
        emit = listener;
        return (): void => {};
      },
    });
    await settle();
    act(() => emit({ stage: 'Preparing package…' }));
    expect(latest?.progress?.stage).toBe('Preparing package…');
    act(() => latest?.resetProgress());
    expect(latest?.progress).toBeNull();
  });
});
