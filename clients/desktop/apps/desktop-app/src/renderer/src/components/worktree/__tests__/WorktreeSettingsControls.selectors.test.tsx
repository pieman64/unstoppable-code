/** @jest-environment jsdom */

import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AddToWorktreeActionControls,
  SourceWorktreePicker,
} from '../WorktreeSettingsControls';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const WORKTREES = [
  { id: 'wt-one', branchName: 'feature/one' },
  { id: 'wt-two', branchName: 'feature/two' },
];

function SourceHarness({
  onChange,
}: {
  onChange: (value: string | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | undefined>('wt-two');
  return (
    <SourceWorktreePicker
      selectedWorktreeId={selected}
      worktrees={WORKTREES}
      open={open}
      onOpenChange={setOpen}
      onChange={(value) => {
        setSelected(value);
        onChange(value);
      }}
      helpTooltipId="source-help"
    />
  );
}

describe('worktree selector floating menus', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('ports the source-worktree listbox, focuses the selection, and closes immediately', () => {
    const onChange = jest.fn();
    act(() => root.render(<SourceHarness onChange={onChange} />));
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="source-worktree-picker-trigger"]',
    );

    act(() => trigger?.click());
    const menu = document.querySelector(
      '[data-testid="source-worktree-picker-menu"]',
    );
    const selected = document.querySelector<HTMLButtonElement>(
      '[data-testid="source-worktree-picker-option-wt-two"]',
    );
    expect(container.contains(menu)).toBe(false);
    expect(menu?.className).toContain('canopy-floating-menu');
    expect(menu?.getAttribute('role')).toBe('listbox');
    expect(document.activeElement).toBe(selected);
    expect(menu?.className).toContain('canopy-picker-menu');
    expect(selected?.className).toContain('h-8');
    expect(selected?.className).not.toContain('min-h-10');
    expect(selected?.querySelector('.min-w-0.flex-1')).not.toBeNull();
    expect(
      selected?.querySelector('[data-picker-selected-check="true"]'),
    ).not.toBeNull();
    expect(selected?.querySelector('.leading-4')).not.toBeNull();
    expect(selected?.querySelector('.leading-3')).not.toBeNull();

    act(() => selected?.click());
    expect(onChange).toHaveBeenCalledWith('wt-two');
    expect(
      document.querySelector('[data-testid="source-worktree-picker-menu"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the split action intact while sharing picker keyboard semantics', () => {
    const onAdd = jest.fn();
    function Harness(): JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <AddToWorktreeActionControls
          show
          sourceInspectWorktreeId={undefined}
          worktrees={WORKTREES}
          feedback={{ phase: 'idle' }}
          buttonLabel="Add to worktree"
          disabled={false}
          existingDropdownOpen={open}
          onExistingDropdownOpenChange={setOpen}
          onAddToWorktree={onAdd}
        />
      );
    }
    act(() => root.render(<Harness />));
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="add-to-existing-worktree-trigger"]',
    );
    act(() => trigger?.click());

    const first = document.querySelector<HTMLButtonElement>(
      '[data-testid="add-to-existing-worktree-option-wt-one"]',
    );
    expect(document.activeElement).toBe(first);
    expect(first?.className).toContain('h-8');
    act(() => {
      first?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onAdd).toHaveBeenCalledWith({
      mode: 'existing',
      worktreeId: 'wt-one',
    });
    expect(
      document.querySelector('[data-testid="add-to-existing-worktree-menu"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
