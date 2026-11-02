/**
 * Server-rendered tests for the marketplace install trio moved out of the
 * desktop renderer (phase B of
 * docs/planning/2026-08-27-portal-plugins-section/design.md). These lock the
 * rendered output the shared marketplace source list and detail depend on.
 */
import { renderToString } from 'react-dom/server';
import {
  BulkInstallButton,
  MissingPluginsBadge,
  PluginInstallStatusCell,
} from '../MarketplacePluginInstall';

const noop = (): void => {};

describe('MissingPluginsBadge', () => {
  it('renders nothing when nothing is missing', () => {
    expect(renderToString(<MissingPluginsBadge count={0} />)).toBe('');
    expect(renderToString(<MissingPluginsBadge count={-3} />)).toBe('');
  });

  it('renders the count with the warning treatment and a test id', () => {
    const html = renderToString(
      <MissingPluginsBadge count={4} testId="missing-badge" />,
    );
    expect(html).toContain('data-testid="missing-badge"');
    expect(html).toContain('fg-warning');
    expect(html).toContain('4');
  });

  // The shared `Tooltip` only renders its label into a portal on hover/focus,
  // so the server pass shows the trigger wrapper but never the label text.
  it('wraps the badge in a tooltip trigger', () => {
    const html = renderToString(<MissingPluginsBadge count={1} />);
    expect(html).toContain('relative inline-flex shrink-0');
    expect(html).not.toContain('1 plugin not installed');
  });
});

describe('PluginInstallStatusCell', () => {
  it('shows a spinner while installing', () => {
    const html = renderToString(
      <PluginInstallStatusCell
        pluginName="alpha"
        needsInstall
        installing
        onInstall={noop}
      />,
    );
    expect(html).toContain('data-testid="plugin-install-status-alpha"');
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('data-testid="plugin-install-alpha"');
  });

  it('shows an install button when the plugin needs installing', () => {
    const html = renderToString(
      <PluginInstallStatusCell
        pluginName="alpha"
        needsInstall
        installing={false}
        onInstall={noop}
      />,
    );
    expect(html).toContain('data-testid="plugin-install-alpha"');
    expect(html).toContain('aria-label="Install alpha"');
    expect(html).toContain('fg-warning');
  });

  it('switches to a destructive retry affordance carrying the error', () => {
    const html = renderToString(
      <PluginInstallStatusCell
        pluginName="alpha"
        needsInstall
        installing={false}
        error="clone failed"
        onInstall={noop}
      />,
    );
    expect(html).toContain('aria-label="Retry install alpha"');
    expect(html).toContain('fg-destructive');
    // The error rides in a tooltip, so only its trigger wrapper is server
    // rendered; the plain (error-free) cell has no such wrapper.
    expect(html).toContain('relative inline-flex shrink-0');
    expect(
      renderToString(
        <PluginInstallStatusCell
          pluginName="alpha"
          needsInstall
          installing={false}
          onInstall={noop}
        />,
      ),
    ).not.toContain('relative inline-flex shrink-0');
  });

  it('renders a check once installed', () => {
    const html = renderToString(
      <PluginInstallStatusCell
        pluginName="alpha"
        needsInstall={false}
        installing={false}
        onInstall={noop}
      />,
    );
    expect(html).toContain('aria-label="Installed"');
    expect(html).toContain('fg-success');
  });

  it('marks the install button disabled when disabled', () => {
    const html = renderToString(
      <PluginInstallStatusCell
        pluginName="alpha"
        needsInstall
        installing={false}
        disabled
        onInstall={noop}
      />,
    );
    expect(html).toContain('disabled');
  });
});

describe('BulkInstallButton', () => {
  it('renders nothing with no missing plugins, no run, and no summary', () => {
    expect(
      renderToString(
        <BulkInstallButton
          missingCount={0}
          installing={false}
          onClick={noop}
        />,
      ),
    ).toBe('');
  });

  it('pluralizes the idle install label', () => {
    expect(
      renderToString(
        <BulkInstallButton
          missingCount={1}
          installing={false}
          onClick={noop}
        />,
      ),
    ).toContain('Install 1 plugin');
    expect(
      renderToString(
        <BulkInstallButton
          missingCount={3}
          installing={false}
          onClick={noop}
        />,
      ),
    ).toContain('Install 3 plugins');
  });

  it('shows cancellable progress while installing', () => {
    const html = renderToString(
      <BulkInstallButton
        missingCount={3}
        installing
        progress={{ done: 1, total: 3 }}
        onClick={noop}
      />,
    );
    expect(html).toContain('Installing 1/3');
    expect(html).toContain('(cancel)');
    expect(html).toContain('data-testid="bulk-install-plugins"');
  });

  it('shows the summary only once the run has finished', () => {
    const done = renderToString(
      <BulkInstallButton
        missingCount={0}
        installing={false}
        summary="2 installed, 1 failed"
        onClick={noop}
      />,
    );
    expect(done).toContain('data-testid="bulk-install-summary"');
    expect(done).toContain('2 installed, 1 failed');

    const running = renderToString(
      <BulkInstallButton
        missingCount={0}
        installing
        summary="2 installed, 1 failed"
        onClick={noop}
      />,
    );
    expect(running).not.toContain('data-testid="bulk-install-summary"');
  });
});
