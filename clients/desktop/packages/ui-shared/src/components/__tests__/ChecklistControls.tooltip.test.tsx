/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChecklistAction } from '../ChecklistControls';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * `tooltipLabel` exists so a caller whose row truncates its own text can reveal
 * it through the action's tooltip — the action's stretched `fillRow` overlay
 * owns the hit test across the row, so it is the only hover a reader can reach.
 * The contract that makes that safe is that the accessible name keeps
 * describing the ACTION: a screen reader announcing the row's text instead of
 * what the button does would be a regression, and it is invisible in a DOM
 * snapshot, so it is pinned here at the component that owns the prop.
 */
describe('ChecklistAction tooltipLabel', () => {
  let container: HTMLDivElement;
  let root: Root;

  const hoverTrigger = (): void => {
    const button = container.querySelector<HTMLButtonElement>('button');
    act(() => {
      button?.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('shows tooltipLabel on hover while the accessible name stays the action', () => {
    act(() => {
      root.render(
        <ChecklistAction
          fillRow
          variant="compact"
          label="Import from Claude and Codex"
          tooltipLabel="Import your Claude and Codex projects"
          testId="checklist-action"
          onClick={jest.fn()}
        />,
      );
    });
    hoverTrigger();
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Import your Claude and Codex projects',
    );
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Import from Claude and Codex',
    );
  });

  it('falls back to the label when no tooltipLabel is given', () => {
    act(() => {
      root.render(
        <ChecklistAction
          fillRow
          variant="compact"
          label="Import from Claude and Codex"
          testId="checklist-action"
          onClick={jest.fn()}
        />,
      );
    });
    hoverTrigger();
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Import from Claude and Codex',
    );
  });
});
