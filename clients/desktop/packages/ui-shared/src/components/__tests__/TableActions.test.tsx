/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TableActionButton, TableActionsCell } from '../TableActions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function button(): HTMLButtonElement {
  const found = container.querySelector('button');
  if (!found) throw new Error('no button rendered');
  return found;
}

describe('TableActionButton', () => {
  it('uses the label as both accessible name and tooltip, and wires the testid', () => {
    render(
      <TableActionButton
        label="Duplicate"
        onClick={(): void => {}}
        testId="row-duplicate"
      >
        <svg />
      </TableActionButton>,
    );
    expect(button().getAttribute('aria-label')).toBe('Duplicate');
    expect(button().getAttribute('data-testid')).toBe('row-duplicate');
    // Native `title` is banned on these pages — the shared `Tooltip` renders it.
    expect(button().getAttribute('title')).toBeNull();
  });

  it('calls onClick and stops the event from reaching the surrounding row', () => {
    const onClick = jest.fn();
    const onRowClick = jest.fn();
    render(
      <div onClick={onRowClick}>
        <TableActionButton label="Edit" onClick={onClick}>
          <svg />
        </TableActionButton>
      </div>,
    );
    act(() => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('does not fire when disabled', () => {
    const onClick = jest.fn();
    render(
      <TableActionButton label="Delete" onClick={onClick} disabled>
        <svg />
      </TableActionButton>,
    );
    expect(button().disabled).toBe(true);
    act(() => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders the armed destructive tone as a filled state', () => {
    render(
      <TableActionButton
        label="Confirm delete"
        onClick={(): void => {}}
        tone="destructive"
      >
        <svg />
      </TableActionButton>,
    );
    // Solid fill, not the old 15%-alpha tint: the armed state has to be
    // legible without hovering for the tooltip label.
    expect(button().className).toContain('bg-destructive');
    expect(button().className).not.toContain('bg-destructive-subtle');
    expect(button().className).toContain('fg-emphasis');
    expect(button().className).toContain('ring-2');
    expect(button().className).toContain('ring-line-destructive/40');
  });

  it('omits aria-pressed unless a toggle state is supplied', () => {
    render(
      <TableActionButton label="Enable pipeline" onClick={(): void => {}}>
        <svg />
      </TableActionButton>,
    );
    expect(button().hasAttribute('aria-pressed')).toBe(false);

    render(
      <TableActionButton
        label="Disable pipeline"
        onClick={(): void => {}}
        ariaPressed
      >
        <svg />
      </TableActionButton>,
    );
    expect(button().getAttribute('aria-pressed')).toBe('true');
  });
});

describe('TableActionsCell', () => {
  it('isolates clicks from the surrounding row', () => {
    const onRowClick = jest.fn();
    render(
      <div onClick={onRowClick}>
        <TableActionsCell testId="actions">
          <span>child</span>
        </TableActionsCell>
      </div>,
    );
    const cell = container.querySelector('[data-testid="actions"]');
    expect(cell?.className).toContain('justify-end');
    act(() => {
      cell?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('reports blur only when focus leaves the group entirely', () => {
    const onFocusLeave = jest.fn();
    render(
      <TableActionsCell testId="actions" onFocusLeave={onFocusLeave}>
        <TableActionButton label="A" onClick={(): void => {}} testId="a">
          <svg />
        </TableActionButton>
        <TableActionButton label="B" onClick={(): void => {}} testId="b">
          <svg />
        </TableActionButton>
      </TableActionsCell>,
    );
    const a = container.querySelector<HTMLButtonElement>('[data-testid="a"]');
    const b = container.querySelector<HTMLButtonElement>('[data-testid="b"]');
    // Moving between siblings keeps focus inside the group.
    act(() => {
      a?.focus();
      b?.focus();
    });
    expect(onFocusLeave).not.toHaveBeenCalled();

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
    });
    expect(onFocusLeave).toHaveBeenCalled();
    outside.remove();
  });

  it('dismisses on Escape without requiring focus to leave the row', () => {
    const onEscape = jest.fn(() => true);
    render(
      <TableActionsCell testId="actions" onEscape={onEscape}>
        <TableActionButton label="A" onClick={(): void => {}} testId="a">
          <svg />
        </TableActionButton>
      </TableActionsCell>,
    );
    const a = container.querySelector<HTMLButtonElement>('[data-testid="a"]');
    act(() => {
      a?.focus();
      a?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('keeps Escape bubbling when the consumer does not consume it', () => {
    // A table rendered inside a drawer or dialog must not lose Escape-to-close
    // just because focus happens to sit in an action group with nothing armed.
    const ancestorEscape = jest.fn();
    const onEscape = jest.fn(() => false);
    render(
      <div onKeyDown={ancestorEscape}>
        <TableActionsCell testId="actions" onEscape={onEscape}>
          <TableActionButton label="A" onClick={(): void => {}} testId="a">
            <svg />
          </TableActionButton>
        </TableActionsCell>
      </div>,
    );
    const a = container.querySelector<HTMLButtonElement>('[data-testid="a"]');
    act(() => {
      a?.focus();
      a?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(ancestorEscape).toHaveBeenCalledTimes(1);
  });

  it('stops Escape propagation only when the consumer consumes it', () => {
    const ancestorEscape = jest.fn();
    const onEscape = jest.fn(() => true);
    render(
      <div onKeyDown={ancestorEscape}>
        <TableActionsCell testId="actions" onEscape={onEscape}>
          <TableActionButton label="A" onClick={(): void => {}} testId="a">
            <svg />
          </TableActionButton>
        </TableActionsCell>
      </div>,
    );
    const a = container.querySelector<HTMLButtonElement>('[data-testid="a"]');
    act(() => {
      a?.focus();
      a?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(ancestorEscape).not.toHaveBeenCalled();
  });

  it('ignores non-Escape keys', () => {
    const onEscape = jest.fn();
    render(
      <TableActionsCell testId="actions" onEscape={onEscape}>
        <TableActionButton label="A" onClick={(): void => {}} testId="a">
          <svg />
        </TableActionButton>
      </TableActionsCell>,
    );
    const a = container.querySelector<HTMLButtonElement>('[data-testid="a"]');
    act(() => {
      a?.focus();
      a?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('applies a solid, non-hover-dependent armed style to the destructive tone', () => {
    render(
      <TableActionsCell testId="actions">
        <TableActionButton
          label="Confirm delete"
          onClick={(): void => {}}
          tone="destructive"
          testId="armed"
        >
          <svg />
        </TableActionButton>
      </TableActionsCell>,
    );
    const armed = container.querySelector<HTMLButtonElement>(
      '[data-testid="armed"]',
    );
    // The armed state must be legible without hovering (DESIGN.md: do not hide
    // required feedback behind hover), so assert the solid fill + ring rather
    // than the previous faint `bg-destructive-subtle` tint.
    expect(armed?.className).toContain('bg-destructive');
    expect(armed?.className).not.toContain('bg-destructive-subtle');
    expect(armed?.className).toContain('ring-2');
  });
});
