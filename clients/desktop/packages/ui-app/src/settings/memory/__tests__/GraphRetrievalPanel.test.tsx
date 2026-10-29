/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExplorerRetrievalPreview } from '@canopy/protocol/settings/organization-memory';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import { GraphRetrievalPanel } from '../GraphRetrievalPanel';

// The settings client validates results against the operation table; the
// fake client returns whatever the deferred response resolves, so every
// resolved object counts as a preview here and sequencing can be tested.
const previewSearchMock = jest.fn<Promise<unknown>, [unknown]>();

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

function deferResponses(count: number): Deferred[] {
  const deferred: Deferred[] = [];
  for (let index = 0; index < count; index += 1) {
    let resolve: (value: unknown) => void = () => undefined;
    let reject: (reason: Error) => void = () => undefined;
    const promise = new Promise<unknown>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    deferred.push({ resolve, reject });
    previewSearchMock.mockImplementationOnce(() => promise);
  }
  return deferred;
}

describe('GraphRetrievalPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onPreview: jest.Mock<void, [ExplorerRetrievalPreview | null]>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onPreview = jest.fn<void, [ExplorerRetrievalPreview | null]>();
    previewSearchMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const client = createFakeSettingsClient({
    'organization.memory.previewSearch': (input) => previewSearchMock(input),
  });
  const { host } = createTestSettingsHost({ client });

  function render(): void {
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <GraphRetrievalPanel
            orgId="org-1"
            preview={null}
            hiddenEntityCount={0}
            onPreview={onPreview}
          />
        </TestSettingsHost>,
      );
    });
  }

  function queryInput(): HTMLInputElement {
    const input = container.querySelector('input[type="search"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Query input not found');
    }
    return input;
  }

  function setQuery(value: string): void {
    const input = queryInput();
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    );
    if (descriptor?.set === undefined) {
      throw new Error('HTMLInputElement value setter not found');
    }
    act(() => {
      descriptor.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function submitForm(): void {
    const form = container.querySelector('form');
    if (!(form instanceof HTMLFormElement)) {
      throw new Error('Form not found');
    }
    act(() => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('reports a resolved preview to the parent', async () => {
    const [request] = deferResponses(1);
    render();
    setQuery('databases');
    submitForm();

    const payload = { gatePassed: true };
    await act(async () => {
      request.resolve(payload);
      await Promise.resolve();
    });

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith(payload);
    expect(previewSearchMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      query: 'databases',
    });
  });

  it('ignores out-of-order responses from superseded submissions', async () => {
    const [first, second] = deferResponses(2);
    render();
    setQuery('first query');
    submitForm();
    setQuery('second query');
    submitForm();

    const winner = { gatePassed: true };
    await act(async () => {
      second.resolve(winner);
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve({ gatePassed: false });
      await Promise.resolve();
    });

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith(winner);
  });

  it('clearing the query supersedes the in-flight preview', async () => {
    const [request] = deferResponses(1);
    render();
    setQuery('databases');
    submitForm();
    setQuery('');

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith(null);

    await act(async () => {
      request.resolve({ gatePassed: true });
      await Promise.resolve();
    });

    // The late response must not restore the highlight the user cleared.
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Previewing…');
  });

  it('shows action copy, never the error text, without reporting a preview', async () => {
    const [request] = deferResponses(1);
    render();
    setQuery('databases');
    submitForm();

    await act(async () => {
      request.reject(new Error('SENTINEL upstream text'));
      await Promise.resolve();
    });
    await flush();

    expect(onPreview).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Couldn't preview retrieval. Try again.",
    );
    expect(container.textContent).not.toContain('SENTINEL');
  });
});
