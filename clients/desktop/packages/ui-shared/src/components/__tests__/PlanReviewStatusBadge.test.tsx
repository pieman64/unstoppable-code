/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PlanReviewStatusBadge,
  PlanStatusNote,
} from '../PlanReviewStatusBadge';

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

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe('PlanReviewStatusBadge', () => {
  it.each([
    ['pending', 'Pending', 'warning'],
    ['approved', 'Approved', 'success'],
    ['dismissed', 'Dismissed', 'neutral'],
    ['implementing', 'Implementing', 'info'],
    ['implemented', 'Implemented', 'success'],
    ['unknown', 'Archived', 'neutral'],
  ] as const)('renders %s as a %s capsule', (kind, label, tone) => {
    act(() =>
      root.render(
        <PlanReviewStatusBadge status={{ kind, label }} data-testid="badge" />,
      ),
    );
    const badge = byTestId('badge');
    expect(badge?.textContent).toBe(label);
    expect(badge?.getAttribute('data-badge-tone')).toBe(tone);
  });

  it('renders nothing without a label', () => {
    act(() =>
      root.render(
        <PlanReviewStatusBadge status={{ kind: 'unknown', label: '' }} />,
      ),
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('PlanStatusNote', () => {
  it('renders the outcome and a link that does not bubble to the card', () => {
    const onSelect = jest.fn();
    const onCardClick = jest.fn();
    act(() =>
      root.render(
        <div onClick={onCardClick}>
          <PlanStatusNote
            text="Workflow failed"
            link={{ label: 'View run', onSelect, 'data-testid': 'note-link' }}
            data-testid="note"
          />
        </div>,
      ),
    );
    expect(byTestId('note')?.textContent).toBe('Workflow failed·View run');
    act(() => byTestId('note-link')?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('renders nothing without text or a link', () => {
    act(() => root.render(<PlanStatusNote />));
    expect(container.innerHTML).toBe('');
  });
});
