/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceLayoutPicker } from '../WorkspaceLayoutPicker';

function renderPicker(
  mode: 'minimal' | 'advanced',
  chatWidth: 'default' | 'full',
): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(
    <WorkspaceLayoutPicker
      mode={mode}
      chatWidth={chatWidth}
      onModeChange={() => {}}
      onChatWidthChange={() => {}}
      onSaveDefault={() => {}}
    />,
  );
  return root;
}

describe('WorkspaceLayoutPicker', () => {
  it('exposes independently selected width and layout groups', () => {
    const root = renderPicker('minimal', 'full');
    expect(root.querySelectorAll('[role="group"]')).toHaveLength(2);
    expect(root.querySelectorAll('[aria-checked="true"]')).toHaveLength(2);
    expect(
      root
        .querySelector('[data-testid="workspace-chat-width-full"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      root
        .querySelector('[data-testid="workspace-layout-mode-minimal"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      root.querySelector('[data-testid="save-layout-default-item"]'),
    ).toBeNull();
  });
  it('uses the shared save row for advanced layouts', () => {
    const root = renderPicker('advanced', 'default');
    const row = root.querySelector('[data-testid="save-layout-default-item"]');
    expect(row?.getAttribute('role')).toBe('menuitem');
    expect(row?.classList.contains('canopy-dropdown-menu-item')).toBe(true);
  });
});
