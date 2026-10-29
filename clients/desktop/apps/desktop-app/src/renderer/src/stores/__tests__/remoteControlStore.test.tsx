/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  getRemoteControlApi,
  readRemoteControlContext,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import { useRemoteControlSubscription } from '@/hooks/useRemoteControlSubscription';
import {
  createFakeRemoteControl,
  flushPromises,
  installRemoteControlApi,
  makeRemoteState,
  resetRemoteControlStore,
} from '@/components/remote-access/__tests__/fakeRemoteControlApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Subscriber(): JSX.Element {
  useRemoteControlSubscription();
  return <div />;
}

describe('remoteControlStore', () => {
  afterEach(() => {
    installRemoteControlApi(null);
    resetRemoteControlStore();
  });

  it('treats a window without the bridge as a local window with nothing available', async () => {
    installRemoteControlApi(null);
    expect(getRemoteControlApi()).toBeNull();
    expect(readRemoteControlContext()).toEqual({ mode: 'local' });
    await useRemoteControlStore.getState().hydrate();
    expect(useRemoteControlStore.getState().state.available).toBe(false);
    await expect(
      useRemoteControlStore.getState().setAllowIncoming(true),
    ).rejects.toThrow('Remote access is not available in this window.');
  });

  it('hydrates the context and state from main', async () => {
    const fake = createFakeRemoteControl(
      { mode: 'remote', deviceId: 'dev-b', name: 'Studio', platform: 'linux' },
      makeRemoteState({ allowIncoming: true }),
    );
    installRemoteControlApi(fake);
    await useRemoteControlStore.getState().hydrate();
    const store = useRemoteControlStore.getState();
    expect(store.hydrated).toBe(true);
    expect(store.context).toEqual({
      mode: 'remote',
      deviceId: 'dev-b',
      name: 'Studio',
      platform: 'linux',
    });
    expect(store.state.allowIncoming).toBe(true);
    expect(fake.mocks.getState).toHaveBeenCalledWith(undefined);
  });

  it('applies the state each action returns', async () => {
    const fake = createFakeRemoteControl();
    installRemoteControlApi(fake);
    await useRemoteControlStore.getState().setAllowIncoming(true);
    expect(fake.mocks.setAllowIncoming).toHaveBeenCalledWith(true);
    expect(useRemoteControlStore.getState().state.allowIncoming).toBe(true);

    fake.current = makeRemoteState({
      discoverable: [{ deviceId: 'dev-c', name: 'Desk', platform: 'win32' }],
    });
    await useRemoteControlStore.getState().discover();
    expect(fake.mocks.getState).toHaveBeenLastCalledWith({ discover: true });
    expect(useRemoteControlStore.getState().state.discoverable).toHaveLength(1);

    await useRemoteControlStore
      .getState()
      .forgetDevice({ deviceId: 'dev-c', role: 'host' });
    expect(fake.mocks.forgetDevice).toHaveBeenCalledWith({
      deviceId: 'dev-c',
      role: 'host',
    });
  });

  it('opens and closes the Add a computer dialog', () => {
    useRemoteControlStore.getState().openPairDialog();
    expect(useRemoteControlStore.getState().pairDialogOpen).toBe(true);
    useRemoteControlStore.getState().closePairDialog();
    expect(useRemoteControlStore.getState().pairDialogOpen).toBe(false);
  });
});

describe('useRemoteControlSubscription', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    installRemoteControlApi(null);
    resetRemoteControlStore();
  });

  it('fetches once, mirrors pushes, and detaches on unmount', async () => {
    const fake = createFakeRemoteControl(
      { mode: 'local' },
      makeRemoteState({ allowIncoming: false }),
    );
    installRemoteControlApi(fake);

    await act(async () => {
      root.render(<Subscriber />);
      await flushPromises();
    });
    expect(fake.mocks.getState).toHaveBeenCalledTimes(1);
    expect(useRemoteControlStore.getState().hydrated).toBe(true);
    expect(fake.stateListenerCount()).toBe(1);

    act(() => {
      fake.emitState(makeRemoteState({ allowIncoming: true }));
    });
    expect(useRemoteControlStore.getState().state.allowIncoming).toBe(true);

    act(() => root.unmount());
    expect(fake.stateListenerCount()).toBe(0);
    root = createRoot(container);
  });

  it('does nothing without the bridge', async () => {
    installRemoteControlApi(null);
    await act(async () => {
      root.render(<Subscriber />);
      await flushPromises();
    });
    expect(useRemoteControlStore.getState().hydrated).toBe(false);
  });
});
