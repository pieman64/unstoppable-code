import { renderToString } from 'react-dom/server';
import { ChevronDownMediumIcon } from '../../icons/AppIcons';
import { HiddenItemsDisclosureRow } from '../HiddenItemsDisclosureRow';

describe('HiddenItemsDisclosureRow', () => {
  it('reuses project row geometry for its icon, label, and counter', () => {
    const html = renderToString(
      <HiddenItemsDisclosureRow
        label="Hidden Worktrees"
        count={2}
        expanded={false}
        onToggle={() => {}}
        dataTestId="hidden-toggle"
      />,
    );

    expect(html).toContain('data-testid="hidden-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('h-8 py-0 pl-1.5 pr-1');
    expect(html).toContain(
      'inline-flex h-5 w-5 shrink-0 items-center justify-center fg-secondary',
    );
    expect(html).toContain('style="width:14px;height:14px"');
    expect(html).toContain('data-testid="workspace-section-counter"');
    expect(html).toContain(
      'ml-auto inline-flex h-5 w-6 shrink-0 items-center justify-end whitespace-nowrap pr-1 text-2xs fg-quaternary',
    );
    expect(html.match(/aria-label="Expand Hidden Worktrees"/g)).toHaveLength(1);
    expect(html).toContain('-rotate-90');
    expect(html).not.toContain('group-hover/sidebar-item:hidden');
    expect(html).not.toContain('rounded-full bg-secondary');
  });

  it('reports and illustrates the expanded state on one disclosure control', () => {
    const html = renderToString(
      <HiddenItemsDisclosureRow
        label="Hidden Workspaces"
        count={3}
        expanded
        onToggle={() => {}}
      />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html.match(/aria-label="Collapse Hidden Workspaces"/g)).toHaveLength(
      1,
    );
    expect(html).not.toContain('-rotate-90');
  });

  it("draws the sidebar's one disclosure chevron: down, turned right while closed", () => {
    // Section headers, Show all, and this row share ChevronDownMediumIcon so
    // one glyph component carries disclosure across the rail.
    const closed = renderToString(
      <HiddenItemsDisclosureRow
        label="Hidden Workspaces"
        count={3}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    const open = renderToString(
      <HiddenItemsDisclosureRow
        label="Hidden Workspaces"
        count={3}
        expanded
        onToggle={() => {}}
      />,
    );
    expect(closed).toContain('-rotate-90');
    expect(open).not.toContain('rotate-90');
    const glyphPath = /\sd="([^"]+)"/.exec(
      renderToString(<ChevronDownMediumIcon size={16} />),
    )?.[1];
    expect(glyphPath).toBeTruthy();
    expect(closed).toContain(`d="${glyphPath ?? ''}"`);
  });
});
