/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useSharedContainerForkRevision,
  type SharedContainerForkRevision,
} from '../useSharedContainerForkRevision';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const readable = (id: string): Record<string, unknown> => ({
  containerId: id,
  status: 'available',
  revisionId: `${id}-revision`,
  revisionCreatedAt: '2026-10-23T12:00:00.000Z',
});

let root: Root;
let host: HTMLDivElement;
let reads: jest.Mock;
let history: SharedContainerForkRevision[];
let broadcast: (event: unknown) => void;

function Host({ id, enabled }: { id: string; enabled: boolean }): JSX.Element {
  const revision = useSharedContainerForkRevision(id, enabled);
  history.push(revision);
  return <div>{JSON.stringify(revision)}</div>;
}
async function render(id: string, enabled = true): Promise<void> {
  await act(async () => {
    root.render(<Host id={id} enabled={enabled} />);
    await Promise.resolve();
  });
}
beforeEach(() => {
  host = document.createElement('div');
  root = createRoot(host);
  history = [];
  reads = jest.fn((input: { containerId: string }) =>
    Promise.resolve(readable(input.containerId)),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      sharedContainers: {
        getReplicaState: reads,
        onReplicaChanged: jest.fn((callback: (event: unknown) => void) => {
          broadcast = callback;
          return jest.fn();
        }),
      },
    },
  });
});
afterEach(() => act(() => root.unmount()));

it('never exposes the previous dialog selection on reopening', async () => {
  await render('first');
  await render('first', false);
  history = [];
  await render('first');
  expect(history[0]).toEqual({ status: 'loading' });
});

it('never exposes another container selection on switching', async () => {
  await render('first');
  history = [];
  await render('second');
  expect(history[0]).toEqual({ status: 'loading' });
  expect(history.at(-1)).toMatchObject({ revisionId: 'second-revision' });
});

it('ignores a read superseded by a broadcast', async () => {
  let finish: (value: unknown) => void = () => {};
  reads.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render('first');
  act(() => broadcast(readable('first')));
  await act(async () => {
    finish(null);
    await Promise.resolve();
  });
  expect(history.at(-1)).toMatchObject({ revisionId: 'first-revision' });
});

it('ignores reads from a closed dialog after another opens', async () => {
  let finish: (value: unknown) => void = () => {};
  reads.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render('first');
  await render('first', false);
  await render('second');
  await act(async () => {
    finish(readable('first'));
    await Promise.resolve();
  });
  expect(history.at(-1)).toMatchObject({ revisionId: 'second-revision' });
});
