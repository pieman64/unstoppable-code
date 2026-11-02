import { renderToStaticMarkup } from 'react-dom/server';
import { CapabilityPill, formatCapabilityLabel } from '../CapabilityPill';
import { StatusPill } from '../StatusPill';

// The literal every status marker renders. Spelled out rather than imported
// from the component so a change to the metrics fails this test instead of
// silently agreeing with itself.
const STATUS_PILL_METRICS =
  'inline-flex h-4.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.75 text-2xs font-medium leading-none';
const STATUS_PILL_CLASS = `${STATUS_PILL_METRICS} bg-muted fg-secondary`;
const WARNING_CLASS = `${STATUS_PILL_METRICS} bg-warning-subtle fg-warning-strong`;

describe('StatusPill', () => {
  it('renders one span carrying exactly the shared metrics', () => {
    const html = renderToStaticMarkup(<StatusPill>View only</StatusPill>);

    expect(html).toBe(`<span class="${STATUS_PILL_CLASS}">View only</span>`);
  });

  it('passes a data-testid through ahead of the class', () => {
    const html = renderToStaticMarkup(
      <StatusPill data-testid="status-pill-probe">Trial</StatusPill>,
    );

    expect(html).toBe(
      `<span data-testid="status-pill-probe" class="${STATUS_PILL_CLASS}">Trial</span>`,
    );
  });

  it('maps quiet inks to the neutral badge and warning inks to the warning badge', () => {
    expect(
      renderToStaticMarkup(<StatusPill tone="warning">Unavailable</StatusPill>),
    ).toBe(`<span class="${WARNING_CLASS}">Unavailable</span>`);
    expect(
      renderToStaticMarkup(
        <StatusPill tone="warning-strong">Sign-in expired</StatusPill>,
      ),
    ).toBe(`<span class="${WARNING_CLASS}">Sign-in expired</span>`);
    expect(
      renderToStaticMarkup(<StatusPill tone="tertiary">Imported</StatusPill>),
    ).toBe(`<span class="${STATUS_PILL_CLASS}">Imported</span>`);
    expect(
      renderToStaticMarkup(<StatusPill tone="secondary">Codex</StatusPill>),
    ).toBe(`<span class="${STATUS_PILL_CLASS}">Codex</span>`);
  });

  it('appends placement classes after the metrics and tone', () => {
    const html = renderToStaticMarkup(
      <StatusPill className="ml-auto">Trial</StatusPill>,
    );

    expect(html).toBe(
      `<span class="${STATUS_PILL_CLASS} ml-auto">Trial</span>`,
    );
  });
});

describe('CapabilityPill', () => {
  it('renders the friendly label inside a shared status pill', () => {
    const html = renderToStaticMarkup(<CapabilityPill capability="VIEW" />);

    expect(html).toBe(
      `<span data-testid="shared-container-capability-pill-VIEW" class="${STATUS_PILL_CLASS}">View</span>`,
    );
  });

  it('keys the testid on the raw token, not the friendly label', () => {
    const html = renderToStaticMarkup(
      <CapabilityPill capability="EXPORT_DATA" />,
    );

    expect(html).toBe(
      `<span data-testid="shared-container-capability-pill-EXPORT_DATA" class="${STATUS_PILL_CLASS}">Export Data</span>`,
    );
  });

  it('shares its metrics with a bare StatusPill', () => {
    const capability = renderToStaticMarkup(
      <CapabilityPill capability="VIEW" />,
    );
    const bare = renderToStaticMarkup(<StatusPill>View</StatusPill>);

    expect(capability).toContain(`class="${STATUS_PILL_CLASS}"`);
    expect(bare).toContain(`class="${STATUS_PILL_CLASS}"`);
  });
});

describe('formatCapabilityLabel', () => {
  it('maps the known tokens to friendly labels', () => {
    expect(formatCapabilityLabel('VIEW')).toBe('View');
    expect(formatCapabilityLabel('comment')).toBe('Comment');
    expect(formatCapabilityLabel('EDIT')).toBe('Edit');
  });

  it('title-cases an unknown token instead of dropping it', () => {
    expect(formatCapabilityLabel('VIEW_ONLY')).toBe('View Only');
    expect(formatCapabilityLabel('view-only')).toBe('View Only');
  });

  it('falls back to the raw token when there is nothing to title-case', () => {
    expect(formatCapabilityLabel('___')).toBe('___');
    expect(formatCapabilityLabel('')).toBe('');
  });
});
