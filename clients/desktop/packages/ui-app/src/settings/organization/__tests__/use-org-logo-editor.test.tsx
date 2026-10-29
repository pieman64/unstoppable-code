/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';
import {
  useOrgLogoEditor,
  type UseOrgLogoEditorResult,
} from '../use-org-logo-editor';
import { failWith } from './helpers/settings-responses';

const ORG_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';

const DETAIL = {
  id: ORG_ID,
  name: 'Acme',
  viewerRole: 'OWNER',
  members: [],
  subTeams: [],
  logoUrl: 'https://cdn.example.com/logo.png',
};

let editor: UseOrgLogoEditorResult | null = null;

function Probe(): JSX.Element {
  editor = useOrgLogoEditor(ORG_ID);
  return <span>{editor.error ?? ''}</span>;
}

function current(): UseOrgLogoEditorResult {
  if (editor === null) throw new Error('Probe has not rendered');
  return editor;
}

function png(size = 4): File {
  return new File([new Uint8Array(size)], 'logo.png', { type: 'image/png' });
}

describe('useOrgLogoEditor', (): void => {
  let container: HTMLElement;
  let root: Root;

  function mount(
    handlers: Partial<
      Record<
        'organization.logo.upload' | 'organization.logo.clear',
        FakeSettingsHandler
      >
    >,
  ): FakeSettingsClient {
    const client = createFakeSettingsClient(handlers);
    const { host } = createTestSettingsHost({ client });
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <Probe />
        </TestSettingsHost>,
      );
    });
    return client;
  }

  beforeEach((): void => {
    editor = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach((): void => {
    act(() => root.unmount());
    container.remove();
  });

  it('refuses an unsupported file before any request', async (): Promise<void> => {
    const client = mount({});
    let result: OrganizationDetail | null = null;
    await act(async () => {
      result = await current().uploadLogo(
        new File(['x'], 'logo.svg', { type: 'image/svg+xml' }),
      );
    });
    expect(result).toBeNull();
    expect(current().error).toBe(
      'Choose a PNG, JPEG, or GIF image up to 5 MB.',
    );
    expect(client.calls).toEqual([]);
  });

  it('uploads through organization.logo.upload and resolves the detail', async (): Promise<void> => {
    const client = mount({ 'organization.logo.upload': () => DETAIL });
    const file = png();
    let result: OrganizationDetail | null = null;
    await act(async () => {
      result = await current().uploadLogo(file);
    });
    expect(result).toEqual(DETAIL);
    expect(current().error).toBeNull();
    expect(client.calls).toEqual([
      {
        operation: 'organization.logo.upload',
        input: {
          organizationId: ORG_ID,
          mimeType: 'image/png',
          size: file.size,
          file,
        },
      },
    ]);
  });

  it('shows the moderation copy, never the server text, for a 422', async (): Promise<void> => {
    mount({
      'organization.logo.upload': failWith(
        422,
        { error: 'SENTINEL-SERVER-BODY' },
        { write: true },
      ),
    });
    await act(async () => {
      await current().uploadLogo(png());
    });
    expect(current().error).toBe(
      "This image can't be used as a logo. Choose a different image.",
    );
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  });

  it('shows the generic copy when the storage upload fails', async (): Promise<void> => {
    mount({
      'organization.logo.upload': (): never => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 403,
          serverCode: 'upload_failed',
        });
      },
    });
    await act(async () => {
      await current().uploadLogo(png());
    });
    expect(current().error).toBe("Couldn't upload the logo. Try again.");
  });

  it('removes the logo through organization.logo.clear', async (): Promise<void> => {
    const client = mount({
      'organization.logo.clear': () => ({ ...DETAIL, logoUrl: null }),
    });
    let result: OrganizationDetail | null = null;
    await act(async () => {
      result = await current().removeLogo();
    });
    expect(result).toMatchObject({ logoUrl: null });
    expect(client.calls).toEqual([
      {
        operation: 'organization.logo.clear',
        input: { organizationId: ORG_ID },
      },
    ]);
  });

  it('says the outcome is unknown when the remove may have applied', async (): Promise<void> => {
    mount({
      'organization.logo.clear': (): never => {
        throw new SettingsOperationError({ code: 'uncertain' });
      },
    });
    await act(async () => {
      await current().removeLogo();
    });
    expect(current().error).toBe(
      "Couldn't confirm that finished. Refresh to check before trying again.",
    );
  });
});
