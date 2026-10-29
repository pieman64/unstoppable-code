/** @jest-environment jsdom */
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComposerEditorHandle } from '@canopy/ui-rich/editor';
import type { ComposerDraftSnapshot } from '../composer-draft';
import { DraftComposerEditor } from '../DraftComposerEditor';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = <T,>(value: T): T =>
    JSON.parse(JSON.stringify(value)) as T;
}

it('publishes coherent text/reference snapshots for inserts and an intentional clear', async () => {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: (): void => {},
    removeListener: (): void => {},
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    dispatchEvent: (): boolean => false,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<ComposerEditorHandle>();
  const changed = jest.fn<void, [ComposerDraftSnapshot]>();
  try {
    await act(async () => {
      root.render(
        <DraftComposerEditor
          ref={ref}
          onDraftChange={changed}
          initialText="see "
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      ref.current?.insertFileReference({
        displayPath: 'src/app.ts',
        absolutePath: '/repo/src/app.ts',
      });
      await Promise.resolve();
    });
    expect(changed.mock.lastCall?.[0]).toEqual(ref.current?.serialize());
    expect(changed.mock.lastCall?.[0].fileReferences).toHaveLength(1);
    await act(async () => {
      ref.current?.reset();
      await Promise.resolve();
    });
    expect(changed.mock.lastCall?.[0]).toEqual({
      text: '',
      fileReferences: [],
    });
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  }
});
