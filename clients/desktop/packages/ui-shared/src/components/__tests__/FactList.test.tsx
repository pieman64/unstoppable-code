/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Fact, FactList } from '../FactList';
import { ValueRow, ValueRows } from '../settings/ValueRows';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

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
});

function byTestId(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}

describe('FactList', () => {
  it('keeps a label column beside the values by default', () => {
    act(() =>
      root.render(
        <FactList dataTestId="list">
          <Fact label="Model" testId="fact">
            Opus
          </Fact>
        </FactList>,
      ),
    );
    expect(byTestId('list').className).toContain(
      'grid-cols-[auto_minmax(0,1fr)]',
    );
    // The fact itself adds no box, so its label and value sit in the grid.
    expect(byTestId('fact').className).toBe('contents');
  });

  it('stacks each label above its value in the requested columns', () => {
    act(() =>
      root.render(
        <FactList
          layout="stacked"
          columns={4}
          valueSize="large"
          dataTestId="list"
        >
          <Fact label="Cost" testId="fact" dataTestId="value">
            $12.00
          </Fact>
        </FactList>,
      ),
    );
    expect(byTestId('list').className).toContain('grid-cols-2 sm:grid-cols-4');
    expect(byTestId('list').className).not.toContain('minmax');
    const fact = byTestId('fact');
    expect(fact.className).toContain('flex-col');
    expect(fact.firstElementChild?.tagName).toBe('DT');
    expect(byTestId('value').className).toContain('text-lg font-semibold');
  });

  it('applies the list value ink unless a fact sets its own, and mono labels', () => {
    act(() =>
      root.render(
        <FactList valueTone="secondary" labelMono>
          <Fact label="name" dataTestId="quiet" labelTestId="label">
            a
          </Fact>
          <Fact label="error" valueTone="destructive" dataTestId="loud">
            b
          </Fact>
        </FactList>,
      ),
    );
    expect(byTestId('quiet').className).toContain('fg-secondary');
    expect(byTestId('loud').className).toContain('fg-destructive');
    expect(byTestId('label').className).toContain('font-mono');
  });

  it('keeps a row value and its trailing control on one line', () => {
    act(() =>
      root.render(
        <FactList>
          <Fact label="Directory" fit="row" dataTestId="value">
            <span>/tmp/worktree</span>
            <button type="button">Copy</button>
          </Fact>
        </FactList>,
      ),
    );
    const value = byTestId('value');
    expect(value.className).toContain('flex items-center');
    expect(value.className).not.toContain('flex-wrap');
  });
});

describe('ValueRows', () => {
  it('renders each figure as a boxless Settings row with its value trailing', () => {
    act(() =>
      root.render(
        <ValueRows dataTestId="rows">
          <ValueRow
            label="Input"
            note="Part of output"
            value="1.2K"
            share="40%"
            swatch="var(--fg-secondary)"
            valueTestId="value"
          />
        </ValueRows>,
      ),
    );
    const rows = byTestId('rows');
    expect(rows.getAttribute('data-surface')).toBe('list');
    // No box and no padding around a row: each row is its own 40px line.
    expect(rows.className).not.toContain('py-3');
    expect(rows.className).not.toContain('bg-secondary');
    expect(rows.textContent).toBe('InputPart of output1.2K40%');
    expect(byTestId('value').className).toContain('tabular-nums');
    expect(rows.querySelector('.min-h-10')).not.toBeNull();
    expect(rows.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });
});
