/**
 * @jest-environment jsdom
 */
import { act, createRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Select } from '../Field';
import { InlineTextInput } from '../InlineTextInput';
import { SearchField } from '../SearchField';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
});

const render = (node: JSX.Element): void => {
  act(() => root.render(node));
};

describe('Select', () => {
  it('forwards its ref to the trigger and exposes the chosen value', () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Select
        ref={ref}
        aria-label="Environment"
        options={[
          { value: 'staging', label: 'Staging' },
          { value: 'production', label: 'Production' },
        ]}
        value="production"
        onValueChange={() => undefined}
      />,
    );
    expect(ref.current?.getAttribute('role')).toBe('combobox');
    expect(ref.current?.getAttribute('data-value')).toBe('production');
    act(() => ref.current?.click());
    const options = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).map((option) => option.getAttribute('data-value'));
    expect(options).toEqual(['staging', 'production']);
  });
});

describe('InlineTextInput', () => {
  it('grows with its text and keeps the type of the text it replaces', () => {
    render(
      <h1 className="text-xl font-semibold">
        <InlineTextInput
          aria-label="Workflow name"
          value="Nightly build"
          onCommit={() => undefined}
          grow
          size="inherit"
        />
      </h1>,
    );
    const input = container.querySelector('input');
    const classes = input?.className.split(' ') ?? [];
    expect(classes).not.toContain('w-full');
    // No size, weight, line or height of its own: the input inherits the
    // heading's font (inputs inherit `font` in the app's base styles), so
    // the text does not move or resize when editing starts.
    expect(
      classes.filter((c) =>
        /^(text-(xs|s|m|l|xl)|font-|leading-|h-\d)/.test(c),
      ),
    ).toEqual([]);
    expect(input?.getAttribute('size')).toBe(String('Nightly build'.length));
  });

  it('keeps the 28px row edit by default', () => {
    render(
      <InlineTextInput
        aria-label="Title"
        value="A"
        onCommit={() => undefined}
      />,
    );
    const classes =
      container.querySelector('input')?.className.split(' ') ?? [];
    expect(classes).toEqual(
      expect.arrayContaining(['h-7', 'text-s', 'w-full']),
    );
  });
});

describe('SearchField', () => {
  it('keeps a textbox role when the host asks for a text input', () => {
    render(
      <SearchField
        inputType="text"
        value=""
        onValueChange={() => undefined}
        aria-label="Find in page"
      />,
    );
    expect(container.querySelector('input')?.type).toBe('text');
  });
});
