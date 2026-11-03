/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CommandShellDefinition } from '@canopy/desktop-shared/scripts';
import { ScriptConfigEditor } from '../ScriptConfigEditor';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('ScriptConfigEditor Linux shell', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onShellChange = jest.fn();

  beforeEach(() => {
    onShellChange.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(shell?: CommandShellDefinition): void {
    act(() => {
      root.render(
        <ScriptConfigEditor
          label="Setup script"
          scriptName="setup"
          command="echo setup"
          onCommandChange={jest.fn()}
          onTimeoutSecondsChange={jest.fn()}
          defaultTimeoutSeconds={300}
          shell={shell}
          onShellChange={onShellChange}
        />,
      );
    });
  }

  function trigger(platform: string): HTMLElement {
    const element = container.querySelector(
      `[role="combobox"][aria-label="Setup script ${platform} shell"]`,
    );
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Missing ${platform} shell selector`);
    }
    return element;
  }

  function openOptions(platform: string): HTMLElement[] {
    act(() => trigger(platform).click());
    return Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]'),
    );
  }

  function change(platform: string, value: string): void {
    const option = openOptions(platform).find(
      (element) => element.dataset.value === value,
    );
    if (!option) throw new Error(`Missing ${platform} option ${value}`);
    act(() => option.click());
  }

  it('offers Default (Bash), bash and zsh without materializing defaults', () => {
    render();
    expect(trigger('Linux').textContent).toBe('Default (Bash)');
    expect(
      openOptions('Linux').map((option) => [
        option.dataset.value,
        option.textContent,
      ]),
    ).toEqual([
      ['', 'Default (Bash)'],
      ['bash', 'bash'],
      ['zsh', 'zsh'],
    ]);
    expect(onShellChange).not.toHaveBeenCalled();
  });

  it('merges rapid platform changes, preserving all overrides', () => {
    render();
    change('Windows', 'powershell');
    change('Mac', 'bash');
    change('Linux', 'zsh');
    expect(onShellChange).toHaveBeenLastCalledWith({
      windows: 'powershell',
      mac: 'bash',
      linux: 'zsh',
    });
    // The parent persists the merged value before the next pick.
    render({ windows: 'powershell', mac: 'bash', linux: 'zsh' });
    change('Linux', '');
    expect(onShellChange).toHaveBeenLastCalledWith({
      windows: 'powershell',
      mac: 'bash',
    });
  });

  it('reflects persisted Linux overrides and clears the last optional shell', () => {
    render({ linux: 'zsh' });
    expect(trigger('Linux').dataset.value).toBe('zsh');
    change('Linux', 'bash');
    expect(onShellChange).toHaveBeenLastCalledWith({ linux: 'bash' });
    render({ linux: 'bash' });
    change('Linux', '');
    expect(onShellChange).toHaveBeenLastCalledWith(undefined);
  });

  it('preserves Linux when changing and clearing the other platforms', () => {
    render({ windows: 'cmd', mac: 'bash', linux: 'zsh' });
    change('Windows', '');
    change('Mac', '');
    expect(onShellChange).toHaveBeenLastCalledWith({ linux: 'zsh' });
  });
});
