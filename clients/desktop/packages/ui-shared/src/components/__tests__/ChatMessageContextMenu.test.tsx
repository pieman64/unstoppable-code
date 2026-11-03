/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CHAT_MESSAGE_LINK_URL_ATTRIBUTE,
  chatMessageLinkUrlProps,
  ChatMessageContextMenuScope,
  ChatMessageLinkActionsProvider,
  useChatMessageContextMenu,
  type ChatMessageClipboardWriter,
  type ChatMessageLinkActions,
} from '../ChatMessageContextMenu';

interface RowProps {
  id: string;
  writeText?: ChatMessageClipboardWriter;
  onRowClick?: () => void;
  children?: ReactNode;
}

function Row({ id, writeText, onRowClick, children }: RowProps): ReactNode {
  const { targetProps, menu } = useChatMessageContextMenu({
    messageId: id,
    ...(writeText ? { writeText } : {}),
  });
  return (
    <div onClick={onRowClick}>
      <div data-testid={`row-${id}`} tabIndex={-1} {...targetProps}>
        {children ?? <p data-testid={`text-${id}`}>Message {id}</p>}
      </div>
      {menu}
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.getSelection()?.removeAllRanges();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function byTestId(testId: string, doc: Document = document): HTMLElement {
  const element = doc.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof (doc.defaultView ?? window).HTMLElement)) {
    throw new Error(`missing ${testId}`);
  }
  return element;
}

function queryMenus(doc: Document = document): NodeListOf<Element> {
  return doc.querySelectorAll('[data-testid="chat-message-context-menu"]');
}

function rightClick(
  target: Element,
  init: MouseEventInit = { clientX: 40, clientY: 50 },
): MouseEvent {
  const view = target.ownerDocument.defaultView ?? window;
  const event = new view.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function keyDown(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const view = target.ownerDocument.defaultView ?? window;
  const event = new view.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function click(target: Element): void {
  const view = target.ownerDocument.defaultView ?? window;
  act(() => {
    target.dispatchEvent(new view.MouseEvent('click', { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function selectContents(node: Node): void {
  const doc = node.ownerDocument;
  if (!doc) throw new Error('detached node');
  const range = doc.createRange();
  range.selectNodeContents(node);
  const selection = doc.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function menuItem(testId: string, doc: Document = document): HTMLButtonElement {
  const item = byTestId(testId, doc);
  if (!(item instanceof (doc.defaultView ?? window).HTMLButtonElement)) {
    throw new Error(`${testId} is not a button`);
  }
  return item;
}

function menuLabels(): Array<string | null> {
  return Array.from(
    byTestId('chat-message-context-menu').querySelectorAll('[role="menuitem"]'),
  ).map((item) => item.textContent);
}

describe('useChatMessageContextMenu', () => {
  it('keeps read-only scopes inactive and discards menus when disabled', () => {
    const scoped = (enabled: boolean): ReactNode => (
      <ChatMessageContextMenuScope enabled={enabled}>
        <Row id="a" />
      </ChatMessageContextMenuScope>
    );
    render(scoped(false));
    expect(rightClick(byTestId('text-a')).defaultPrevented).toBe(false);
    expect(queryMenus()).toHaveLength(0);
    render(scoped(true));
    rightClick(byTestId('text-a'));
    expect(queryMenus()).toHaveLength(1);
    render(scoped(false));
    expect(queryMenus()).toHaveLength(0);
    render(scoped(true));
    expect(queryMenus()).toHaveLength(0);
  });
  it('renders no menu markup while closed', () => {
    const html = renderToStaticMarkup(<Row id="a" />);
    expect(html).not.toContain('chat-message-context-menu');
    render(<Row id="a" />);
    expect(queryMenus()).toHaveLength(0);
  });

  it('opens at the pointer with only a disabled Copy selection without a selection', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(<Row id="a" writeText={writeText} />);
    const event = rightClick(byTestId('text-a'));
    expect(event.defaultPrevented).toBe(true);
    const menu = byTestId('chat-message-context-menu');
    expect(menu.style.left).toBe('40px');
    expect(menu.style.top).toBe('50px');
    expect(menuLabels()).toEqual(['Copy selection']);
    // The whole-message copies live in the footer, not here (CAN-4870).
    expect(
      document.querySelector('[data-testid="chat-message-copy-plain"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="chat-message-copy-markdown"]'),
    ).toBeNull();
    const item = menuItem('chat-message-copy-selection');
    expect(item.disabled).toBe(true);
    click(item);
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="chat-message-copied"]'),
    ).toBeNull();
  });

  it('copies exactly the rendered selection, never the message source', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(
      <Row id="a" writeText={writeText}>
        <div data-testid="text-a">
          <h1>Plan</h1>
          <ul>
            <li>
              <strong>one</strong>
            </li>
          </ul>
          <pre>{'line one\n  line two'}</pre>
        </div>
      </Row>,
    );
    selectContents(byTestId('text-a'));
    const expected = document.getSelection()?.toString() ?? '';
    expect(expected).toContain('line one\n  line two');
    rightClick(byTestId('text-a'));
    expect(menuItem('chat-message-copy-selection').disabled).toBe(false);
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(expected, document);
    expect(writeText.mock.calls[0]?.[0]).not.toContain('**');
  });

  it('copies a rendered formula in the selection as its TeX source', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(
      <Row id="a" writeText={writeText}>
        <p data-testid="text-a">
          {'Ramsey '}
          <span
            className="canopy-markdown-math-container"
            data-math-source={'\\(R(3,3)\\)'}
          >
            <span data-testid="formula-a">R ( 3 , 3 ) R(3,3)</span>
          </span>
          {' is 6'}
        </p>
      </Row>,
    );
    // The selection starts inside the formula, which still copies whole.
    const formulaText = byTestId('formula-a').firstChild;
    const tail = byTestId('text-a').lastChild;
    if (!formulaText || !tail) throw new Error('missing text nodes');
    const range = document.createRange();
    range.setStart(formulaText, 4);
    range.setEnd(tail, tail.textContent?.length ?? 0);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(writeText).toHaveBeenCalledWith('\\(R(3,3)\\) is 6', document);

    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(writeText).toHaveBeenLastCalledWith(
      'Ramsey \\(R(3,3)\\) is 6',
      document,
    );
  });

  it('copies the selection captured when the menu opened, whitespace and Unicode intact', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(
      <>
        <Row id="a" writeText={writeText}>
          <p data-testid="text-a">{'  héllo 🌲  '}</p>
        </Row>
        <Row id="b" writeText={writeText} />
      </>,
    );
    // The selection may span messages; any selection in the document counts.
    const doc = document;
    const range = doc.createRange();
    range.setStart(byTestId('text-a').firstChild ?? byTestId('text-a'), 0);
    range.setEnd(byTestId('text-b').firstChild ?? byTestId('text-b'), 7);
    doc.getSelection()?.removeAllRanges();
    doc.getSelection()?.addRange(range);
    const expected = doc.getSelection()?.toString() ?? '';
    expect(expected.startsWith('  héllo 🌲  ')).toBe(true);

    rightClick(byTestId('text-b'));
    doc.getSelection()?.removeAllRanges();
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(writeText).toHaveBeenCalledWith(expected, document);
  });

  it('copies a whitespace-only selection verbatim', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(
      <Row id="a" writeText={writeText}>
        <p data-testid="text-a">{' \n\t '}</p>
      </Row>,
    );
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    expect(menuItem('chat-message-copy-selection').disabled).toBe(false);
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(writeText).toHaveBeenCalledWith(' \n\t ', document);
  });

  it('keeps the opening snapshot and captures afresh on every opening', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(
      <Row id="a" writeText={writeText}>
        <p data-testid="text-a">first</p>
        <p data-testid="other-a">second</p>
      </Row>,
    );
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    // A live selection change after opening does not change the payload.
    selectContents(byTestId('other-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(writeText).toHaveBeenLastCalledWith('first', document);

    // Reopening with no selection leaves no stale text available.
    document.getSelection()?.removeAllRanges();
    rightClick(byTestId('text-a'));
    expect(menuItem('chat-message-copy-selection').disabled).toBe(true);
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);

    selectContents(byTestId('other-a'));
    rightClick(byTestId('other-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(writeText).toHaveBeenLastCalledWith('second', document);
  });

  it.each(['invalid', ' true '])(
    'inherits invalid contenteditable value %s from a noneditable parent',
    (value) => {
      render(
        <Row id="a">
          <div data-testid="invalid-host">
            <span data-testid="invalid-editable">ordinary text</span>
          </div>
        </Row>,
      );
      byTestId('invalid-host').setAttribute('contenteditable', value);
      rightClick(byTestId('invalid-editable'));
      expect(queryMenus()).toHaveLength(1);
    },
  );

  it.each([
    ['an input', <input key="i" data-testid="owned" />],
    ['a textarea', <textarea key="t" data-testid="owned" />],
    [
      'an editable region',
      <div key="e" contentEditable suppressContentEditableWarning>
        <span data-testid="owned">editable</span>
      </div>,
    ],
    [
      'an inherited editable region',
      <div key="h" contentEditable suppressContentEditableWarning>
        <div contentEditable="inherit" suppressContentEditableWarning>
          <span data-testid="owned">editable</span>
        </div>
      </div>,
    ],
    [
      'the terminal',
      <div key="x" className="xterm">
        <span data-testid="owned">$</span>
      </div>,
    ],
    [
      'Monaco',
      <div key="m" className="monaco-editor">
        <span data-testid="owned">code</span>
      </div>,
    ],
    [
      'a control that owns its menu',
      <button key="b" type="button" data-owns-context-menu="">
        <span data-testid="owned">own</span>
      </button>,
    ],
  ])('yields to %s inside the message', (_label, child) => {
    render(<Row id="a">{child}</Row>);
    const event = rightClick(byTestId('owned'));
    expect(event.defaultPrevented).toBe(false);
    expect(queryMenus()).toHaveLength(0);
    const key = keyDown(byTestId('owned'), { key: 'ContextMenu' });
    expect(key.defaultPrevented).toBe(false);
    expect(queryMenus()).toHaveLength(0);
  });

  it('opens over a non-editable island inside an editable ancestor', () => {
    render(
      <Row id="a">
        <div contentEditable suppressContentEditableWarning>
          <div contentEditable={false}>
            <span data-testid="island">read only</span>
          </div>
        </div>
      </Row>,
    );
    rightClick(byTestId('island'));
    expect(queryMenus()).toHaveLength(1);
  });

  it('yields to an already-handled event and to touch long-press', () => {
    render(<Row id="a" />);
    const text = byTestId('text-a');
    const prevent = (event: Event): void => event.preventDefault();
    text.addEventListener('contextmenu', prevent);
    rightClick(text);
    text.removeEventListener('contextmenu', prevent);
    expect(queryMenus()).toHaveLength(0);

    const touch = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 5,
    });
    Object.defineProperty(touch, 'pointerType', { value: 'touch' });
    act(() => {
      text.dispatchEvent(touch);
    });
    expect(touch.defaultPrevented).toBe(false);
    expect(queryMenus()).toHaveLength(0);
  });

  it('keeps one menu per document and lets an inner message own the event', () => {
    render(
      <>
        <Row id="a" />
        <Row id="outer">
          <Row id="inner" />
        </Row>
      </>,
    );
    rightClick(byTestId('text-a'));
    expect(queryMenus()).toHaveLength(1);
    rightClick(byTestId('text-inner'));
    expect(queryMenus()).toHaveLength(1);
    // Reopening on the first row replaces the inner row's menu.
    rightClick(byTestId('text-a'));
    expect(queryMenus()).toHaveLength(1);
  });

  it('closes when its message is removed or replaced', () => {
    render(<Row id="a" />);
    rightClick(byTestId('text-a'));
    expect(queryMenus()).toHaveLength(1);
    render(<Row id="b" />);
    expect(queryMenus()).toHaveLength(0);

    // Reusing a prior identity must not resurrect its old selection/menu.
    render(<Row id="a" />);
    expect(queryMenus()).toHaveLength(0);
    render(<Row id="b" />);

    rightClick(byTestId('text-b'));
    expect(queryMenus()).toHaveLength(1);
    render(null);
    expect(queryMenus()).toHaveLength(0);
  });

  it('dismisses on an outside press, resize and blur', () => {
    render(<Row id="a" />);
    rightClick(byTestId('text-a'));
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
      // A whole press: the menu swallows the click its dismissal completes.
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(queryMenus()).toHaveLength(0);
    rightClick(byTestId('text-a'));
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(queryMenus()).toHaveLength(0);
    rightClick(byTestId('text-a'));
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(queryMenus()).toHaveLength(0);
  });

  it('opens from Shift+F10 at the message with no enabled item, then Escape closes', () => {
    render(<Row id="a" />);
    const row = byTestId('row-a');
    row.getBoundingClientRect = (): DOMRect => new DOMRect(30, 120, 200, 40);
    act(() => row.focus());
    const event = keyDown(row, { key: 'F10', shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    const menu = byTestId('chat-message-context-menu');
    expect(menu.style.left).toBe('30px');
    expect(menu.style.top).toBe('120px');
    // Copy selection is disabled, so focus stays on the message.
    expect(menuItem('chat-message-copy-selection').disabled).toBe(true);
    expect(document.activeElement).toBe(row);
    // Arrow keys skip the disabled item.
    keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row);

    keyDown(row, { key: 'Escape' });
    expect(queryMenus()).toHaveLength(0);
    expect(document.activeElement).toBe(row);
  });

  it('closes on Escape with no enabled item even when the focused trigger consumes the key', () => {
    // A hover-card trigger (RichHoverTooltip with dismissOnEscape) stops
    // Escape from propagating; the open menu is the topmost layer.
    const onTriggerEscape = jest.fn();
    render(
      <Row id="a">
        <span
          data-testid="trigger-a"
          role="link"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            onTriggerEscape();
          }}
        >
          CAN-1
        </span>
      </Row>,
    );
    const trigger = byTestId('trigger-a');
    act(() => trigger.focus());
    rightClick(trigger);
    expect(menuItem('chat-message-copy-selection').disabled).toBe(true);
    expect(document.activeElement).toBe(trigger);

    const event = keyDown(trigger, { key: 'Escape' });
    expect(event.defaultPrevented).toBe(true);
    expect(queryMenus()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
    // The menu took this Escape; the next one reaches the trigger again.
    expect(onTriggerEscape).not.toHaveBeenCalled();
    keyDown(trigger, { key: 'Escape' });
    expect(onTriggerEscape).toHaveBeenCalledTimes(1);
  });

  it('focuses Copy selection for a keyboard menu over a selection, then Escape restores focus', () => {
    render(<Row id="a" />);
    const row = byTestId('row-a');
    // jsdom clears the selection on focus, so select after focusing.
    act(() => row.focus());
    selectContents(byTestId('text-a'));
    keyDown(row, { key: 'F10', shiftKey: true });
    expect(document.activeElement).toBe(
      menuItem('chat-message-copy-selection'),
    );

    keyDown(menuItem('chat-message-copy-selection'), { key: 'Escape' });
    expect(queryMenus()).toHaveLength(0);
    expect(document.activeElement).toBe(row);
  });

  it('anchors a zero-coordinate (keyboard) contextmenu event at the message', () => {
    render(<Row id="a" />);
    const row = byTestId('row-a');
    row.getBoundingClientRect = (): DOMRect => new DOMRect(12, 34, 100, 20);
    rightClick(row, { clientX: 0, clientY: 0 });
    const menu = byTestId('chat-message-context-menu');
    expect(menu.style.left).toBe('12px');
    expect(menu.style.top).toBe('34px');
  });

  it('clamps the open menu at the owning viewport edge', () => {
    const measure = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 300, 120));
    // The shared menu measures its laid-out box, which jsdom does not lay out.
    const sizes = [
      jest
        .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
        .mockReturnValue(300),
      jest
        .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
        .mockReturnValue(120),
      jest.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(120),
      jest.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(120),
    ];
    try {
      render(<Row id="a" />);
      rightClick(byTestId('text-a'), {
        clientX: window.innerWidth - 1,
        clientY: window.innerHeight - 1,
      });
      const menu = byTestId('chat-message-context-menu');
      expect(menu.style.left).toBe(`${window.innerWidth - 304}px`);
      expect(menu.style.top).toBe(`${window.innerHeight - 124}px`);
    } finally {
      measure.mockRestore();
      for (const size of sizes) size.mockRestore();
    }
  });

  it('opens from the Menu key and ignores other keys', () => {
    render(<Row id="a" />);
    keyDown(byTestId('row-a'), { key: 'F10' });
    expect(queryMenus()).toHaveLength(0);
    keyDown(byTestId('row-a'), { key: 'ContextMenu' });
    expect(queryMenus()).toHaveLength(1);
  });

  it('keeps menu clicks from reaching the message row', async () => {
    const onRowClick = jest.fn();
    render(
      <Row
        id="a"
        writeText={() => Promise.resolve(true)}
        onRowClick={onRowClick}
      />,
    );
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(queryMenus()).toHaveLength(0);
  });

  it.each([
    ['returns false', (): Promise<boolean> => Promise.resolve(false)],
    ['rejects', (): Promise<boolean> => Promise.reject(new Error('denied'))],
    [
      'throws',
      (): Promise<boolean> => {
        throw new Error('sync');
      },
    ],
  ])(
    'shows a copy failure when the clipboard write %s',
    async (_label, write) => {
      render(<Row id="a" writeText={write} />);
      selectContents(byTestId('text-a'));
      rightClick(byTestId('text-a'));
      click(menuItem('chat-message-copy-selection'));
      await flush();
      const status = byTestId('chat-message-copy-failed');
      expect(status.querySelector('[role="alert"]')?.textContent).toBe(
        "Couldn't copy to clipboard",
      );
      act(() => {
        document.body.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true }),
        );
      });
      expect(
        document.querySelector('[data-testid="chat-message-copy-failed"]'),
      ).toBeNull();
    },
  );

  it('reads the selection and writes through the auxiliary window it opened in', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    if (!doc) throw new Error('auxiliary document missing');
    const auxContainer = doc.createElement('div');
    doc.body.append(auxContainer);
    const auxRoot = createRoot(auxContainer);
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    try {
      act(() => auxRoot.render(<Row id="aux" writeText={writeText} />));
      // A main-window selection must not leak into the auxiliary menu.
      const mainText = document.createElement('p');
      mainText.textContent = 'main selection';
      document.body.append(mainText);
      selectContents(mainText);
      rightClick(byTestId('text-aux', doc));
      expect(queryMenus(doc)).toHaveLength(1);
      expect(queryMenus(document)).toHaveLength(0);
      expect(menuItem('chat-message-copy-selection', doc).disabled).toBe(true);
      mainText.remove();

      act(() => auxRoot.render(null));
      act(() => auxRoot.render(<Row id="aux" writeText={writeText} />));
      selectContents(byTestId('text-aux', doc));
      rightClick(byTestId('text-aux', doc));
      click(menuItem('chat-message-copy-selection', doc));
      await flush();
      expect(writeText).toHaveBeenCalledWith('Message aux', doc);
    } finally {
      act(() => auxRoot.unmount());
      frame.remove();
    }
  });
});

describe('useChatMessageContextMenu link section (CAN-2632)', () => {
  const LINK_ITEMS = [
    'Copy link',
    'Open in browser',
    'Open in external browser',
  ] as const;
  // Copy selection always follows the link section, disabled without a
  // selection (CAN-4870).
  const COPY_ITEMS = ['Copy selection'];

  function LinkRow({
    actions,
    writeText,
  }: {
    actions?: ChatMessageLinkActions;
    writeText?: ChatMessageClipboardWriter;
  }): ReactNode {
    const row = (
      <Row id="a" {...(writeText ? { writeText } : {})}>
        <p data-testid="text-a">
          See{' '}
          <a data-testid="link-a" href="/docs?x=1#frag">
            the <code data-testid="link-code">docs</code>
          </a>{' '}
          or{' '}
          <a data-testid="mail-a" href="mailto:team@example.com">
            mail
          </a>
        </p>
      </Row>
    );
    return actions ? (
      <ChatMessageLinkActionsProvider value={actions}>
        {row}
      </ChatMessageLinkActionsProvider>
    ) : (
      row
    );
  }

  const resolved = new URL('/docs?x=1#frag', document.baseURI).href;

  it('shows only Copy link and a divider without host link actions', () => {
    render(<LinkRow />);
    rightClick(byTestId('link-a'));
    expect(menuLabels()).toEqual(['Copy link', ...COPY_ITEMS]);
    expect(menuItem('chat-message-copy-link').disabled).toBe(false);
    expect(menuItem('chat-message-copy-selection').disabled).toBe(true);
    const menu = byTestId('chat-message-context-menu');
    const separators = menu.querySelectorAll('[role="separator"]');
    expect(separators.length).toBe(1);
    // The one divider sits between the link section and Copy selection.
    const order = Array.from(
      menu.querySelectorAll('[role="menuitem"], [role="separator"]'),
    ).map((node) => node.getAttribute('role'));
    expect(order).toEqual(['menuitem', 'separator', 'menuitem']);
  });

  it('gates each open action on the host providing it', () => {
    render(<LinkRow actions={{ openExternal: jest.fn() }} />);
    rightClick(byTestId('link-a'));
    expect(menuLabels()).toEqual([
      'Copy link',
      'Open in external browser',
      ...COPY_ITEMS,
    ]);
  });

  it('lists the link actions in order above the copy items', () => {
    render(
      <LinkRow
        actions={{ openInBrowser: jest.fn(), openExternal: jest.fn() }}
      />,
    );
    rightClick(byTestId('link-a'));
    expect(menuLabels()).toEqual([...LINK_ITEMS, ...COPY_ITEMS]);
  });

  it('copies the resolved link URL, query and hash intact', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(<LinkRow writeText={writeText} />);
    rightClick(byTestId('link-code'));
    click(menuItem('chat-message-copy-link'));
    await flush();
    expect(writeText).toHaveBeenCalledWith(resolved, document);
    expect(queryMenus()).toHaveLength(0);
  });

  it('hands the URL to the chosen open action and closes', () => {
    const openInBrowser = jest.fn();
    const openExternal = jest.fn();
    render(<LinkRow actions={{ openInBrowser, openExternal }} />);
    rightClick(byTestId('link-a'));
    click(menuItem('chat-message-open-link-in-browser'));
    expect(openInBrowser).toHaveBeenCalledWith(resolved);
    expect(queryMenus()).toHaveLength(0);
    rightClick(byTestId('link-a'));
    click(menuItem('chat-message-open-link-external'));
    expect(openExternal).toHaveBeenCalledWith(resolved);
    expect(queryMenus()).toHaveLength(0);
  });

  it('captures the focused link for the keyboard menu', () => {
    render(<LinkRow actions={{ openExternal: jest.fn() }} />);
    const link = byTestId('link-a');
    act(() => link.focus());
    keyDown(link, { key: 'F10', shiftKey: true });
    expect(menuLabels()).toEqual([
      'Copy link',
      'Open in external browser',
      ...COPY_ITEMS,
    ]);
    // Link actions come first, and navigation skips disabled Copy selection.
    expect(document.activeElement).toBe(menuItem('chat-message-copy-link'));
    const menu = byTestId('chat-message-context-menu');
    keyDown(menuItem('chat-message-copy-link'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      menuItem('chat-message-open-link-external'),
    );
    keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menuItem('chat-message-copy-link'));
  });

  it('enables Copy selection after the link section over a selection', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(<LinkRow writeText={writeText} />);
    selectContents(byTestId('text-a'));
    const expected = document.getSelection()?.toString() ?? '';
    rightClick(byTestId('link-a'));
    expect(menuLabels()).toEqual(['Copy link', ...COPY_ITEMS]);
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(writeText).toHaveBeenCalledWith(expected, document);
  });

  it('treats non-http links and plain text as non-link targets', () => {
    render(<LinkRow actions={{ openExternal: jest.fn() }} />);
    rightClick(byTestId('link-a'));
    expect(menuLabels()[0]).toBe('Copy link');
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    });
    // A later non-link open never carries the earlier link.
    rightClick(byTestId('text-a'));
    expect(menuLabels()).toEqual(COPY_ITEMS);
    rightClick(byTestId('mail-a'));
    expect(menuLabels()).toEqual(COPY_ITEMS);
  });

  const LINEAR_URL = 'https://linear.app/acme/issue/CAN-1/slug';
  const GITHUB_URL = 'https://github.com/acme/app/pull/7';

  function DeclaredRow({
    actions,
    writeText,
    refAUrl = LINEAR_URL,
  }: {
    actions?: ChatMessageLinkActions;
    writeText?: ChatMessageClipboardWriter;
    refAUrl?: string;
  }): ReactNode {
    const row = (
      <Row id="a" {...(writeText ? { writeText } : {})}>
        <p data-testid="text-a">
          <span
            data-testid="ref-a"
            role="link"
            tabIndex={0}
            data-link-url={refAUrl}
          >
            <svg />
            <span data-testid="ref-a-title">CAN-1: Title</span>
          </span>{' '}
          and{' '}
          <span
            data-testid="ref-b"
            role="link"
            tabIndex={0}
            data-link-url={GITHUB_URL}
          >
            <svg />
            <span data-testid="ref-b-title">#7: Title</span>
          </span>
        </p>
      </Row>
    );
    return actions ? (
      <ChatMessageLinkActionsProvider value={actions}>
        {row}
      </ChatMessageLinkActionsProvider>
    ) : (
      row
    );
  }

  const bothActions = (): ChatMessageLinkActions => ({
    openInBrowser: jest.fn(),
    openExternal: jest.fn(),
  });

  it('declares a link for a non-anchor element', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(<DeclaredRow actions={bothActions()} writeText={writeText} />);
    rightClick(byTestId('ref-a-title'));
    expect(menuLabels()).toEqual([...LINK_ITEMS, ...COPY_ITEMS]);
    click(menuItem('chat-message-copy-link'));
    await flush();
    expect(writeText).toHaveBeenCalledWith(LINEAR_URL, document);
    expect(queryMenus()).toHaveLength(0);
  });

  it('picks the declared element under the target', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(<DeclaredRow actions={bothActions()} writeText={writeText} />);
    rightClick(byTestId('ref-b-title'));
    click(menuItem('chat-message-copy-link'));
    await flush();
    expect(writeText).toHaveBeenCalledWith(GITHUB_URL, document);
  });

  it('opens the keyboard menu on a focused declared element', () => {
    render(<DeclaredRow actions={bothActions()} />);
    const reference = byTestId('ref-a');
    act(() => reference.focus());
    keyDown(reference, { key: 'F10', shiftKey: true });
    expect(menuLabels()).toEqual([...LINK_ITEMS, ...COPY_ITEMS]);
  });

  it('treats a declared link like an anchor without host link actions', () => {
    render(<DeclaredRow />);
    rightClick(byTestId('ref-a-title'));
    expect(menuLabels()).toEqual(['Copy link', ...COPY_ITEMS]);
  });

  it.each([
    '',
    '/relative',
    'mailto:a@b.test',
    'javascript:void(0)',
    'not a url',
  ])(
    'ignores the declared value %p, which is not an absolute http(s) URL',
    (value) => {
      render(<DeclaredRow actions={bothActions()} refAUrl={value} />);
      rightClick(byTestId('ref-a-title'));
      expect(menuLabels()).toEqual(COPY_ITEMS);
    },
  );

  it('prefers an anchor inside a declared element', async () => {
    const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
      Promise.resolve(true),
    );
    render(
      <Row id="a" writeText={writeText}>
        <span data-link-url="https://a.test/declared">
          <a data-testid="inner-anchor" href="https://a.test/anchor">
            x
          </a>
        </span>
      </Row>,
    );
    rightClick(byTestId('inner-anchor'));
    click(menuItem('chat-message-copy-link'));
    await flush();
    expect(writeText).toHaveBeenCalledWith('https://a.test/anchor', document);
  });

  it('ignores a declaration outside the message element', () => {
    render(
      <div data-link-url="https://a.test/outside">
        <Row id="a" />
      </div>,
    );
    rightClick(byTestId('text-a'));
    expect(menuLabels()).toEqual(COPY_ITEMS);
  });
});

describe('chatMessageLinkUrlProps', () => {
  it.each([null, undefined, ''])('declares nothing for %p', (url) => {
    expect(chatMessageLinkUrlProps(url)).toEqual({});
  });

  it('declares a known URL under the shared attribute', () => {
    const url = 'https://linear.app/acme/issue/CAN-1';
    expect(chatMessageLinkUrlProps(url)).toEqual({ 'data-link-url': url });
    expect(CHAT_MESSAGE_LINK_URL_ATTRIBUTE).toBe('data-link-url');
  });
});

describe('useChatMessageContextMenu copy feedback (CAN-4704)', () => {
  function deferred(): {
    promise: Promise<boolean>;
    resolve: (value: boolean) => void;
  } {
    let resolve: (value: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function queryCopied(): Element | null {
    return document.querySelector('[data-testid="chat-message-copied"]');
  }

  function queryFailed(): Element | null {
    return document.querySelector('[data-testid="chat-message-copy-failed"]');
  }

  function announcement(): string | null | undefined {
    return queryCopied()?.querySelector('[role="status"]')?.textContent;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['chat-message-copy-selection', 'Message a'],
    ['chat-message-copy-link', 'https://example.com/docs'],
  ])(
    'shows and announces Copied after %s, then clears it',
    async (itemTestId, expected) => {
      const writeText = jest.fn<Promise<boolean>, [string, Document]>(() =>
        Promise.resolve(true),
      );
      render(
        <Row id="a" writeText={writeText}>
          <p data-testid="text-a">Message a</p>
          <a data-testid="link-a" href="https://example.com/docs">
            docs
          </a>
        </Row>,
      );
      if (itemTestId === 'chat-message-copy-selection') {
        selectContents(byTestId('text-a'));
      }
      rightClick(
        byTestId(itemTestId === 'chat-message-copy-link' ? 'link-a' : 'text-a'),
      );
      click(menuItem(itemTestId));
      await flush();
      expect(writeText).toHaveBeenCalledWith(expected, document);
      expect(queryMenus()).toHaveLength(0);
      expect(queryCopied()?.textContent).toContain('Copied');
      expect(queryFailed()).toBeNull();
      // The live region fills once it is in place, so it is announced.
      expect(announcement()).toBe('');
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(announcement()).toBe('Copied');
      act(() => {
        jest.advanceTimersByTime(1400);
      });
      expect(queryCopied()).toBeNull();
    },
  );

  it('never takes focus from where the menu returned it', async () => {
    render(<Row id="a" writeText={() => Promise.resolve(true)} />);
    const row = byTestId('row-a');
    // jsdom clears the selection on focus, so select after focusing.
    act(() => row.focus());
    selectContents(byTestId('text-a'));
    keyDown(row, { key: 'F10', shiftKey: true });
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(queryCopied()).not.toBeNull();
    expect(document.activeElement).toBe(row);
    expect(queryCopied()?.querySelector('[tabindex]')).toBeNull();
  });

  it('returns menu focus to a message adopted into an auxiliary document', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    if (!doc) throw new Error('no auxiliary document');
    render(<Row id="a" writeText={() => Promise.resolve(true)} />);
    const row = byTestId('row-a');
    doc.body.append(container);
    try {
      act(() => row.focus());
      selectContents(row);
      keyDown(row, { key: 'F10', shiftKey: true });
      click(menuItem('chat-message-copy-selection', doc));
      await flush();
      expect(doc.activeElement).toBe(row);
    } finally {
      render(null);
      document.body.append(container);
      frame.remove();
    }
  });

  it.each(['mousedown', 'keydown', 'resize', 'blur'])(
    'dismisses success on %s and clears its timers',
    async (eventName) => {
      render(<Row id="a" writeText={() => Promise.resolve(true)} />);
      selectContents(byTestId('text-a'));
      rightClick(byTestId('text-a'));
      click(menuItem('chat-message-copy-selection'));
      await flush();
      expect(queryCopied()).not.toBeNull();
      act(() => {
        const target =
          eventName === 'resize' || eventName === 'blur' ? window : document;
        target.dispatchEvent(new Event(eventName, { bubbles: true }));
      });
      expect(queryCopied()).toBeNull();
      act(() => jest.advanceTimersByTime(1500));
      expect(queryCopied()).toBeNull();
    },
  );

  it('keeps success inside the owning viewport near an edge', async () => {
    const measure = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 200, 40));
    try {
      render(<Row id="a" writeText={() => Promise.resolve(true)} />);
      selectContents(byTestId('text-a'));
      rightClick(byTestId('text-a'), {
        clientX: window.innerWidth - 1,
        clientY: window.innerHeight - 1,
      });
      click(menuItem('chat-message-copy-selection'));
      await flush();
      expect(byTestId('chat-message-copied').style.left).toBe(
        `${window.innerWidth - 204}px`,
      );
      expect(byTestId('chat-message-copied').style.top).toBe(
        `${window.innerHeight - 44}px`,
      );
    } finally {
      measure.mockRestore();
    }
  });

  it('dismisses Copied on the next press in its document', async () => {
    render(<Row id="a" writeText={() => Promise.resolve(true)} />);
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(queryCopied()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'a' }),
      );
    });
    expect(queryCopied()).toBeNull();
  });

  it('keeps success and failure mutually exclusive', async () => {
    let succeed = true;
    render(<Row id="a" writeText={() => Promise.resolve(succeed)} />);
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(queryCopied()).not.toBeNull();

    succeed = false;
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    expect(queryCopied()).toBeNull();
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(queryFailed()).not.toBeNull();
    expect(queryCopied()).toBeNull();

    succeed = true;
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    expect(queryFailed()).toBeNull();
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(queryCopied()).not.toBeNull();
    expect(queryFailed()).toBeNull();
  });

  it('shows no Copied after a rejected write, and a later copy still succeeds', async () => {
    let reject = true;
    render(
      <Row
        id="a"
        writeText={() =>
          reject ? Promise.reject(new Error('denied')) : Promise.resolve(true)
        }
      />,
    );
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(queryFailed()).not.toBeNull();
    expect(queryCopied()).toBeNull();

    reject = false;
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(queryCopied()).not.toBeNull();
    expect(queryFailed()).toBeNull();
  });

  it('gives a repeat success its own status and announcement', async () => {
    render(<Row id="a" writeText={() => Promise.resolve(true)} />);
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    const first = queryCopied();
    expect(announcement()).toBe('Copied');

    // Same message, same point: still a fresh status with a fresh timeout.
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    await flush();
    expect(queryCopied()).not.toBe(first);
    expect(announcement()).toBe('');
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(announcement()).toBe('Copied');
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(queryCopied()).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(queryCopied()).toBeNull();
  });

  it('ignores a write that settles after a newer copy', async () => {
    const first = deferred();
    const second = deferred();
    const writes = [first, second];
    render(
      <Row
        id="a"
        writeText={() => writes.shift()?.promise ?? Promise.resolve(false)}
      />,
    );
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    second.resolve(true);
    await flush();
    expect(queryCopied()).not.toBeNull();
    first.resolve(false);
    await flush();
    expect(queryFailed()).toBeNull();
    expect(queryCopied()).not.toBeNull();
  });

  it('drops a pending result when the message changes, is disabled or unmounts', async () => {
    const pending = [deferred(), deferred(), deferred()];
    const writeText = (): Promise<boolean> =>
      pending.shift()?.promise ?? Promise.resolve(false);
    const [renamed, disabled, unmounted] = pending;
    render(<Row id="a" writeText={writeText} />);
    selectContents(byTestId('text-a'));
    rightClick(byTestId('text-a'));
    click(menuItem('chat-message-copy-selection'));
    render(<Row id="b" writeText={writeText} />);
    renamed?.resolve(true);
    await flush();
    expect(queryCopied()).toBeNull();

    selectContents(byTestId('text-b'));
    rightClick(byTestId('text-b'));
    click(menuItem('chat-message-copy-selection'));
    render(
      <ChatMessageContextMenuScope enabled={false}>
        <Row id="b" writeText={writeText} />
      </ChatMessageContextMenuScope>,
    );
    disabled?.resolve(true);
    await flush();
    render(<Row id="b" writeText={writeText} />);
    expect(queryCopied()).toBeNull();

    selectContents(byTestId('text-b'));
    rightClick(byTestId('text-b'));
    click(menuItem('chat-message-copy-selection'));
    render(null);
    unmounted?.resolve(true);
    await flush();
    expect(queryCopied()).toBeNull();
  });

  it('shows Copied in the auxiliary document the copy came from', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    if (!doc) throw new Error('no iframe document');
    const host = doc.createElement('div');
    doc.body.append(host);
    const auxRoot = createRoot(host);
    act(() =>
      auxRoot.render(<Row id="aux" writeText={() => Promise.resolve(true)} />),
    );
    selectContents(byTestId('text-aux', doc));
    rightClick(byTestId('text-aux', doc));
    click(menuItem('chat-message-copy-selection', doc));
    await flush();
    expect(
      doc.querySelector('[data-testid="chat-message-copied"]'),
    ).not.toBeNull();
    expect(queryCopied()).toBeNull();
    act(() => {
      document.dispatchEvent(new Event('keydown'));
    });
    expect(
      doc.querySelector('[data-testid="chat-message-copied"]'),
    ).not.toBeNull();
    act(() => {
      doc.dispatchEvent(new Event('keydown'));
    });
    expect(doc.querySelector('[data-testid="chat-message-copied"]')).toBeNull();
    act(() => auxRoot.unmount());
    frame.remove();
  });
});
