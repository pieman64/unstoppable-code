/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MemberProfileHeader } from '@canopy/protocol/team';
import {
  createTestSettingsHost,
  TestSettingsHost,
} from '../../../__tests__/helpers/test-settings-host';
import { ProfileHeader } from '../ProfileHeader';
import type { ProfileEditTarget } from '../use-profile-editor';

function makeMember(
  overrides: Partial<MemberProfileHeader> = {},
): MemberProfileHeader {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    image: null,
    role: 'OWNER',
    memberSinceIso: '2024-01-15T00:00:00.000Z',
    ...overrides,
  };
}

// The desktop host blocks people's names, emails and avatars from session
// replay; web supplies an empty class.
const host = createTestSettingsHost({
  privacy: { blockClassName: 'replay-block', maskClassName: 'replay-mask' },
}).host;

describe('ProfileHeader', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    member: MemberProfileHeader,
    editContext: ProfileEditTarget | null = null,
  ): void {
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <ProfileHeader member={member} editContext={editContext} />
        </TestSettingsHost>,
      );
    });
  }

  it('renders the name, role chip, email, and member-since date', () => {
    render(makeMember());
    const header = container.querySelector('[data-testid="profile-header"]');
    expect(header?.textContent).toContain('Grace Hopper');
    expect(header?.textContent).toContain('Owner');
    expect(header?.textContent).toContain('grace@example.com');
    expect(header?.textContent).toContain('Member since');
    const time = container.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe('2024-01-15T00:00:00.000Z');
  });

  it('falls back to avatar initials when there is no image', () => {
    render(makeMember({ image: null }));
    const avatar = container.querySelector('[role="img"]');
    expect(avatar?.textContent).toBe('GH');
  });

  it('reflects a self edit context and renders the avatar edit control', () => {
    render(makeMember(), { mode: 'self' });
    const header = container.querySelector('[data-testid="profile-header"]');
    expect(header?.getAttribute('data-editable')).toBe('true');
    expect(header?.getAttribute('data-edit-mode')).toBe('self');
    // When editable, the self-edit surface exposes the avatar control.
    expect(
      container.querySelector('[data-testid="profile-avatar-edit"]'),
    ).not.toBeNull();
  });

  it('reflects an org-member edit context for an admin viewer', () => {
    render(makeMember(), {
      mode: 'org-member',
      orgId: 'org-1',
      userId: 'usr-1',
    });
    const header = container.querySelector('[data-testid="profile-header"]');
    expect(header?.getAttribute('data-editable')).toBe('true');
    expect(header?.getAttribute('data-edit-mode')).toBe('org-member');
    expect(
      container.querySelector('[data-testid="profile-avatar-edit"]'),
    ).not.toBeNull();
  });

  it('does not render edit controls when there is no edit context', () => {
    render(makeMember(), null);
    expect(
      container.querySelector('[data-testid="profile-avatar-edit"]'),
    ).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('blocks the name, email and avatar from session replay', () => {
    render(makeMember());
    const header = container.querySelector('[data-testid="profile-header"]');
    const blocked = Array.from(
      header?.querySelectorAll('.replay-block') ?? [],
    ).map((element) => element.textContent);
    expect(blocked).toEqual(
      expect.arrayContaining(['GH', 'Grace Hopper', 'grace@example.com']),
    );
  });

  it('renders reserved bio/links when present', () => {
    render(
      makeMember({
        bio: 'Compiler pioneer.',
        links: [{ label: 'Site', url: 'https://example.com' }],
      }),
    );
    expect(container.textContent).toContain('Compiler pioneer.');
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link?.textContent).toBe('Site');
  });
});
