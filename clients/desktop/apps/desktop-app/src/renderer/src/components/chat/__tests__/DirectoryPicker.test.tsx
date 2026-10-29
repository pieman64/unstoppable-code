/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { DirectoryPicker } from '../DirectoryPicker';

describe('DirectoryPicker', () => {
  it('uses the wider shared capsule icon button with app icons', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <DirectoryPicker
        currentRepoId={undefined}
        childRepos={[{ id: 'web', name: 'Web' }]}
        onSelect={jest.fn()}
        hideLabel
        capsule
      />,
    );

    const button = host.querySelector('button');
    expect(button?.getAttribute('data-composer-icon-button')).toBe('true');
    expect(button?.classList.contains('h-8')).toBe(true);
    expect(button?.classList.contains('w-10')).toBe(true);
    expect(button?.classList.contains('rounded-full')).toBe(true);

    const icons = host.querySelectorAll('[data-app-icon="true"]');
    expect(icons).toHaveLength(2);
    expect(icons[0]?.getAttribute('style')).toContain('width:14px');
    expect(icons[1]?.getAttribute('style')).toContain('width:14px');
  });

  it('lets a labelled capsule grow to fit the repository name', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <DirectoryPicker
        currentRepoId="web"
        childRepos={[{ id: 'web', name: 'Web application' }]}
        onSelect={jest.fn()}
        capsule
      />,
    );

    const button = host.querySelector('button');
    expect(button?.classList.contains('min-w-10')).toBe(true);
    expect(button?.classList.contains('w-10')).toBe(false);
    expect(button?.classList.contains('max-w-48')).toBe(true);
    expect(button?.classList.contains('text-xs')).toBe(true);
    expect(button?.querySelector('span')?.classList.contains('truncate')).toBe(
      true,
    );
    expect(button?.textContent).toContain('Web application');
  });

  it('sits in the settings row like effort: no chevron, the name truncating', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <DirectoryPicker
        currentRepoId="web"
        childRepos={[{ id: 'web', name: 'Web application' }]}
        onSelect={jest.fn()}
        statusRow
        hideLabel
        capsule
      />,
    );

    const button = host.querySelector('button');
    expect(button?.getAttribute('data-testid')).toBe('chat-directory-picker');
    expect(button?.getAttribute('data-composer-icon-button')).toBeNull();
    // The row's chevronless capsule (the effort trigger's 12px end inset).
    for (const cls of [
      'h-8',
      'rounded-full',
      'text-xs',
      'pr-3',
      'max-w-full',
    ]) {
      expect(button?.classList.contains(cls)).toBe(true);
    }
    const icons = button?.querySelectorAll('[data-app-icon="true"]');
    expect(icons).toHaveLength(1);
    expect(icons?.[0]?.getAttribute('style')).toContain('width:14px');
    // The row never hides the name; it truncates instead.
    const label = button?.querySelector('span.truncate');
    expect(label?.textContent).toBe('Web application');
    expect(label?.classList.contains('min-w-0')).toBe(true);
    expect(host.firstElementChild?.classList.contains('min-w-0')).toBe(true);
  });
});
