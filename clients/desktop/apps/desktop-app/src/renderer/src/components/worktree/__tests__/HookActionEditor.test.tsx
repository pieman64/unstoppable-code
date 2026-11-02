/** @jest-environment jsdom */
// Hook action speed serialization. Chat actions keep the configuration
// composer's exact speed with its derived boolean; pipeline actions keep their
// boolean input (Use default, Fast, Regular) and never offer Ultra fast.
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ConfigurationChatComposerProps } from '@/components/shared/ConfigurationChatComposer.types';
import type { EditableHooks } from '@/lib/editableHooks';
import { HookActionEditor } from '../HookActionEditor';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let composerProps: ConfigurationChatComposerProps | undefined;
jest.mock('@/components/shared/ConfigurationChatComposer', () => ({
  ConfigurationChatComposer: (props: ConfigurationChatComposerProps): null => {
    composerProps = props;
    return null;
  },
}));
jest.mock('@/lib/hookPipelineOptions', () => ({
  ...jest.requireActual<object>('@/lib/hookPipelineOptions'),
  loadHookPipelineOptions: (): Promise<never[]> => Promise.resolve([]),
}));

describe('HookActionEditor Codex speed', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: EditableHooks;

  beforeEach(() => {
    composerProps = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderHooks(initial: EditableHooks): Promise<void> {
    latest = initial;
    function Harness(): JSX.Element {
      const [hooks, setHooks] = useState(initial);
      return (
        <HookActionEditor
          hooks={hooks}
          onChange={(updater) =>
            setHooks((current) => {
              latest = updater(current);
              return latest;
            })
          }
          allowDisable={false}
          pluginSelectionMode="portable"
        />
      );
    }
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
  }

  function shellSelect(platform: string): HTMLSelectElement {
    const element = container.querySelector(
      `select[aria-label="Command action ${platform} shell"]`,
    );
    expect(element).not.toBeNull();
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error(`Missing ${platform} shell selector`);
    }
    return element;
  }

  function changeShell(platform: string, value: string): void {
    act(() => {
      const element = shellSelect(platform);
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('edits Linux command shells without changing Windows or Mac overrides', async () => {
    await renderHooks({
      'pr:create': [
        {
          uiId: 'command-hook',
          type: 'command',
          command: 'echo hook',
          shell: { windows: 'cmd', mac: 'bash', linux: 'zsh' },
        },
      ],
    });
    expect(shellSelect('Linux').value).toBe('zsh');
    expect(
      Array.from(shellSelect('Linux').options, ({ value, text }) => [
        value,
        text,
      ]),
    ).toEqual([
      ['', 'Default (Bash)'],
      ['bash', 'bash'],
      ['zsh', 'zsh'],
    ]);
    changeShell('Linux', 'bash');
    expect(latest['pr:create']?.[0]).toMatchObject({
      shell: { windows: 'cmd', mac: 'bash', linux: 'bash' },
    });
    changeShell('Linux', '');
    expect(latest['pr:create']?.[0]).toEqual({
      uiId: 'command-hook',
      type: 'command',
      command: 'echo hook',
      shell: { windows: 'cmd', mac: 'bash' },
    });
    changeShell('Linux', 'zsh');
    changeShell('Windows', '');
    changeShell('Mac', '');
    expect(latest['pr:create']?.[0]).toMatchObject({ shell: { linux: 'zsh' } });
    changeShell('Linux', '');
    expect(latest['pr:create']?.[0]).toEqual({
      uiId: 'command-hook',
      type: 'command',
      command: 'echo hook',
    });
  });

  it('leaves optional shell settings absent until the user selects a shell', async () => {
    await renderHooks({
      'pr:create': [
        { uiId: 'command-hook', type: 'command', command: 'echo hook' },
      ],
    });
    expect(shellSelect('Linux').value).toBe('');
    expect(latest['pr:create']?.[0]).not.toHaveProperty('shell');
    changeShell('Linux', 'zsh');
    expect(latest['pr:create']?.[0]).toMatchObject({ shell: { linux: 'zsh' } });
  });

  it('hands a saved Ultra fast chat speed to the composer unchanged', async () => {
    await renderHooks({
      'pr:create': [
        {
          uiId: 'chat-hook',
          type: 'chat',
          prompt: 'Review',
          modelConfig: { speed: 'ultrafast', fastMode: false },
        },
      ],
    });
    expect(composerProps?.value.modelConfig).toEqual({
      speed: 'ultrafast',
      fastMode: false,
    });
  });

  it('stores each composer speed change with its derived boolean', async () => {
    await renderHooks({
      'pr:create': [{ uiId: 'chat-hook', type: 'chat', prompt: 'Review' }],
    });
    for (const modelConfig of [
      { speed: 'ultrafast' as const, fastMode: false },
      { speed: 'fast' as const, fastMode: true },
      {},
    ]) {
      const props = composerProps;
      if (!props) throw new Error('Composer did not render');
      await act(async () => {
        props.onChange({ ...props.value, modelConfig });
        await Promise.resolve();
      });
      expect(latest['pr:create']?.[0]).toMatchObject({ modelConfig });
    }
  });

  it('keeps pipeline hooks on Use default, Fast, and Regular', async () => {
    await renderHooks({
      'pr:create': [
        {
          uiId: 'pipeline-hook',
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
        },
      ],
    });
    const speed = (): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.getAttribute('aria-label')?.startsWith('Speed: '),
      );
    const seen: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      seen.push(speed()?.textContent ?? '');
      await act(async () => {
        speed()?.click();
        await Promise.resolve();
      });
    }
    expect(seen).toEqual(['Use default', 'Fast', 'Regular']);
    expect(container.textContent).not.toContain('Ultra fast');
    expect(speed()?.textContent).toBe('Use default');
  });
});
