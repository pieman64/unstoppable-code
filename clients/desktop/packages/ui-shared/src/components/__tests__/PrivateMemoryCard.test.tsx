import { renderToStaticMarkup } from 'react-dom/server';
import {
  PrivateMemoryAdvancedOption,
  PrivateMemoryCard,
  PrivateMemoryInlineToggle,
} from '../PrivateMemoryCard';

// The approved copy (CAN-3562), spelled out so a reworded control fails here.
const EXPLANATION =
  "Agents won't use memory from other projects or your organization. New memories stay here.";

function render(
  props: Partial<Parameters<typeof PrivateMemoryCard>[0]> = {},
): string {
  return renderToStaticMarkup(
    <PrivateMemoryCard checked={false} onChange={() => undefined} {...props} />,
  );
}

describe('PrivateMemoryCard', () => {
  it('keeps the approved explanation verbatim', () => {
    // The apostrophes are escaped in markup, so compare the decoded copy.
    expect(render().replace(/&#x27;/g, "'")).toContain(EXPLANATION);
  });

  it('renders an editable switch that the visible label activates', () => {
    const html = render({ dataTestId: 'settings-private-memory' });
    expect(html).toContain('data-testid="settings-private-memory"');
    expect(html).toContain('data-testid="settings-private-memory-toggle"');
    expect(html).toContain('aria-label="Private memory"');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('settings-private-memory-managed');
    const switchId = /<button id="([^"]+)"/.exec(html)?.[1];
    expect(switchId).toBeDefined();
    expect(html).toContain(`<label for="${switchId}"`);
  });

  it('shows both toggle values', () => {
    expect(render({ checked: true })).toContain('aria-checked="true"');
    expect(render({ checked: false })).toContain('aria-checked="false"');
  });

  it('locks a managed value and names the organization', () => {
    const html = render({
      checked: true,
      managed: true,
      organizationName: 'Acme',
    });
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-managed="true"');
    expect(html).toContain('Managed by Acme');
  });

  it('falls back when the organization name is unavailable', () => {
    for (const organizationName of [undefined, null, '  '])
      expect(render({ managed: true, organizationName })).toContain(
        'Managed by your organization',
      );
  });

  it('locks without a managed line while the caller is saving', () => {
    const html = render({ disabled: true });
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Managed by');
  });

  it('reports a refused save beside the control', () => {
    const html = render({
      dataTestId: 'settings-private-memory',
      error: 'Private memory is managed by your organization',
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-testid="settings-private-memory-error"');
    expect(html).toContain('Private memory is managed by your organization');
    expect(render()).not.toContain('role="alert"');
  });

  it('drops the frame inside a panel that already has one', () => {
    expect(render()).toContain('rounded-lg border p-4');
    expect(render({ surface: 'inline' })).not.toContain('border-border');
  });
});

describe('PrivateMemoryAdvancedOption', () => {
  function renderOption(checked: boolean): string {
    return renderToStaticMarkup(
      <PrivateMemoryAdvancedOption
        checked={checked}
        onChange={() => undefined}
        dataTestId="create-private-memory"
        disclosureTestId="create-advanced"
      />,
    );
  }

  it('waits behind a collapsed Advanced toggle', () => {
    const html = renderOption(false);
    expect(html).toContain('data-testid="create-advanced-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Advanced');
    expect(html).not.toContain('create-private-memory-toggle');
    expect(html).not.toContain('Private memory on');
  });

  it('names a choice left on while collapsed', () => {
    expect(renderOption(true)).toContain(' · Private memory on');
  });
});

describe('PrivateMemoryInlineToggle', () => {
  function renderToggle(checked: boolean): string {
    return renderToStaticMarkup(
      <PrivateMemoryInlineToggle
        checked={checked}
        onChange={() => undefined}
        dataTestId="create-private-memory"
      />,
    );
  }

  it('renders a labelled switch with an info button', () => {
    const html = renderToggle(false);
    expect(html).toContain('data-testid="create-private-memory"');
    expect(html).toContain('data-testid="create-private-memory-toggle"');
    expect(html).toContain('data-testid="create-private-memory-info"');
    expect(html).toContain('aria-label="About Private memory"');
    const switchId = /<button id="([^"]+)"/.exec(html)?.[1];
    expect(switchId).toBeDefined();
    expect(html).toContain(`<label for="${switchId}"`);
  });

  it('shows both toggle values', () => {
    expect(renderToggle(true)).toContain('aria-checked="true"');
    expect(renderToggle(false)).toContain('aria-checked="false"');
  });
});
