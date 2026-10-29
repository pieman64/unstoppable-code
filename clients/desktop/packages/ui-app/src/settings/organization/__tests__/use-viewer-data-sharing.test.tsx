/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ViewerDataSharingStatus } from '@canopy/protocol';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import type { SettingsUiHost } from '../../host';
import {
  useViewerDataSharing,
  type ViewerDataSharingLoadState,
} from '../use-viewer-data-sharing';

/** Answers `organization.dataSharing.viewer` with the organization id asked for. */
const mockFetchViewerDataSharing = jest.fn();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createHost(): SettingsUiHost {
  const client = createFakeSettingsClient({
    'organization.dataSharing.viewer': (input: unknown): unknown =>
      mockFetchViewerDataSharing(
        isRecord(input) ? input.organizationId : undefined,
      ),
  });
  return createTestSettingsHost({ client }).host;
}

let host: SettingsUiHost;

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function status(viewerUserId: string): ViewerDataSharingStatus {
  return {
    viewerUserId,
    scopes: {
      metadata: 'private',
      plans: 'unknown',
      summaries: 'unknown',
      transcripts: 'unknown',
    },
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let seen: ViewerDataSharingLoadState[] = [];

function Probe({
  orgId,
  viewerIdentity,
}: {
  orgId: string | null;
  viewerIdentity?: string;
}): JSX.Element {
  const state = useViewerDataSharing(orgId, viewerIdentity);
  seen.push(state);
  return <span />;
}

function Hosted(props: {
  orgId: string | null;
  viewerIdentity?: string;
}): JSX.Element {
  return (
    <TestSettingsHost host={host}>
      <Probe {...props} />
    </TestSettingsHost>
  );
}

function latest(): ViewerDataSharingLoadState {
  const last = seen[seen.length - 1];
  if (!last) throw new Error('Probe has not rendered');
  return last;
}

let root: Root;

/** Render inside the test host and let the hook's load settle. */
async function renderHosted(element: JSX.Element): Promise<void> {
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
}

describe('useViewerDataSharing', () => {
  let container: HTMLElement;

  beforeEach(() => {
    seen = [];
    mockFetchViewerDataSharing.mockReset();
    host = createHost();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('stays idle and fetches nothing without an organization', async () => {
    await renderHosted(<Hosted orgId={null} />);
    expect(latest()).toEqual({ state: 'idle' });
    expect(mockFetchViewerDataSharing).not.toHaveBeenCalled();
  });

  it('loads once and exposes the status', async () => {
    mockFetchViewerDataSharing.mockResolvedValue(status('viewer-a'));
    await renderHosted(<Hosted orgId={ORG_A} />);
    expect(seen[0]).toEqual({ state: 'loading' });
    expect(latest()).toEqual({ state: 'ready', status: status('viewer-a') });

    // Re-rendering the same identity neither refetches nor polls.
    await renderHosted(<Hosted orgId={ORG_A} />);
    expect(mockFetchViewerDataSharing).toHaveBeenCalledTimes(1);
  });

  it('reports errors without exposing a status', async () => {
    mockFetchViewerDataSharing.mockRejectedValue(new Error('boom'));
    await renderHosted(<Hosted orgId={ORG_A} />);
    expect(latest()).toEqual({ state: 'error' });
  });

  it('drops a response for an organization the host already left', async () => {
    const first = deferred<ViewerDataSharingStatus>();
    const second = deferred<ViewerDataSharingStatus>();
    mockFetchViewerDataSharing
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await renderHosted(<Hosted orgId={ORG_A} />);
    await renderHosted(<Hosted orgId={ORG_B} />);
    expect(latest()).toEqual({ state: 'loading' });

    // The obsolete organization answers late; it must not surface.
    await act(async () => {
      first.resolve(status('viewer-from-a'));
      await first.promise;
    });
    expect(latest()).toEqual({ state: 'loading' });

    await act(async () => {
      second.resolve(status('viewer-from-b'));
      await second.promise;
    });
    expect(latest()).toEqual({
      state: 'ready',
      status: status('viewer-from-b'),
    });
  });

  it('invalidates evidence and refetches when the account changes in the same organization', async () => {
    const pending = deferred<ViewerDataSharingStatus>();
    mockFetchViewerDataSharing
      .mockResolvedValueOnce(status('viewer-a'))
      .mockReturnValueOnce(pending.promise);
    await renderHosted(<Hosted orgId={ORG_A} viewerIdentity="account-a" />);
    seen = [];
    await renderHosted(<Hosted orgId={ORG_A} viewerIdentity="account-b" />);
    expect(seen.every((state) => state.state === 'loading')).toBe(true);
    expect(mockFetchViewerDataSharing).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve(status('viewer-b'));
      await pending.promise;
    });
    expect(latest()).toEqual({ state: 'ready', status: status('viewer-b') });
  });

  it('does not revive old evidence when returning to an earlier organization', async () => {
    const pending = deferred<ViewerDataSharingStatus>();
    mockFetchViewerDataSharing
      .mockResolvedValueOnce(status('viewer-a'))
      .mockReturnValueOnce(deferred<ViewerDataSharingStatus>().promise)
      .mockReturnValueOnce(pending.promise);
    await renderHosted(<Hosted orgId={ORG_A} />);
    await renderHosted(<Hosted orgId={ORG_B} />);
    seen = [];
    await renderHosted(<Hosted orgId={ORG_A} />);
    expect(seen.every((state) => state.state === 'loading')).toBe(true);
  });

  it('clears the previous status as soon as the organization changes', async () => {
    const second = deferred<ViewerDataSharingStatus>();
    mockFetchViewerDataSharing
      .mockResolvedValueOnce(status('viewer-from-a'))
      .mockReturnValueOnce(second.promise);

    await renderHosted(<Hosted orgId={ORG_A} />);
    expect(latest().state).toBe('ready');

    seen = [];
    await renderHosted(<Hosted orgId={ORG_B} />);
    // No render for B ever carries A's status.
    expect(seen.every((state) => state.state === 'loading')).toBe(true);
    expect(mockFetchViewerDataSharing).toHaveBeenLastCalledWith(ORG_B);
  });
});
