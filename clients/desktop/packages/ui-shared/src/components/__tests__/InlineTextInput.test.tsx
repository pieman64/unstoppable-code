/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InlineTextInput } from '../InlineTextInput';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const setValue = (input: HTMLInputElement, value: string): void => {
  // React reads the native setter, so set the value through it.
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const press = (
  input: HTMLInputElement,
  key: string,
  init: KeyboardEventInit = {},
): void => {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, ...init }),
  );
};

describe('InlineTextInput', () => {
  let container: HTMLDivElement;
  let root: Root;
  let commits: string[];
  let cancels: number;

  function Harness(): JSX.Element {
    const [title, setTitle] = useState('Fix login redirect');
    return (
      <>
        <InlineTextInput
          aria-label="Chat title"
          value={title}
          onCommit={(next) => {
            commits.push(next);
            setTitle(next);
          }}
          onCancel={() => {
            cancels += 1;
          }}
        />
        <span data-testid="title">{title}</span>
        <button type="button">Elsewhere</button>
      </>
    );
  }

  function input(): HTMLInputElement {
    const element = container.querySelector('input');
    if (!element) throw new Error('No input');
    return element;
  }

  beforeEach(() => {
    commits = [];
    cancels = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('has no box or fill at rest or on hover, and the field focus edge while editing', () => {
    const classes = input().className.split(' ');
    expect(classes).toContain('bg-transparent');
    expect(classes).not.toContain('hover:bg-subtle');
    expect(classes).toContain('focus:shadow-field-focus');
    expect(classes).toContain('rounded-row');
    expect(classes).not.toContain('shadow-field');
    expect(input().getAttribute('aria-label')).toBe('Chat title');
  });

  it('commits on Enter and leaves the field', () => {
    act(() => input().focus());
    act(() => setValue(input(), 'Fix logout redirect'));
    act(() => press(input(), 'Enter'));
    expect(commits).toEqual(['Fix logout redirect']);
    expect(document.activeElement).not.toBe(input());
    expect(container.textContent).toContain('Fix logout redirect');
  });

  it('cancels on Escape and restores the saved value', () => {
    act(() => input().focus());
    act(() => setValue(input(), 'Half typed'));
    act(() => press(input(), 'Escape'));
    expect(commits).toEqual([]);
    expect(cancels).toBe(1);
    expect(input().value).toBe('Fix login redirect');
    expect(document.activeElement).not.toBe(input());
  });

  // Enter confirms and Escape dismisses an input-method candidate. Safari
  // reports those keys with keyCode 229 and isComposing false.
  it.each([
    ['Enter while composing', 'Enter', { isComposing: true }],
    ['Escape while composing', 'Escape', { isComposing: true }],
    ['Enter with keyCode 229', 'Enter', { keyCode: 229 }],
  ])('keeps editing on %s', (_name, key, init) => {
    act(() => input().focus());
    act(() => setValue(input(), 'へんかん'));
    act(() => press(input(), key, init));
    expect(commits).toEqual([]);
    expect(cancels).toBe(0);
    expect(input().value).toBe('へんかん');
    expect(document.activeElement).toBe(input());
  });

  it('commits on blur', () => {
    act(() => input().focus());
    act(() => setValue(input(), 'Renamed by clicking away'));
    act(() => input().blur());
    expect(commits).toEqual(['Renamed by clicking away']);
  });

  it('does not commit an unchanged value', () => {
    act(() => input().focus());
    act(() => press(input(), 'Enter'));
    act(() => input().focus());
    act(() => input().blur());
    expect(commits).toEqual([]);
  });

  describe('when a newer saved value arrives while editing', () => {
    let rename: (next: string) => void;

    function Renamed(): JSX.Element {
      const [title, setTitle] = useState('New chat');
      rename = setTitle;
      return (
        <InlineTextInput
          aria-label="Chat title"
          value={title}
          onCommit={(next) => {
            commits.push(next);
            setTitle(next);
          }}
        />
      );
    }

    beforeEach(() => {
      act(() => root.render(<Renamed />));
      act(() => input().focus());
      // A generated title lands while the field has focus.
      act(() => rename('Fix login redirect'));
    });

    it('shows it and never commits the older value over it', () => {
      expect(input().value).toBe('Fix login redirect');
      act(() => input().blur());
      expect(commits).toEqual([]);
      expect(input().value).toBe('Fix login redirect');
    });

    it('still commits what the person typed', () => {
      act(() => setValue(input(), 'Fix login redirect loop'));
      act(() => rename('Something else'));
      expect(input().value).toBe('Fix login redirect loop');
      act(() => input().blur());
      expect(commits).toEqual(['Fix login redirect loop']);
    });

    it('commits the text the person typed back to, even if it was the old value', () => {
      // The person edits the new title back to the one they had: that is
      // their choice, not an untouched field.
      act(() => setValue(input(), 'New chat'));
      expect(input().value).toBe('New chat');
      act(() => input().blur());
      expect(commits).toEqual(['New chat']);
    });
  });

  it('follows a new saved value while not editing', () => {
    function Outer(): JSX.Element {
      const [title, setTitle] = useState('One');
      return (
        <>
          <InlineTextInput
            aria-labelledby="heading"
            value={title}
            onCommit={setTitle}
          />
          <button type="button" onClick={() => setTitle('Two')}>
            Change
          </button>
        </>
      );
    }
    act(() => root.render(<Outer />));
    act(() => container.querySelector('button')?.click());
    expect(input().value).toBe('Two');
    expect(input().getAttribute('aria-labelledby')).toBe('heading');
  });
});
