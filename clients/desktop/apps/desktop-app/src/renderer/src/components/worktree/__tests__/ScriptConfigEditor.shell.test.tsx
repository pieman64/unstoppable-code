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

  function select(platform: string): HTMLSelectElement {
    const element = container.querySelector(
      `select[aria-label="Setup script ${platform} shell"]`,
    );
    expect(element).not.toBeNull();
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error(`Missing ${platform} shell selector`);
    }
    return element;
  }

  function change(platform: string, value: string): void {
    const element = select(platform);
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('offers Default (Bash), bash and zsh without materializing defaults', () => {
    render();
    const linux = select('Linux');
    expect(linux.value).toBe('');
    expect(
      Array.from(linux.options, ({ value, text }) => [value, text]),
    ).toEqual([
      ['', 'Default (Bash)'],
      ['bash', 'bash'],
      ['zsh', 'zsh'],
    ]);
    expect(onShellChange).not.toHaveBeenCalled();
  });

  it('merges rapid platform changes, preserving all overrides', () => {
    render();
    act(() => {
      change('Windows', 'powershell');
      change('Mac', 'bash');
      change('Linux', 'zsh');
    });
    expect(onShellChange).toHaveBeenLastCalledWith({
      windows: 'powershell',
      mac: 'bash',
      linux: 'zsh',
    });
    act(() => change('Linux', ''));
    expect(onShellChange).toHaveBeenLastCalledWith({
      windows: 'powershell',
      mac: 'bash',
    });
  });

  it('reflects persisted Linux overrides and clears the last optional shell', () => {
    render({ linux: 'zsh' });
    expect(select('Linux').value).toBe('zsh');
    act(() => change('Linux', 'bash'));
    expect(onShellChange).toHaveBeenLastCalledWith({ linux: 'bash' });
    render({ linux: 'bash' });
    act(() => change('Linux', ''));
    expect(onShellChange).toHaveBeenLastCalledWith(undefined);
  });

  it('preserves Linux when changing and clearing the other platforms', () => {
    render({ windows: 'cmd', mac: 'bash', linux: 'zsh' });
    act(() => {
      change('Windows', '');
      change('Mac', '');
    });
    expect(onShellChange).toHaveBeenLastCalledWith({ linux: 'zsh' });
  });
});
