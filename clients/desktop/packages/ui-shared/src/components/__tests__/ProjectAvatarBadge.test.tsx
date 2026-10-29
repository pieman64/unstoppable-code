/**
 * @jest-environment jsdom
 */
/**
 * The shared rail became the desktop sidebar (CAN-3053) and drew only the
 * workspace-kind badge, so GitHub-backed projects lost the owner avatar the
 * desktop's `ProjectIcon` used to overlay. {@link ProjectAvatarBadge} is that
 * overlay, shared so desktop and the web portal render one treatment: the kind
 * badge stays put until the avatar has actually painted, and comes back when
 * the avatar fails.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectAvatarBadge } from '../ProjectAvatarBadge';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const AVATAR_URL = 'https://github.com/unstoppabledomains.png?size=32';

describe('ProjectAvatarBadge', () => {
  let container: HTMLDivElement;
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

  const badge = (): HTMLElement | null =>
    container.querySelector('[data-testid^="workspace-kind-badge"]');
  const avatar = (): HTMLImageElement | null => container.querySelector('img');

  it('keeps the kind badge visible until the owner avatar loads', () => {
    act(() => {
      root.render(
        <ProjectAvatarBadge
          kind="single-repo"
          color="#38bdf8"
          avatarUrl={AVATAR_URL}
        />,
      );
    });

    const image = avatar();
    expect(image?.getAttribute('src')).toBe(AVATAR_URL);
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(image?.getAttribute('data-testid')).toBe('workspace-owner-avatar');
    expect(image?.className).toContain('rounded-[calc(var(--radius-md)-3px)]');
    expect(image?.className).toContain('invisible');
    expect(badge()?.className).not.toContain('invisible');

    act(() => {
      image?.dispatchEvent(new Event('load'));
    });

    expect(avatar()?.className).not.toContain('invisible');
    // Shown by inheriting, never by forcing `visible`: a forced avatar shows
    // through a `visibility: hidden` ancestor (the app behind Settings).
    expect(avatar()?.classList.contains('visible')).toBe(false);
    expect(badge()?.className).toContain('invisible');
  });

  it('falls back to the kind badge when the avatar fails to load', () => {
    const onAvatarError = jest.fn();
    act(() => {
      root.render(
        <ProjectAvatarBadge
          kind="single-repo"
          avatarUrl={AVATAR_URL}
          onAvatarError={onAvatarError}
        />,
      );
    });

    act(() => {
      avatar()?.dispatchEvent(new Event('error'));
    });

    expect(avatar()).toBeNull();
    expect(badge()?.className).not.toContain('invisible');
    expect(onAvatarError).toHaveBeenCalledWith(AVATAR_URL);
  });

  it('shows an avatar the host already saw paint without waiting for load', () => {
    act(() => {
      root.render(
        <ProjectAvatarBadge
          kind="single-repo"
          avatarUrl={AVATAR_URL}
          avatarLoaded
        />,
      );
    });

    expect(avatar()?.className).not.toContain('invisible');
    expect(badge()?.className).toContain('invisible');
  });

  it('suffixes the avatar test id like the badge on pinned copies', () => {
    act(() => {
      root.render(
        <ProjectAvatarBadge
          kind="single-repo"
          avatarUrl={AVATAR_URL}
          testIdSuffix="-sticky-slot"
        />,
      );
    });

    expect(
      container.querySelector(
        '[data-testid="workspace-owner-avatar-sticky-slot"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="workspace-kind-badge-sticky-slot"]',
      ),
    ).not.toBeNull();
  });

  it.each(['multi-repo', 'cowork'] as const)(
    'keeps the %s kind badge and never draws an avatar',
    (kind) => {
      act(() => {
        root.render(<ProjectAvatarBadge kind={kind} avatarUrl={AVATAR_URL} />);
      });

      expect(avatar()).toBeNull();
      expect(badge()?.getAttribute('data-kind')).toBe(kind);
      expect(badge()?.className).not.toContain('invisible');
    },
  );

  it('renders only the kind badge without an avatar URL', () => {
    act(() => {
      root.render(<ProjectAvatarBadge kind="single-repo" />);
    });

    expect(avatar()).toBeNull();
    expect(badge()?.getAttribute('data-kind')).toBe('single-repo');
  });
});
