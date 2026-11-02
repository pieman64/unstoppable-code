/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ComposerWorkDrawerProvider,
  useComposerWorkDrawerLink,
  type ComposerWorkDrawerLink,
} from '../composer-work-drawer-context';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

let link: ComposerWorkDrawerLink | null = null;

function Probe(): null {
  link = useComposerWorkDrawerLink();
  return null;
}

function Panel({ id }: { readonly id: string }): JSX.Element {
  const current = useComposerWorkDrawerLink();
  return (
    <div
      data-panel={id}
      ref={
        id === 'editor'
          ? current?.queuedEditorPanelRef
          : current?.queuedPanelRef
      }
    />
  );
}

describe('ComposerWorkDrawerProvider', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    link = null;
  });

  const render = (panels: readonly string[]): void =>
    act(() =>
      root.render(
        <ComposerWorkDrawerProvider>
          <Probe />
          {panels.map((id) => (
            <Panel key={id} id={id} />
          ))}
        </ComposerWorkDrawerProvider>,
      ),
    );

  it('hands the queue back to the composer panel when an editor panel closes', () => {
    render(['composer']);
    expect(link?.queuedSlot?.dataset.panel).toBe('composer');
    render(['composer', 'editor']);
    expect(link?.queuedSlot?.dataset.panel).toBe('editor');
    render(['composer']);
    expect(link?.queuedSlot?.dataset.panel).toBe('composer');
    render([]);
    expect(link?.queuedSlot).toBeNull();
  });

  it('keeps a newly queued message with the editor when both panels remount', () => {
    render(['composer']);
    render(['editor', 'composer']);
    // Editing the only row empties the queue and removes both panels.
    render([]);
    // The editor is before the hidden main composer in the chat tree.
    render(['editor', 'composer']);
    expect(link?.queuedSlot?.dataset.panel).toBe('editor');
    render(['composer']);
    expect(link?.queuedSlot?.dataset.panel).toBe('composer');
  });

  it('reuses an outer link instead of nesting a new one', () => {
    let inner: ComposerWorkDrawerLink | null = null;
    function InnerProbe(): null {
      inner = useComposerWorkDrawerLink();
      return null;
    }
    act(() =>
      root.render(
        <ComposerWorkDrawerProvider>
          <Probe />
          <ComposerWorkDrawerProvider>
            <InnerProbe />
          </ComposerWorkDrawerProvider>
        </ComposerWorkDrawerProvider>,
      ),
    );
    expect(inner).toBe(link);
  });
});
