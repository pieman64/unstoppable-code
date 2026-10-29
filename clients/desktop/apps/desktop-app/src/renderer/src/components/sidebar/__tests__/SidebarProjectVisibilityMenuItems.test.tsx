/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarProjectVisibilityMenuItems } from '../SidebarProjectVisibilityMenuItems';

describe('SidebarProjectVisibilityMenuItems', () => {
  it('renders the Show projects group label', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <SidebarProjectVisibilityMenuItems
        options={[
          {
            id: 'a',
            name: 'Acme secret',
            color: '#000000',
            kind: 'single-repo',
            worktreeCount: 3,
          },
          {
            id: 'b',
            name: 'Side project',
            color: '#ffffff',
            kind: 'cowork',
            worktreeCount: 1,
          },
        ]}
        hiddenWorkspaceIds={[]}
        onChange={(): void => {}}
      />,
    );

    expect(container.textContent).toContain('Show projects');
  });
});
