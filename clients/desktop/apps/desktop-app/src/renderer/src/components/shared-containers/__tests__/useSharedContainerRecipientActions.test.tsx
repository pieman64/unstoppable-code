/**
 * @jest-environment jsdom
 *
 * Removal feedback (CAN-4052): a server that keeps removed shares earns the
 * restore promise and its Restore action; one that does not stays silent.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useGitHubStore } from '@/stores/githubStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import {
  SHARED_CONTAINER_REMOVE_FAILED,
  useSharedContainerRecipientActions,
  type SharedContainerRecipientActions,
} from '../useSharedContainerRecipientActions';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let actions: SharedContainerRecipientActions;
const addToast = jest.fn();
const dismissContainer = jest.fn();
const restoreContainer = jest.fn();

function Probe({ title }: { title?: string }): null {
  actions = useSharedContainerRecipientActions('c1', 'org-1', title);
  return null;
}

function mount(title?: string): void {
  act(() => {
    root.render(<Probe {...(title !== undefined ? { title } : {})} />);
  });
}

async function dismiss(): Promise<string> {
  let outcome = '';
  await act(async () => {
    outcome = await actions.dismiss();
  });
  return outcome;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  addToast.mockReset();
  dismissContainer.mockReset().mockResolvedValue(true);
  restoreContainer.mockReset().mockResolvedValue('restored');
  useSharedContainerReplicasStore.getState().reset();
  useSharedContainerReplicasStore.setState({
    dismissContainer,
    restoreContainer,
    removedStatus: 'success',
  });
  useGitHubStore.setState({ addToast });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('says the share can be restored and offers Restore', async () => {
  mount('Checkout flow');

  await expect(dismiss()).resolves.toBe('dismissed');

  expect(dismissContainer).toHaveBeenCalledWith('c1', 'org-1');
  expect(addToast).toHaveBeenCalledTimes(1);
  const [message, type, , meta] = addToast.mock.calls[0] as [
    string,
    string,
    unknown,
    { action?: { label: string; onClick: () => void } },
  ];
  expect(message).toBe(
    'Removed Checkout flow. You can restore it from Past shares.',
  );
  expect(type).toBe('success');
  expect(meta.action?.label).toBe('Restore');

  addToast.mockClear();
  await act(async () => {
    meta.action?.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(restoreContainer).toHaveBeenCalledWith('c1');
  expect(addToast).toHaveBeenCalledWith(
    'Restored Checkout flow. Accept it under Shared with you to open it.',
    'success',
    undefined,
    expect.anything(),
  );
});

it('promises no restore against a server that cannot perform one', async () => {
  useSharedContainerReplicasStore.setState({ removedStatus: 'unsupported' });
  mount('Checkout flow');

  await expect(dismiss()).resolves.toBe('dismissed');

  expect(addToast).not.toHaveBeenCalled();
});

it('reports a failed removal', async () => {
  dismissContainer.mockResolvedValue(false);
  mount('Checkout flow');

  await expect(dismiss()).resolves.toBe('failed');

  expect(addToast).toHaveBeenCalledWith(
    SHARED_CONTAINER_REMOVE_FAILED,
    'error',
  );
  expect(SHARED_CONTAINER_REMOVE_FAILED).toBe(
    "Couldn't remove this share. Try again.",
  );
});

it('reports a share that is no longer restorable', async () => {
  restoreContainer.mockResolvedValue('not-restorable');
  mount('Checkout flow');
  await dismiss();
  const [, , , meta] = addToast.mock.calls[0] as [
    string,
    string,
    unknown,
    { action: { onClick: () => void } },
  ];
  addToast.mockClear();

  await act(async () => {
    meta.action.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(addToast).toHaveBeenCalledWith(
    "Couldn't restore Checkout flow. It's no longer shared with you.",
    'error',
    undefined,
    expect.anything(),
  );
});
