import { renderToString } from 'react-dom/server';
import { TestSettingsHost } from '../../__tests__/helpers/test-settings-host';
import {
  ApiKeyRow,
  ApiKeysPanel,
  formatApiKeyMetadata,
} from '../api-keys-panel';

function renderPanel(): string {
  return renderToString(
    <TestSettingsHost>
      <ApiKeysPanel brandDisplayName="Canopy" />
    </TestSettingsHost>,
  );
}

type ApiKeyRowItem = Parameters<typeof formatApiKeyMetadata>[0];

function makeKey(overrides: Partial<ApiKeyRowItem> = {}): ApiKeyRowItem {
  return {
    id: 'key-1',
    name: 'Laptop CLI',
    source: 'MANUAL',
    createdIp: '203.0.113.7',
    createdAt: '2026-01-02T10:00:00.000Z',
    lastUsedAt: null,
    ...overrides,
  };
}

function renderRow(key: ApiKeyRowItem): string {
  return renderToString(
    <ul>
      <ApiKeyRow
        apiKey={key}
        pendingDelete={false}
        deleting={false}
        onRequestDelete={() => {}}
        onConfirmDelete={() => {}}
        onCancelDelete={() => {}}
      />
    </ul>,
  );
}

describe('formatApiKeyMetadata', () => {
  it('labels manual keys and renders the creation IP', () => {
    const line = formatApiKeyMetadata(makeKey());
    expect(line).toContain('Manual');
    expect(line).toContain('IP 203.0.113.7');
    expect(line).toContain('Never used');
  });

  it('labels desktop OAuth keys', () => {
    const line = formatApiKeyMetadata(
      makeKey({ id: 'key-2', source: 'OAUTH_DESKTOP' }),
    );
    expect(line).toContain('Desktop OAuth');
  });

  it('renders IP Unknown when the creation IP is missing', () => {
    expect(formatApiKeyMetadata(makeKey({ createdIp: null }))).toContain(
      'IP Unknown',
    );
    expect(formatApiKeyMetadata(makeKey({ createdIp: '   ' }))).toContain(
      'IP Unknown',
    );
  });

  it('renders the last-used timestamp when present', () => {
    const line = formatApiKeyMetadata(
      makeKey({ lastUsedAt: '2026-01-03T12:00:00.000Z' }),
    );
    expect(line).toContain('Last used');
    expect(line).not.toContain('Never used');
  });
});

describe('ApiKeyRow', () => {
  it('renders the Manual source label and creation IP', () => {
    const html = renderRow(makeKey());
    expect(html).toContain('Manual');
    expect(html).toContain('IP 203.0.113.7');
  });

  it('renders the Desktop OAuth source label and IP Unknown for missing IP', () => {
    const html = renderRow(
      makeKey({ id: 'key-3', source: 'OAUTH_DESKTOP', createdIp: null }),
    );
    expect(html).toContain('Desktop OAuth');
    expect(html).toContain('IP Unknown');
  });

  it('never renders a raw token in the row', () => {
    const html = renderRow(makeKey());
    expect(html).not.toContain('csk_');
  });
});

describe('ApiKeysPanel', () => {
  it('uses the manual-create button copy', () => {
    const html = renderPanel();
    expect(html).toContain('Create manual API key');
  });

  it('describes both manual and desktop OAuth provenance', () => {
    const html = renderPanel();
    expect(html).toContain('desktop OAuth sign-in');
  });

  it('holds the key list with a list skeleton before the first read, never loading copy', () => {
    const html = renderPanel();
    expect(html).toContain('data-testid="settings-skeleton-list"');
    expect(html).not.toContain('Loading API keys');
  });
});
