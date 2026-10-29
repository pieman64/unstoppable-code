/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ArchivedContainersNavLink,
  SidebarOverviewNavLink,
} from '../ArchivedContainersNavLink';
import { SidebarRowAge } from '../SidebarRowAge';

function classesOf(markup: string): string[] {
  return (
    /data-testid="link"[^>]*class="([^"]+)"|class="([^"]+)"[^>]*data-testid="link"/
      .exec(markup)
      ?.slice(1)
      .find(Boolean)
      ?.split(' ') ?? []
  );
}

describe('ArchivedContainersNavLink', () => {
  const props = {
    count: 3,
    selected: false,
    onOpen: (): void => {},
    testId: 'link',
  };

  it('keeps its own label, and the shared link takes any', () => {
    expect(
      renderToStaticMarkup(<ArchivedContainersNavLink {...props} />),
    ).toContain('Archived and deleted');
    const pastShares = renderToStaticMarkup(
      <SidebarOverviewNavLink {...props} label="Past shares" />,
    );
    expect(pastShares).toContain('Past shares');
    expect(pastShares).not.toContain('Archived and deleted');
    expect(
      renderToStaticMarkup(
        <SidebarOverviewNavLink {...props} label="Past shares" count={0} />,
      ),
    ).toBe('');
  });

  it('keeps the compact 28px link by default', () => {
    const classes = classesOf(
      renderToStaticMarkup(<ArchivedContainersNavLink {...props} />),
    );
    expect(classes).toContain('h-7');
    expect(classes).toContain('rounded-md');
  });

  it('takes the sidebar rows’ height and corner at row size', () => {
    const classes = classesOf(
      renderToStaticMarkup(<ArchivedContainersNavLink {...props} size="row" />),
    );
    expect(classes).toContain('h-8');
    expect(classes).toContain('rounded-row');
    expect(classes).not.toContain('h-7');
    expect(classes).not.toContain('rounded-md');
  });

  it('puts the row-size count in the rows’ age cell and ink', () => {
    const markup = renderToStaticMarkup(
      <ArchivedContainersNavLink {...props} size="row" />,
    );
    const count =
      /class="([^"]+)"[^>]*data-testid="link-count"/.exec(markup)?.[1] ?? '';
    expect(count.split(' ')).toEqual(
      expect.arrayContaining([
        'w-6',
        'justify-end',
        'text-2xs',
        'fg-quaternary',
      ]),
    );
    expect(classesOf(markup)).toContain('pr-1.5');
    // Same cell as the ages above it, including the inset that keeps the
    // text off the row's edge, so the count's right edge lines up with theirs.
    const age =
      /class="([^"]+)"[^>]*data-testid="age"/.exec(
        renderToStaticMarkup(
          <SidebarRowAge
            lastActivityAt={Date.now()}
            hidesForActions={false}
            testId="age"
          />,
        ),
      )?.[1] ?? '';
    expect(age).not.toBe('');
    expect(count.split(' ')).toEqual(
      expect.arrayContaining(age.split(' ').filter(Boolean)),
    );

    const compact = renderToStaticMarkup(
      <ArchivedContainersNavLink {...props} />,
    );
    expect(compact).toMatch(
      /class="[^"]*fg-quaternary[^"]*"[^>]*data-testid="link-count"/,
    );
  });
});
