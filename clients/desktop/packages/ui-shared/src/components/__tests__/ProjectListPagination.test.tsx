/** @jest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectListPagination } from '../ProjectListPagination';

function classesOf(html: string, testId: string): string[] {
  const host = document.createElement('div');
  host.innerHTML = html;
  const element = host.querySelector(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`${testId} did not render`);
  return Array.from(element.classList);
}

/**
 * CAN-3612. "Show more" / "Show less" are text-only rows in the project list,
 * so their label starts on the title column the project names use instead of
 * at the section-header edge.
 */
describe('ProjectListPagination', () => {
  it.each([
    ['pointer', false, 'h-7'],
    ['touch', true, 'min-h-11'],
  ] as const)(
    'starts only the first label on the title column in the %s layout',
    (_layout, touchTargets, heightClass) => {
      const html = renderToStaticMarkup(
        <ProjectListPagination
          remainingCount={4}
          expanded
          onShowMore={(): void => undefined}
          onShowLess={(): void => undefined}
          touchTargets={touchTargets}
        />,
      );

      const more = classesOf(html, 'sidebar-projects-show-more');
      expect(more).toContain('pl-8');
      expect(more).toContain('pr-1.5');
      expect(more).not.toContain('px-1.5');

      // Beside "Show more", "Show less" follows it at the ordinary button
      // padding. A second title-column inset would open a wide gap between
      // the two labels and stretch the hover pill left of its text.
      const less = classesOf(html, 'sidebar-projects-show-less');
      expect(less).toContain('px-1.5');
      expect(less).not.toContain('pl-8');

      // The inset must not cost either row its height or touch target.
      expect(more).toContain(heightClass);
      expect(less).toContain(heightClass);
    },
  );

  it('starts "Show less" on the title column when it renders alone', () => {
    const html = renderToStaticMarkup(
      <ProjectListPagination
        remainingCount={0}
        expanded
        onShowMore={(): void => undefined}
        onShowLess={(): void => undefined}
      />,
    );

    const less = classesOf(html, 'sidebar-projects-show-less');
    expect(less).toContain('pl-8');
    expect(less).toContain('pr-1.5');
    expect(less).not.toContain('px-1.5');
  });

  it('renders nothing when there is nothing to page', () => {
    expect(
      renderToStaticMarkup(
        <ProjectListPagination
          remainingCount={0}
          expanded={false}
          onShowMore={(): void => undefined}
          onShowLess={(): void => undefined}
        />,
      ),
    ).toBe('');
  });
});
