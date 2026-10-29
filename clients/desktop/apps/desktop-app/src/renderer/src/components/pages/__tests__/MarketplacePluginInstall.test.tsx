import { renderToStaticMarkup } from 'react-dom/server';
import {
  BulkInstallButton,
  MissingPluginsBadge,
  PluginInstallStatusCell,
} from '../MarketplacePluginInstall';

describe('MissingPluginsBadge', () => {
  it('renders the count and warning styling', () => {
    const html = renderToStaticMarkup(
      <MissingPluginsBadge count={3} testId="badge" />,
    );
    expect(html).toContain('data-testid="badge"');
    expect(html).toContain('fg-warning');
    expect(html).toContain('3');
  });
});

describe('PluginInstallStatusCell', () => {
  const noop = (): void => undefined;

  it('renders a success check when installed', () => {
    const html = renderToStaticMarkup(
      <PluginInstallStatusCell
        pluginName="foo"
        needsInstall={false}
        installing={false}
        onInstall={noop}
      />,
    );
    expect(html).toContain('data-testid="plugin-install-status-foo"');
    expect(html).toContain('fg-success');
  });
});

describe('BulkInstallButton', () => {
  const noop = (): void => undefined;

  it('shows progress while installing and stays clickable to cancel', () => {
    const html = renderToStaticMarkup(
      <BulkInstallButton
        missingCount={5}
        installing
        progress={{ done: 2, total: 5 }}
        onClick={noop}
      />,
    );
    expect(html).toContain('Installing 2/5');
    // Cancel affordance: label hints cancel and the button is not disabled.
    expect(html).toContain('(cancel)');
    expect(html).not.toContain('disabled');
  });
});
