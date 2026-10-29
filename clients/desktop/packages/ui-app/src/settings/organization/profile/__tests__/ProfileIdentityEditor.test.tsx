/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SettingsOperationError,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../../__tests__/helpers/test-settings-host';
import { ProfileIdentityEditor } from '../ProfileIdentityEditor';
import type { ProfileEditTarget } from '../use-profile-editor';

const PUBLISHED_IMAGE = 'https://storage.googleapis.com/bucket/abc.png';

type Handlers = Partial<Record<SettingsOperationName, FakeSettingsHandler>>;

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pickFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('ProfileIdentityEditor', () => {
  let container: HTMLElement;
  let root: Root;
  let client: FakeSettingsClient;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    installClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.clearAllMocks();
  });

  /** The upload transport (sign, PUT, commit) lives in the host client. */
  function installClient(handlers: Handlers = {}): void {
    client = createFakeSettingsClient({
      'account.avatar.upload': () => ({ image: PUBLISHED_IMAGE }),
      'account.avatar.remove': () => ({ name: 'Ada', image: null }),
      'account.details.update': () => ({ name: 'New Name', image: null }),
      'organization.members.profile.avatar.upload': () => ({
        image: PUBLISHED_IMAGE,
      }),
      'organization.members.profile.update': () => ({
        name: 'New Name',
        image: null,
      }),
      ...handlers,
    });
  }

  function operations(): SettingsOperationName[] {
    return client.calls.map((call) => call.operation);
  }

  function render(
    image: string | null = null,
    target?: ProfileEditTarget,
  ): void {
    const { host } = createTestSettingsHost({ client });
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <ProfileIdentityEditor
            initialName="Ada"
            initialImage={image}
            target={target}
          />
        </TestSettingsHost>,
      );
    });
  }

  function avatarInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="profile-avatar-input"]',
    );
    if (!input) throw new Error('missing input');
    return input;
  }

  it('uploads, moderates, and shows the published avatar', async () => {
    render();

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    pickFile(avatarInput(), file);
    await flush();

    // One upload entry: the host signs, PUTs the bytes and commits.
    expect(client.calls).toEqual([
      {
        operation: 'account.avatar.upload',
        input: { mimeType: 'image/png', size: 1, file },
      },
    ]);

    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(PUBLISHED_IMAGE);
  });

  it('rejects a non-image file without any network call', async () => {
    render();

    pickFile(avatarInput(), new File(['x'], 'a.txt', { type: 'text/plain' }));
    await flush();

    expect(client.calls).toHaveLength(0);
    expect(container.textContent).toContain('PNG');
  });

  it('rejects an oversized image without any network call', async () => {
    render();

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 5 * 1024 * 1024 + 1 });
    pickFile(avatarInput(), file);
    await flush();

    expect(client.calls).toHaveLength(0);
    expect(container.textContent).toContain(
      'Choose a PNG, JPEG, or GIF image up to 5 MB.',
    );
  });

  it('shows the local moderation copy, never the route text, for a 422', async () => {
    installClient({
      'account.avatar.upload': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 422,
          message: 'SENTINEL-SERVER-BODY',
        });
      },
    });
    render();

    pickFile(avatarInput(), new File(['x'], 'a.png', { type: 'image/png' }));
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This image can't be used as a profile photo. Choose a different image.",
    );
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
    expect(container.querySelector('img')).toBeNull();
  });

  it('uses the moderation copy for a bare 422', async () => {
    installClient({
      'account.avatar.upload': () => {
        throw new SettingsOperationError({ code: 'failed', status: 422 });
      },
    });
    render();

    pickFile(avatarInput(), new File(['x'], 'a.png', { type: 'image/png' }));
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This image can't be used as a profile photo. Choose a different image.",
    );
  });

  it('shows the offline copy when the transfer never reached the server', async () => {
    installClient({
      'account.avatar.upload': () => {
        throw new SettingsOperationError({ code: 'offline' });
      },
    });
    render();

    pickFile(avatarInput(), new File(['x'], 'a.png', { type: 'image/png' }));
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "You're offline. Check your connection and try again.",
    );
  });

  it('shows the generic upload copy, never the route text, for other failures', async () => {
    installClient({
      'account.avatar.upload': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 500,
          message: 'SENTINEL-SERVER-BODY',
        });
      },
    });
    render();

    pickFile(avatarInput(), new File(['x'], 'a.png', { type: 'image/png' }));
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't upload the photo. Try again.",
    );
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  });

  it('saves an edited display name', async () => {
    render();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="profile-name-edit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const nameInput = container.querySelector<HTMLInputElement>(
      '[data-testid="profile-name-input"]',
    );
    if (!nameInput) throw new Error('missing name input');

    act(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set?.call(nameInput, 'New Name');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    act(() => {
      container
        .querySelector<HTMLFormElement>('[data-testid="profile-name-input"]')
        ?.closest('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    await flush();

    expect(client.calls).toEqual([
      { operation: 'account.details.update', input: { name: 'New Name' } },
    ]);
    expect(
      container.querySelector('[data-testid="profile-name"]')?.textContent,
    ).toBe('New Name');
  });

  it('removes a custom photo back to initials', async () => {
    render('https://storage.googleapis.com/bucket/old.png');

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="profile-avatar-remove"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(operations()).toEqual(['account.avatar.remove']);
    expect(container.querySelector('img')).toBeNull();
  });

  it('routes to the org-scoped override operations for an org-member target', async () => {
    render(null, { mode: 'org-member', orgId: 'org-1', userId: 'usr-1' });

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    pickFile(avatarInput(), file);
    await flush();

    expect(client.calls).toEqual([
      {
        operation: 'organization.members.profile.avatar.upload',
        input: {
          organizationId: 'org-1',
          userId: 'usr-1',
          mimeType: 'image/png',
          size: 1,
          file,
        },
      },
    ]);
    // The self-edit account operations are never touched in org-member mode.
    expect(operations().some((name) => name.startsWith('account.'))).toBe(
      false,
    );
  });

  it('clears an org-member avatar override through the member update', async () => {
    render('https://storage.googleapis.com/bucket/old.png', {
      mode: 'org-member',
      orgId: 'org-1',
      userId: 'usr-1',
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="profile-avatar-remove"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(client.calls).toEqual([
      {
        operation: 'organization.members.profile.update',
        input: { organizationId: 'org-1', userId: 'usr-1', image: null },
      },
    ]);
  });

  it('shows the generic save copy, never the route text, when a name save is refused', async () => {
    installClient({
      'account.details.update': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 400,
          message: 'SENTINEL-SERVER-BODY',
        });
      },
    });
    render();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="profile-name-edit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      container
        .querySelector<HTMLFormElement>('[data-testid="profile-name-input"]')
        ?.closest('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't save the name. Try again.",
    );
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
    expect(
      container.querySelector('[data-testid="profile-name"]')?.textContent,
    ).toBe('Ada');
  });
});
