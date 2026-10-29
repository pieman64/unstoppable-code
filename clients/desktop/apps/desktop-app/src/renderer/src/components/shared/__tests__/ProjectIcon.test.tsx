/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectIcon } from '../ProjectIcon';

describe('ProjectIcon', () => {
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

  // `ProjectIcon` is the desktop chokepoint for every badge render (sidebar,
  // pickers, kanban), so it is where a regression in the glyph paint would
  // show up app-wide. The glyphs are `currentColor`-driven; the badge is what
  // supplies white on its saturated categorical background. If the badge ever
  // stops supplying it, every project glyph silently turns dark on color.
  it.each(['single-repo', 'multi-repo', 'cowork'] as const)(
    'paints the %s badge glyph with badge-supplied white, not a literal fill',
    (kind) => {
      act(() => {
        root.render(<ProjectIcon kind={kind} color="#38bdf8" />);
      });

      const paths = Array.from(container.querySelectorAll('svg path'));
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        for (const attribute of ['fill', 'stroke']) {
          const value = path.getAttribute(attribute);
          if (value !== null) expect(value).toBe('currentColor');
        }
      }
      expect(container.innerHTML).not.toContain('"white"');
      expect(
        container.querySelector('svg')?.parentElement?.className,
      ).toContain('text-white');
    },
  );

  it('keeps the temporary project glyph neutral instead of white', () => {
    act(() => {
      root.render(<ProjectIcon kind="multi-repo" temporary color="#38bdf8" />);
    });

    const glyphHost = container.querySelector('svg')?.parentElement;
    expect(glyphHost?.className).toContain('fg-primary');
    expect(glyphHost?.className).not.toContain('text-white');
  });

  it('keeps the project glyph until the avatar finishes loading', async () => {
    const getRemoteUrl = jest.fn().mockResolvedValue({
      remoteUrl: 'git@github.com:acme/repo.git',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getRemoteUrl },
    });

    await act(async () => {
      root.render(
        <ProjectIcon
          kind="single-repo"
          color="#38bdf8"
          repoPath="/repos/example"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const image = container.querySelector('img');
    expect(getRemoteUrl).toHaveBeenCalledWith({ repoPath: '/repos/example' });
    expect(image?.getAttribute('src')).toBe(
      'https://github.com/acme.png?size=32',
    );
    expect(image?.className).toContain('rounded-[calc(var(--radius-md)-3px)]');
    expect(image?.className).not.toContain('rounded-full');
    expect(image?.className).toContain('invisible');
    const fallbackBadge = container.querySelector('[style]');
    expect(fallbackBadge?.className).toContain(
      'rounded-[calc(var(--radius-md)-3px)]',
    );
    expect(fallbackBadge?.className).not.toContain('invisible');

    act(() => {
      image?.dispatchEvent(new Event('load'));
    });

    expect(image?.className).not.toContain('invisible');
    expect(container.querySelector('[style]')?.className).toContain(
      'invisible',
    );
  });

  it('keeps a loaded owner avatar visible when switching repositories', async () => {
    const getRemoteUrl = jest.fn().mockResolvedValue({
      remoteUrl: 'git@github.com:acme/repo.git',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getRemoteUrl },
    });

    await act(async () => {
      root.render(
        <ProjectIcon kind="single-repo" repoPath="/repos/acme-one" />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstImage = container.querySelector('img');
    act(() => {
      firstImage?.dispatchEvent(new Event('load'));
    });
    expect(firstImage?.className).not.toContain('invisible');

    act(() => {
      root.render(
        <ProjectIcon kind="single-repo" repoPath="/repos/acme-two" />,
      );
    });
    expect(container.querySelector('img')).toBeNull();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const secondImage = container.querySelector('img');
    expect(secondImage).not.toBe(firstImage);
    expect(secondImage?.getAttribute('src')).toBe(
      'https://github.com/acme.png?size=32',
    );
    expect(secondImage?.className).not.toContain('invisible');
    expect(container.querySelector('[style]')?.className).toContain(
      'invisible',
    );
    expect(getRemoteUrl).toHaveBeenCalledWith({
      repoPath: '/repos/acme-two',
    });
  });

  it('shares a loaded repository avatar with newly mounted icon instances', async () => {
    const getRemoteUrl = jest.fn().mockResolvedValue({
      remoteUrl: 'git@github.com:shared-owner/repo.git',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getRemoteUrl },
    });

    await act(async () => {
      root.render(
        <ProjectIcon kind="single-repo" repoPath="/repos/shared-avatar" />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      container.querySelector('img')?.dispatchEvent(new Event('load'));
    });
    expect(container.querySelector('img')?.className).not.toContain(
      'invisible',
    );

    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(
        <ProjectIcon kind="single-repo" repoPath="/repos/shared-avatar" />,
      );
    });

    expect(container.querySelector('img')?.className).not.toContain(
      'invisible',
    );
    expect(container.querySelector('[style]')?.className).toContain(
      'invisible',
    );
    expect(getRemoteUrl).toHaveBeenCalledTimes(1);
  });
});
