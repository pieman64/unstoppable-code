/**
 * Every small trailing number in the sidebar (a row's age, a project's
 * worktree count, a collapsed group's count, the "Archived and deleted" count)
 * is one kind of label, so they share one cell: the same size, ink, digits,
 * line height and right edge. They had drifted into two styles: ages in quiet
 * right-aligned proportional digits, counts brighter, tabular and centred in
 * their box, so a column of ages ending in a count wobbled at the bottom.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { ArchivedContainersNavLink } from '../ArchivedContainersNavLink';
import { SidebarRowAge } from '../SidebarRowAge';
import { WorkspaceSectionHeader } from '../WorkspaceSectionHeader';
import * as sidebarItemClasses from '../sidebar-item-classes';

function classesOfTestId(markup: string, testId: string): string[] {
  const match = new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(
    markup,
  )?.[0];
  return /class="([^"]+)"/.exec(match ?? '')?.[1]?.split(' ') ?? [];
}

// The type and alignment every trailing label has to agree on. Proportional
// digits on purpose: these are right-aligned labels, not a column of numbers
// read against each other.
const SHARED_TRAILING_CLASSES = [
  'w-6',
  'justify-end',
  'pr-1',
  'whitespace-nowrap',
  'text-2xs',
  'fg-quaternary',
];
const DIVERGENT_CLASSES = ['tabular-nums', 'fg-tertiary', 'justify-center'];

describe('sidebar trailing labels', () => {
  it('has one trailing cell constant', () => {
    expect(
      Object.keys(sidebarItemClasses).filter((name) =>
        /TRAILING|COUNTER/.test(name),
      ),
    ).toEqual(['SIDEBAR_ROW_TRAILING_CELL_CLASSNAME']);
    expect(sidebarItemClasses.SIDEBAR_ROW_TRAILING_CELL_CLASSNAME).toBe(
      'ml-auto inline-flex h-5 w-6 shrink-0 items-center justify-end whitespace-nowrap pr-1 text-2xs fg-quaternary',
    );
  });

  it('draws ages and counts with the same classes', () => {
    const age = classesOfTestId(
      renderToStaticMarkup(
        <SidebarRowAge
          lastActivityAt={Date.now() - 5 * 60_000}
          hidesForActions={false}
          testId="age"
        />,
      ),
      'age',
    );
    const projectCount = classesOfTestId(
      renderToStaticMarkup(
        <WorkspaceSectionHeader
          name="Workspace One"
          workspaceType="single-repo"
          worktreeCount={17}
          collapsed
          textScale="sidebar"
          onToggleCollapse={() => {}}
        />,
      ),
      'workspace-section-counter',
    );
    const archivedRowCount = classesOfTestId(
      renderToStaticMarkup(
        <ArchivedContainersNavLink
          count={17}
          selected={false}
          onOpen={() => {}}
          testId="link"
          size="row"
        />,
      ),
      'link-count',
    );
    const archivedCompactCount = classesOfTestId(
      renderToStaticMarkup(
        <ArchivedContainersNavLink
          count={17}
          selected={false}
          onOpen={() => {}}
          testId="link"
        />,
      ),
      'link-count',
    );

    for (const classes of [
      age,
      projectCount,
      archivedRowCount,
      archivedCompactCount,
    ]) {
      expect(classes).toEqual(expect.arrayContaining(SHARED_TRAILING_CLASSES));
      for (const divergent of DIVERGENT_CLASSES) {
        expect(classes).not.toContain(divergent);
      }
    }
  });
});
