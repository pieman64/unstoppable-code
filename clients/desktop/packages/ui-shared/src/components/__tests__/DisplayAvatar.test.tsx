/**
 * @jest-environment jsdom
 */
/**
 * DisplayAvatar is the one avatar every surface renders: a person's photo or
 * initials, a group's, or an actor's glyph in the same shell.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { DisplayAvatar } from '../DisplayAvatar';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PHOTO = 'https://example.com/ana.png';

describe('DisplayAvatar', () => {
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

  const byTestId = (id: string): HTMLElement => {
    const element = container.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
    if (element === null) throw new Error(`${id} did not render`);
    return element;
  };
  const avatar = (): HTMLElement => byTestId('avatar');

  it('fits one initial in the 16px avatar, where two overflow the circle', () => {
    act(() => {
      root.render(<DisplayAvatar name="Kai Mori" size="xs" testId="avatar" />);
    });
    expect(avatar().textContent).toBe('K');
  });

  it('shows two initials from 20px up', () => {
    act(() => {
      root.render(<DisplayAvatar name="Kai Mori" size="sm" testId="avatar" />);
    });
    expect(avatar().textContent).toBe('KM');
  });

  it('falls back to the initials when the photo fails, and tries a new photo', () => {
    act(() => {
      root.render(
        <DisplayAvatar name="Ana Ruiz" image={PHOTO} testId="avatar" />,
      );
    });
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe(PHOTO);
    act(() => {
      image?.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(avatar().textContent).toBe('AR');

    const next = 'https://example.com/ana-2.png';
    act(() => {
      root.render(
        <DisplayAvatar name="Ana Ruiz" image={next} testId="avatar" />,
      );
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(next);
  });

  it('tells the host which photo failed', () => {
    const onImageError = jest.fn();
    act(() => {
      root.render(
        <DisplayAvatar
          name="Ana Ruiz"
          image={PHOTO}
          onImageError={onImageError}
          testId="avatar"
        />,
      );
    });
    act(() => {
      avatar().dispatchEvent(new Event('error'));
    });
    expect(onImageError).toHaveBeenCalledWith(PHOTO);
  });

  it('blocks a person from session replay and records a group', () => {
    act(() => {
      root.render(
        <>
          <DisplayAvatar name="Ana Ruiz" testId="person" />
          <DisplayAvatar name="Ana Ruiz" image={PHOTO} testId="photo" />
          <DisplayAvatar name="Platform team" subject="group" testId="group" />
          <DisplayAvatar
            name="Acme"
            subject="group"
            replayBlocked
            testId="private-group"
          />
        </>,
      );
    });
    expect(byTestId('person').classList.contains(REPLAY_BLOCK_CLASS)).toBe(
      true,
    );
    expect(byTestId('photo').classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    expect(byTestId('group').classList.contains(REPLAY_BLOCK_CLASS)).toBe(
      false,
    );
    expect(
      byTestId('private-group').classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(true);
  });

  it('draws a glyph in place of the initials and records it', () => {
    act(() => {
      root.render(
        <DisplayAvatar
          name="Claude"
          glyph={<svg data-testid="agent-glyph" />}
          testId="avatar"
        />,
      );
    });
    expect(
      avatar().querySelector('[data-testid="agent-glyph"]'),
    ).not.toBeNull();
    expect(avatar().textContent).toBe('');
    expect(avatar().classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);
  });

  it('names the initials when the avatar is the only label', () => {
    act(() => {
      root.render(
        <DisplayAvatar name="Sam Lee" alt="Sam Lee" testId="avatar" />,
      );
    });
    expect(avatar().getAttribute('role')).toBe('img');
    expect(avatar().getAttribute('aria-label')).toBe('Sam Lee');
  });

  it('hides decorative initials from assistive tech', () => {
    act(() => {
      root.render(<DisplayAvatar name="Sam Lee" testId="avatar" />);
    });
    expect(avatar().getAttribute('aria-hidden')).toBe('true');
    expect(avatar().getAttribute('role')).toBeNull();
  });

  it('passes data attributes to the avatar element', () => {
    act(() => {
      root.render(
        <DisplayAvatar name="Claude" data-actor-kind="chat" testId="avatar" />,
      );
    });
    expect(avatar().getAttribute('data-actor-kind')).toBe('chat');
  });

  it('renders the photo through a host image component', () => {
    function HostImage({
      src,
      alt,
      className,
    }: {
      readonly src: string;
      readonly alt: string;
      readonly className?: string;
    }): JSX.Element {
      return (
        <img data-host-image="" src={src} alt={alt} className={className} />
      );
    }
    act(() => {
      root.render(
        <DisplayAvatar
          name="Ana Ruiz"
          image={PHOTO}
          imageComponent={HostImage}
          testId="avatar"
        />,
      );
    });
    expect(container.querySelector('img[data-host-image]')).not.toBeNull();
  });
});
