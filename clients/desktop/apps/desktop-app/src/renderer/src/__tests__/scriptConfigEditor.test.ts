/**
 * @jest-environment jsdom
 */
import { MAX_SCRIPT_TIMEOUT_SECONDS } from '@canopy/desktop-shared/scripts';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  getCustomTimeoutDraft,
  parseCustomTimeoutDraft,
} from '../lib/scriptConfigTimeout';
import { ScriptConfigEditor } from '../components/worktree/ScriptConfigEditor';
import type { EditableDevServerPattern } from '../lib/editableScripts';
import type { CommandShellDefinition } from '@canopy/desktop-shared/scripts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('parseCustomTimeoutDraft', () => {
  it.each([
    ['1', 1],
    ['900', 900],
    [`${MAX_SCRIPT_TIMEOUT_SECONDS}`, MAX_SCRIPT_TIMEOUT_SECONDS],
    [' 120 ', 120],
  ])('accepts positive integer draft %p', (raw, expected) => {
    expect(parseCustomTimeoutDraft(raw)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    '0',
    '-1',
    '1.5',
    '1e3',
    '01',
    `${MAX_SCRIPT_TIMEOUT_SECONDS + 1}`,
  ])('rejects invalid timeout draft %p', (raw) => {
    expect(parseCustomTimeoutDraft(raw)).toBeUndefined();
  });
});

describe('getCustomTimeoutDraft', () => {
  it('formats numeric timeout props as the visible custom draft', () => {
    expect(getCustomTimeoutDraft(900)).toBe('900');
    expect(getCustomTimeoutDraft(1200)).toBe('1200');
  });

  it('clears the visible custom draft for default and disabled timeout props', () => {
    expect(getCustomTimeoutDraft(undefined)).toBe('');
    expect(getCustomTimeoutDraft(null)).toBe('');
  });
});

describe('ScriptConfigEditor timeout control state', () => {
  it('keeps unconfigured lifecycle script timeout controls responsive', () => {
    const onTimeoutSecondsChange = jest.fn();
    const rendered = renderScriptConfigEditor({
      scriptName: 'setup',
      command: '',
      onTimeoutSecondsChange,
    });

    try {
      const custom = getTimeoutOption(rendered.container, 'Custom');
      expect(custom.disabled).toBe(false);
      expect(
        getTimeoutOption(rendered.container, 'Default').getAttribute(
          'aria-checked',
        ),
      ).toBe('true');

      act(() => {
        custom.click();
      });

      expect(onTimeoutSecondsChange).toHaveBeenCalledWith(300);
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps configured lifecycle scripts timeout-editable', () => {
    const onTimeoutSecondsChange = jest.fn();
    const rendered = renderScriptConfigEditor({
      scriptName: 'teardown',
      command: 'npm run clean',
      onTimeoutSecondsChange,
    });

    try {
      const custom = getTimeoutOption(rendered.container, 'Custom');
      expect(custom.disabled).toBe(false);

      act(() => {
        custom.click();
      });

      expect(onTimeoutSecondsChange).toHaveBeenCalledWith(300);
    } finally {
      rendered.cleanup();
    }
  });

  it('shows launch scripts as disabled with Disabled selected even when configured', () => {
    const rendered = renderScriptConfigEditor({
      scriptName: 'launch',
      command: 'npm run dev',
    });

    try {
      expect(getTimeoutOption(rendered.container, 'Disabled').disabled).toBe(
        true,
      );
      expect(
        getTimeoutOption(rendered.container, 'Disabled').getAttribute(
          'aria-checked',
        ),
      ).toBe('true');
      expect(rendered.container.textContent).toContain(
        'Launch scripts are persistent and do not time out.',
      );
    } finally {
      rendered.cleanup();
    }
  });
});

describe('ScriptConfigEditor runtime mode picker', () => {
  it('defaults to Background and reports the switch to Interactive', () => {
    const onInteractiveChange = jest.fn();
    const rendered = renderScriptConfigEditor({
      scriptName: 'wizard',
      command: 'npm run wizard',
      onInteractiveChange,
    });
    try {
      expect(rendered.container.textContent).toContain('Runtime');
      expect(
        getRuntimeOption(rendered.container, 'background').getAttribute(
          'aria-checked',
        ),
      ).toBe('true');
      expect(
        getRuntimeOption(rendered.container, 'interactive').getAttribute(
          'aria-checked',
        ),
      ).toBe('false');

      act(() => {
        getRuntimeOption(rendered.container, 'interactive').click();
      });

      expect(onInteractiveChange).toHaveBeenCalledWith(true);
    } finally {
      rendered.cleanup();
    }
  });

  it('shows the persisted Interactive state and reports the switch back', () => {
    const onInteractiveChange = jest.fn();
    const rendered = renderScriptConfigEditor({
      scriptName: 'wizard',
      command: 'npm run wizard',
      interactive: true,
      onInteractiveChange,
    });
    try {
      expect(
        getRuntimeOption(rendered.container, 'interactive').getAttribute(
          'aria-checked',
        ),
      ).toBe('true');

      act(() => {
        getRuntimeOption(rendered.container, 'background').click();
      });

      expect(onInteractiveChange).toHaveBeenCalledWith(false);
    } finally {
      rendered.cleanup();
    }
  });

  it('describes the interactive runtime only while Interactive is selected', () => {
    const description =
      'Run this script in the project terminal so it can accept input.';
    const rendered = renderScriptConfigEditor({
      scriptName: 'wizard',
      command: 'npm run wizard',
      onInteractiveChange: jest.fn(),
    });
    try {
      expect(rendered.container.textContent).not.toContain(description);

      rendered.rerender({
        scriptName: 'wizard',
        command: 'npm run wizard',
        interactive: true,
        onInteractiveChange: jest.fn(),
      });

      expect(rendered.container.textContent).toContain(description);
    } finally {
      rendered.cleanup();
    }
  });

  it('hides the timeout control while Interactive is selected', () => {
    const rendered = renderScriptConfigEditor({
      scriptName: 'wizard',
      command: 'npm run wizard',
      timeoutSeconds: 30,
      onInteractiveChange: jest.fn(),
    });
    try {
      expect(rendered.container.textContent).toContain('Timeout');
      expect(getTimeoutOption(rendered.container, 'Custom')).toBeInstanceOf(
        HTMLButtonElement,
      );

      rendered.rerender({
        scriptName: 'wizard',
        command: 'npm run wizard',
        timeoutSeconds: 30,
        interactive: true,
        onInteractiveChange: jest.fn(),
      });

      expect(rendered.container.textContent).not.toContain('Timeout');
      expect(() => getTimeoutOption(rendered.container, 'Custom')).toThrow();
    } finally {
      rendered.cleanup();
    }
  });

  it.each(['teardown', 'before-teardown', 'after-teardown'])(
    'locks %s to Background even when interactive was persisted',
    (scriptName) => {
      const onInteractiveChange = jest.fn();
      const rendered = renderScriptConfigEditor({
        scriptName,
        command: 'npm run clean',
        timeoutSeconds: 30,
        interactive: true,
        // Teardown editors are wired without a handler in the settings modals;
        // the locked picker must render either way.
        onInteractiveChange,
      });
      try {
        const background = getRuntimeOption(rendered.container, 'background');
        const interactiveOption = getRuntimeOption(
          rendered.container,
          'interactive',
        );
        expect(background.getAttribute('aria-checked')).toBe('true');
        expect(interactiveOption.getAttribute('aria-checked')).toBe('false');
        expect(background.disabled).toBe(true);
        expect(interactiveOption.disabled).toBe(true);

        act(() => {
          interactiveOption.click();
        });
        expect(onInteractiveChange).not.toHaveBeenCalled();

        // The reason is a hover tooltip; the sr-only copy keeps it reachable
        // for assistive tech because disabled buttons never take focus.
        const group = rendered.container.querySelector(
          '[data-testid="script-runtime-mode"]',
        );
        const describedBy = group?.getAttribute('aria-describedby') ?? '';
        expect(describedBy).not.toBe('');
        // `useId` values contain `:`, which is not a valid CSS selector.
        const srDescription = document.getElementById(describedBy);
        expect(srDescription?.className).toContain('sr-only');
        expect(srDescription?.textContent).toBe(
          'Teardown scripts can only be run as background commands.',
        );

        expect(rendered.container.textContent).toContain('Timeout');
        expect(
          getTimeoutOption(rendered.container, 'Custom').getAttribute(
            'aria-checked',
          ),
        ).toBe('true');
      } finally {
        rendered.cleanup();
      }
    },
  );

  it('shows the background-only reason as a tooltip on hover', () => {
    const rendered = renderScriptConfigEditor({
      scriptName: 'teardown',
      command: 'npm run clean',
      onInteractiveChange: jest.fn(),
    });
    try {
      const group = rendered.container.querySelector(
        '[data-testid="script-runtime-mode"]',
      );
      if (!(group instanceof HTMLElement)) {
        throw new Error('Expected the runtime mode group');
      }
      // Handlers live on the tooltip's wrapper span because the disabled
      // buttons themselves emit no pointer events.
      const wrapper = group.parentElement;
      if (!(wrapper instanceof HTMLElement)) {
        throw new Error('Expected a tooltip wrapper around the group');
      }

      expect(
        document.querySelector('[data-testid="script-runtime-mode-tooltip"]'),
      ).toBeNull();

      act(() => {
        wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });

      const tooltip = document.querySelector(
        '[data-testid="script-runtime-mode-tooltip"]',
      );
      expect(tooltip?.textContent).toBe(
        'Teardown scripts can only be run as background commands.',
      );

      act(() => {
        wrapper.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });

      expect(
        document.querySelector('[data-testid="script-runtime-mode-tooltip"]'),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('does not attach the locked tooltip to an editable picker', () => {
    const rendered = renderScriptConfigEditor({
      scriptName: 'wizard',
      command: 'npm run wizard',
      onInteractiveChange: jest.fn(),
    });
    try {
      const group = rendered.container.querySelector(
        '[data-testid="script-runtime-mode"]',
      );
      if (!(group instanceof HTMLElement)) {
        throw new Error('Expected the runtime mode group');
      }

      act(() => {
        group.parentElement?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });

      expect(
        document.querySelector('[data-testid="script-runtime-mode-tooltip"]'),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('renders the locked teardown picker even without a change handler', () => {
    // The settings modals wire teardown editors without `onInteractiveChange`.
    const rendered = renderScriptConfigEditor({
      scriptName: 'teardown',
      command: 'npm run clean',
      interactive: true,
    });
    try {
      expect(
        getRuntimeOption(rendered.container, 'background').getAttribute(
          'aria-checked',
        ),
      ).toBe('true');
      expect(getRuntimeOption(rendered.container, 'interactive').disabled).toBe(
        true,
      );

      act(() => {
        getRuntimeOption(rendered.container, 'interactive').click();
      });

      expect(rendered.container.textContent).toContain('Timeout');
    } finally {
      rendered.cleanup();
    }
  });

  it('omits the runtime picker when the surface cannot change it', () => {
    const rendered = renderScriptConfigEditor({
      scriptName: 'wizard',
      command: 'npm run wizard',
    });
    try {
      expect(
        rendered.container.querySelector('[data-testid="script-runtime-mode"]'),
      ).toBeNull();
      expect(rendered.container.textContent).toContain('Timeout');
    } finally {
      rendered.cleanup();
    }
  });
});

describe('ScriptConfigEditor shell selection', () => {
  it('merges rapid platform changes before the parent can rerender', () => {
    const onShellChange = jest.fn();
    const rendered = renderScriptConfigEditor({
      scriptName: 'setup',
      command: 'npm install',
      onShellChange,
    });

    try {
      const windows = rendered.container.querySelector(
        'select[aria-label="Script Windows shell"]',
      );
      const mac = rendered.container.querySelector(
        'select[aria-label="Script Mac shell"]',
      );
      if (!(windows instanceof HTMLSelectElement)) {
        throw new Error('Expected Windows shell select');
      }
      if (!(mac instanceof HTMLSelectElement)) {
        throw new Error('Expected Mac shell select');
      }

      act(() => {
        windows.value = 'bash';
        windows.dispatchEvent(new Event('change', { bubbles: true }));
        mac.value = 'zsh';
        mac.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(onShellChange).toHaveBeenNthCalledWith(1, {
        windows: 'bash',
      });
      expect(onShellChange).toHaveBeenNthCalledWith(2, {
        windows: 'bash',
        mac: 'zsh',
      });
    } finally {
      rendered.cleanup();
    }
  });
});

describe('ScriptConfigEditor dev server pattern validity', () => {
  it('clears reported invalid rows when the editor unmounts', () => {
    const onValidityChange = jest.fn();
    const rendered = renderScriptConfigEditor({
      scriptName: 'launch',
      command: 'npm run dev',
      devServerPatterns: [
        {
          id: 'pattern-1',
          pattern: '(',
          label: '',
        },
      ],
      onDevServerPatternsChange: jest.fn(),
      onDevServerPatternsValidityChange: onValidityChange,
    });

    expect(onValidityChange).toHaveBeenLastCalledWith(['pattern-1']);

    rendered.cleanup();

    expect(onValidityChange).toHaveBeenLastCalledWith([]);
  });

  it('clears the previous validity scope when the scope key changes', () => {
    const previousValidityChange = jest.fn();
    const nextValidityChange = jest.fn();
    const invalidPatterns: EditableDevServerPattern[] = [
      {
        id: 'pattern-1',
        pattern: '(',
        label: '',
      },
    ];
    const rendered = renderScriptConfigEditor({
      scriptName: 'launch',
      command: 'npm run dev',
      devServerPatterns: invalidPatterns,
      onDevServerPatternsChange: jest.fn(),
      onDevServerPatternsValidityChange: previousValidityChange,
      devServerPatternsValidityScopeKey: 'local:launch',
    });

    try {
      expect(previousValidityChange).toHaveBeenLastCalledWith(['pattern-1']);

      rendered.rerender({
        scriptName: 'launch',
        command: 'npm run dev',
        devServerPatterns: invalidPatterns,
        onDevServerPatternsChange: jest.fn(),
        onDevServerPatternsValidityChange: nextValidityChange,
        devServerPatternsValidityScopeKey: 'source:launch',
      });

      expect(previousValidityChange).toHaveBeenLastCalledWith([]);
      expect(nextValidityChange).toHaveBeenLastCalledWith(['pattern-1']);
    } finally {
      rendered.cleanup();
    }
  });
});

describe('ScriptConfigEditor dev-server Open target control', () => {
  it('renders the In Canopy / External control and the helper text', () => {
    const rendered = renderScriptConfigEditor({
      scriptName: 'launch',
      command: 'npm run dev',
      devServerPatterns: [
        {
          id: 'row-1',
          pattern: 'https?://\\S+',
          label: '',
          openTarget: 'in-app',
        },
      ],
      onDevServerPatternsChange: jest.fn(),
    });
    try {
      expect(buttonsByText(rendered.container, 'In Canopy')).toHaveLength(1);
      expect(buttonsByText(rendered.container, 'External')).toHaveLength(1);
      expect(rendered.container.textContent).toContain(
        'In Canopy opens links in the Browser tab. URLs blocked by the Browser settings open externally.',
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('reflects the selected open target via aria-pressed', () => {
    const rendered = renderScriptConfigEditor({
      scriptName: 'launch',
      command: 'npm run dev',
      devServerPatterns: [
        {
          id: 'row-1',
          pattern: 'https?://\\S+',
          label: '',
          openTarget: 'external',
        },
      ],
      onDevServerPatternsChange: jest.fn(),
    });
    try {
      const [inCanopy] = buttonsByText(rendered.container, 'In Canopy');
      const [external] = buttonsByText(rendered.container, 'External');
      expect(inCanopy.getAttribute('aria-pressed')).toBe('false');
      expect(external.getAttribute('aria-pressed')).toBe('true');
    } finally {
      rendered.cleanup();
    }
  });

  it('updates the editable pattern openTarget when External is clicked', () => {
    const onChange = jest.fn();
    const rendered = renderScriptConfigEditor({
      scriptName: 'launch',
      command: 'npm run dev',
      devServerPatterns: [
        {
          id: 'row-1',
          pattern: 'https?://\\S+',
          label: 'Web',
          openTarget: 'in-app',
        },
      ],
      onDevServerPatternsChange: onChange,
    });
    try {
      const [external] = buttonsByText(rendered.container, 'External');
      act(() => {
        external.click();
      });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith([
        {
          id: 'row-1',
          pattern: 'https?://\\S+',
          label: 'Web',
          openTarget: 'external',
        },
      ]);
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps validity behavior unchanged (valid row reports no invalid ids)', () => {
    const onValidity = jest.fn();
    const rendered = renderScriptConfigEditor({
      scriptName: 'launch',
      command: 'npm run dev',
      devServerPatterns: [
        {
          id: 'row-1',
          pattern: 'https?://\\S+',
          label: '',
          openTarget: 'in-app',
        },
      ],
      onDevServerPatternsChange: jest.fn(),
      onDevServerPatternsValidityChange: onValidity,
    });
    try {
      expect(onValidity).toHaveBeenLastCalledWith([]);
    } finally {
      rendered.cleanup();
    }
  });
});

interface RenderScriptConfigEditorOverrides {
  scriptName: string;
  command: string;
  timeoutSeconds?: number | null;
  onCommandChange?: (next: string) => void;
  onTimeoutSecondsChange?: (next: number | null | undefined) => void;
  interactive?: boolean;
  onInteractiveChange?: (next: boolean) => void;
  shell?: CommandShellDefinition;
  onShellChange?: (next: CommandShellDefinition | undefined) => void;
  devServerPatterns?: EditableDevServerPattern[];
  onDevServerPatternsChange?: (
    next: EditableDevServerPattern[] | undefined,
  ) => void;
  onDevServerPatternsValidityChange?: (invalidRowIds: string[]) => void;
  devServerPatternsValidityScopeKey?: string;
}

function renderScriptConfigEditor(
  overrides: RenderScriptConfigEditorOverrides,
): {
  container: HTMLElement;
  cleanup: () => void;
  rerender: (nextOverrides: RenderScriptConfigEditorOverrides) => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const render = (nextOverrides: RenderScriptConfigEditorOverrides): void => {
    root.render(
      createElement(ScriptConfigEditor, {
        label: 'Script',
        scriptName: nextOverrides.scriptName,
        command: nextOverrides.command,
        timeoutSeconds: nextOverrides.timeoutSeconds,
        onCommandChange: nextOverrides.onCommandChange ?? jest.fn(),
        onTimeoutSecondsChange:
          nextOverrides.onTimeoutSecondsChange ?? jest.fn(),
        interactive: nextOverrides.interactive,
        onInteractiveChange: nextOverrides.onInteractiveChange,
        shell: nextOverrides.shell,
        onShellChange: nextOverrides.onShellChange,
        defaultTimeoutSeconds: 300,
        devServerPatterns: nextOverrides.devServerPatterns,
        onDevServerPatternsChange: nextOverrides.onDevServerPatternsChange,
        onDevServerPatternsValidityChange:
          nextOverrides.onDevServerPatternsValidityChange,
        devServerPatternsValidityScopeKey:
          nextOverrides.devServerPatternsValidityScopeKey,
      }),
    );
  };

  act(() => {
    render(overrides);
  });

  return {
    container,
    rerender: (nextOverrides): void => {
      act(() => {
        render(nextOverrides);
      });
    },
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function getTimeoutOption(
  container: HTMLElement,
  label: 'Default' | 'Custom' | 'Disabled',
): HTMLButtonElement {
  const options = Array.from(container.querySelectorAll('button'));
  const option = options.find((button) => button.textContent === label);
  if (!(option instanceof HTMLButtonElement)) {
    throw new Error(`Timeout option not found: ${label}`);
  }
  return option;
}

function getRuntimeOption(
  container: HTMLElement,
  mode: 'background' | 'interactive',
): HTMLButtonElement {
  const option = container.querySelector(
    `[data-testid="script-runtime-mode-${mode}"]`,
  );
  if (!(option instanceof HTMLButtonElement)) {
    throw new Error(`Runtime option not found: ${mode}`);
  }
  return option;
}

function buttonsByText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter(
    (button): button is HTMLButtonElement => button.textContent === text,
  );
}
