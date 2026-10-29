/** @jest-environment jsdom */

/**
 * Every ••• in the sidebar is one control: the Central glyph at 16px in the
 * 24px rail button, with the `bg-subtle` hover square the section headers
 * use, and one tooltip. Rows used to draw it at 12px with an ink-only hover
 * while the headers drew it at 16px on a hover square.
 */
import { renderToString } from 'react-dom/server';
import { WorkEntryRow, WorkEntryRowMenuItems } from '../WorkEntryRow';
import { WorktreeActionsMenu } from '../WorktreeActionsMenu';
import { WorkspaceSectionHeader } from '../WorkspaceSectionHeader';

function moreButton(html: string, testId: string): HTMLButtonElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  const button = host.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  );
  if (button === null) throw new Error(`${testId} not rendered`);
  return button;
}

const SHARED_SHAPE = ['h-6', 'w-6', 'rounded-md', 'hover:bg-subtle'];

function expectSidebarMore(button: HTMLButtonElement): void {
  for (const shape of SHARED_SHAPE) {
    expect(button.classList.contains(shape)).toBe(true);
  }
  expect(button.querySelector('svg')?.getAttribute('width')).toBe('14px');
}

describe('sidebar ••• buttons', () => {
  it('draws the work entry row ••• like the section headers', () => {
    const button = moreButton(
      renderToString(
        <WorkEntryRow
          title="Plan the launch"
          testId="entry"
          entryId="e1"
          renderMenuItems={(menu) => (
            <WorkEntryRowMenuItems
              menu={menu}
              onRename={(): void => undefined}
            />
          )}
        />,
      ),
      'entry-menu',
    );
    expectSidebarMore(button);
    expect(button.getAttribute('aria-label')).toBe('More actions');
  });

  it('draws the worktree row ••• like the section headers', () => {
    const button = moreButton(
      renderToString(
        <WorktreeActionsMenu
          items={[
            {
              key: 'set-label',
              label: 'Set label',
              icon: <span>L</span>,
              onSelect: (): void => undefined,
            },
          ]}
          accessibleLabel="Actions for feature"
          triggerTestId="trigger"
          menuTestId="menu"
        />,
      ),
      'trigger',
    );
    expectSidebarMore(button);
  });

  it('draws the project header ••• like the section headers', () => {
    const button = moreButton(
      renderToString(
        <WorkspaceSectionHeader
          name="Canopy"
          workspaceType="single-repo"
          worktreeCount={2}
          collapsed={false}
          textScale="sidebar"
          onToggleCollapse={(): void => undefined}
          onOptions={(): void => undefined}
          optionsButtonDataAttrs={{ 'data-testid': 'options' }}
        />,
      ),
      'options',
    );
    expectSidebarMore(button);
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
  });
});
