/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  buildEditorValueFromMessage,
  createChatEditor,
  SlateEditor,
} from '@canopy/ui-rich/editor';
import type { SerializedFileReference } from '@canopy/ui-rich/types';
import { hasComposerDraft, isComposerFocused } from '../composer-activity';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// jsdom's test global scope does not expose Node's structuredClone, which
// the editor uses to clone its initial value.
if (typeof globalThis.structuredClone === 'undefined') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: (value: unknown): unknown => JSON.parse(JSON.stringify(value)),
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

function Composer({
  text = '',
  fileReferences = [],
  hidden = false,
}: {
  readonly text?: string;
  readonly fileReferences?: readonly SerializedFileReference[];
  readonly hidden?: boolean;
}): JSX.Element {
  const [editor] = useState(createChatEditor);
  const [value, setValue] = useState(() =>
    buildEditorValueFromMessage(text, fileReferences),
  );
  return (
    <div data-chat-composer-root hidden={hidden}>
      <SlateEditor
        editor={editor}
        value={value}
        placeholder="Ask anything"
        onChange={setValue}
      />
      <button type="button">Send</button>
    </div>
  );
}

function renderComposer(props: Parameters<typeof Composer>[0] = {}): void {
  act(() => root.render(<Composer {...props} />));
}

describe('composer activity with the real editor', () => {
  it('ignores the empty editor and its zero-width filler', () => {
    renderComposer();
    expect(container.querySelector('[data-slate-zero-width]')).not.toBeNull();
    expect(hasComposerDraft(document)).toBe(false);
  });

  it('counts text, but not whitespace alone', () => {
    renderComposer({ text: '   ' });
    expect(hasComposerDraft(document)).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
    renderComposer({ text: 'draft' });
    expect(hasComposerDraft(document)).toBe(true);
  });

  it('counts a file reference pill as the only content', () => {
    renderComposer({
      text: 'src/a.ts',
      fileReferences: [
        {
          displayPath: 'src/a.ts',
          absolutePath: '/repo/src/a.ts',
          textStart: 0,
        },
      ],
    });
    expect(
      container.querySelector('[data-testid="file-reference-pill"]'),
    ).not.toBeNull();
    expect(hasComposerDraft(document)).toBe(true);
  });

  it('counts a draft held by a hidden composer', () => {
    renderComposer({ text: 'kept', hidden: true });
    expect(hasComposerDraft(document)).toBe(true);
  });

  it('treats focus anywhere in a composer as composer focus', () => {
    renderComposer();
    expect(isComposerFocused(document)).toBe(false);
    act(() => container.querySelector('button')?.focus());
    expect(isComposerFocused(document)).toBe(true);
  });
});

describe('composer activity outside the editor', () => {
  it('counts the staged attachment strip in the Home composer', () => {
    container.innerHTML =
      '<div data-testid="home-composer"><div data-testid="attachment-strip"></div></div>';
    expect(hasComposerDraft(document)).toBe(true);
  });

  it('ignores Slate placeholder text', () => {
    // The markup Slate renders for an empty editor's placeholder.
    container.innerHTML =
      '<div data-chat-composer-root><div data-chat-textarea><p><span><span data-slate-placeholder="true" contenteditable="false">Ask anything</span><span data-slate-zero-width="n">\uFEFF<br></span></span></p></div></div>';
    expect(hasComposerDraft(document)).toBe(false);
  });

  it('ignores text and focus outside every composer', () => {
    container.innerHTML =
      '<div data-chat-textarea>not a composer</div><button>Other</button>';
    container.querySelector('button')?.focus();
    expect(hasComposerDraft(document)).toBe(false);
    expect(isComposerFocused(document)).toBe(false);
  });
});
