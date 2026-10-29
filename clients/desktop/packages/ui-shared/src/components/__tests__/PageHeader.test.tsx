import { renderToString } from 'react-dom/server';
import { PageHeader } from '../PageHeader';

const HEADING_CLASS = 'text-xl font-semibold fg-primary';

describe('PageHeader', () => {
  it('renders the title as an h1 with its description by default', () => {
    const html = renderToString(
      <PageHeader title="Security" description="Manage how you sign in." />,
    );
    expect(html).toContain('data-testid="page-header"');
    expect(html).toContain(
      `<h1 class="${HEADING_CLASS}" data-testid="page-header-title">Security</h1>`,
    );
    expect(html).toContain(
      '<p class="max-w-prose text-s fg-secondary" data-testid="page-header-description">Manage how you sign in.</p>',
    );
  });

  it('renders an h2 with the same treatment when the host owns the h1', () => {
    const html = renderToString(
      <PageHeader
        headingLevel="h2"
        title="Members"
        description="The people in this organization."
      />,
    );
    expect(html).toContain(
      `<h2 class="${HEADING_CLASS}" data-testid="page-header-title">Members</h2>`,
    );
    expect(html).not.toContain('<h1');
  });

  it('renders the actions slot only when actions are passed', () => {
    const without = renderToString(
      <PageHeader title="Memory" description="Facts agents have learned." />,
    );
    expect(without).not.toContain('page-header-actions');

    const withActions = renderToString(
      <PageHeader
        title="Memory"
        description="Facts agents have learned."
        actions={<nav data-testid="views" />}
      />,
    );
    expect(withActions).toContain(
      '<div class="shrink-0" data-testid="page-header-actions"><nav data-testid="views"></nav></div>',
    );
  });

  it('gives the title column the remaining width and the description a fixed measure', () => {
    const html = renderToString(
      <PageHeader title="Members" description="The people here." />,
    );
    expect(html).toContain('<div class="min-w-0 flex-1 space-y-2">');
    expect(html).toContain('max-w-prose');
  });

  it('reserves a button-height actions slot when asked, with or without actions', () => {
    const reservedEmpty = renderToString(
      <PageHeader title="Feed" description="Activity." reserveActions />,
    );
    expect(reservedEmpty).toContain(
      '<div class="min-h-8 shrink-0" data-testid="page-header-actions"></div>',
    );

    const reservedWithActions = renderToString(
      <PageHeader
        title="Members"
        description="The people here."
        reserveActions
        actions={<button type="button">Add member</button>}
      />,
    );
    expect(reservedWithActions).toContain(
      '<div class="min-h-8 shrink-0" data-testid="page-header-actions"><button type="button">Add member</button></div>',
    );
    // The title column and description are the same markup either way, so
    // the description wraps identically on sibling pages.
    const titleColumn = (html: string): string =>
      html.slice(
        html.indexOf('<div class="min-w-0'),
        html.indexOf('data-testid="page-header-actions"'),
      );
    expect(titleColumn(reservedEmpty).replace('Feed', 'X')).toBe(
      titleColumn(
        renderToString(
          <PageHeader
            title="X"
            description="Activity."
            reserveActions
            actions={<span />}
          />,
        ),
      ),
    );
  });

  it('keeps its layout and lets a host add placement only', () => {
    const html = renderToString(
      <PageHeader
        title="Memory"
        description="Facts agents have learned."
        className="flex-wrap"
      />,
    );
    expect(html).toContain(
      'class="flex items-start justify-between gap-4 flex-wrap"',
    );
  });
});
