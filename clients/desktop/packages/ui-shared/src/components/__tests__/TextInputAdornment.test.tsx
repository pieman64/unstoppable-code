/**
 * @jest-environment jsdom
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TextInput, type TextInputDensity } from '../Field';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('TextInput leading and trailing', () => {
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

  const BOX: Record<TextInputDensity, readonly string[]> = {
    default: ['min-h-9', 'rounded-lg'],
    compact: ['h-7', 'rounded-row'],
    settings: ['h-7', 'rounded-row'],
  };

  it.each(['default', 'compact', 'settings'] as const)(
    'draws the %s field box around the adornments, never a capsule',
    (density) => {
      act(() =>
        root.render(
          <TextInput
            density={density}
            leading="@"
            trailing="days"
            className="w-40"
            aria-label="Username"
          />,
        ),
      );
      const input = container.querySelector('input');
      const box = input?.parentElement;
      const classes = box?.className.split(' ') ?? [];
      expect(classes).toEqual(expect.arrayContaining([...BOX[density]]));
      expect(classes).toContain('shadow-field');
      expect(classes).toContain('has-[input:focus]:shadow-field-focus');
      expect(classes).not.toContain('rounded-full');
      // Placement goes on the box; the input itself carries no edge.
      expect(classes).toContain('w-40');
      expect(input?.className).not.toContain('shadow-field');
      const [leading, trailing] = Array.from(
        box?.querySelectorAll('[data-field-adornment]') ?? [],
      );
      expect(leading?.textContent).toBe('@');
      expect(leading?.className).toContain('fg-tertiary');
      expect(trailing?.textContent).toBe('days');
      expect(box?.firstElementChild).toBe(leading);
      expect(box?.lastElementChild).toBe(trailing);
    },
  );

  it('keeps the ref, id and invalid edge on the real input', () => {
    const ref = createRef<HTMLInputElement>();
    act(() =>
      root.render(
        <TextInput
          ref={ref}
          id="username"
          density="settings"
          leading="@"
          aria-invalid
          defaultValue="daniil"
        />,
      ),
    );
    const input = container.querySelector('input');
    expect(ref.current).toBe(input);
    expect(input?.id).toBe('username');
    expect(input?.value).toBe('daniil');
    expect(input?.parentElement?.className).toContain(
      'has-[input[aria-invalid=true]]:shadow-field-invalid',
    );
  });

  it('renders the plain input when there is no adornment', () => {
    act(() => root.render(<TextInput className="w-40" />));
    const input = container.querySelector('input');
    expect(input?.parentElement).toBe(container);
    expect(input?.className).toContain('shadow-field');
  });

  it.each(['default', 'settings'] as const)(
    'puts a %s text adornment on the value line: same size, shared baseline',
    (density) => {
      act(() =>
        root.render(
          <TextInput
            density={density}
            leading="@"
            trailing={30}
            defaultValue="daniil"
            aria-label="Username"
          />,
        ),
      );
      const input = container.querySelector('input');
      const box = input?.parentElement;
      expect(box?.className.split(' ')).toContain('items-baseline');
      const adornments = Array.from(
        box?.querySelectorAll('[data-field-adornment]') ?? [],
      );
      for (const adornment of adornments) {
        expect(adornment.getAttribute('data-field-adornment-kind')).toBe(
          'text',
        );
        // No size or line-height of its own: it inherits the value's.
        expect(adornment.className).not.toMatch(/\btext-(xs|s|2xs)\b/);
        expect(adornment.className).not.toMatch(/\bleading-/);
        expect(adornment.className).not.toContain('items-center');
      }
      expect(input?.className).not.toMatch(/\btext-(xs|s|2xs)\b/);
    },
  );

  it('centres an icon adornment instead of putting it on the baseline', () => {
    act(() =>
      root.render(
        <TextInput
          density="compact"
          leading={<svg data-testid="glyph" />}
          aria-label="Filter"
        />,
      ),
    );
    const adornment = container.querySelector('[data-field-adornment]');
    expect(adornment?.getAttribute('data-field-adornment-kind')).toBe('icon');
    expect(adornment?.className.split(' ')).toEqual(
      expect.arrayContaining(['self-center', 'flex', 'items-center']),
    );
  });
});
