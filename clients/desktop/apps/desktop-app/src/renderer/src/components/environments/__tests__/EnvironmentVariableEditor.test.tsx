/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { type JSX, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UserEnvironmentEntryView } from '@canopy/desktop-shared/types';

import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { EnvironmentVariableEditor } from '../EnvironmentVariableEditor';
import { outermostReplayBlock } from '@/test-utils/replay';

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('EnvironmentVariableEditor', () => {
  it('keeps key/value rows mounted when controlled parent state echoes edits', () => {
    function Harness(): JSX.Element {
      const [variables, setVariables] = useState<UserEnvironmentEntryView[]>([
        { key: 'FOO', value: 'bar' },
      ]);
      return (
        <EnvironmentVariableEditor
          variables={variables}
          uiMode="key-value"
          encryptionAvailable={true}
          onVariablesChange={setVariables}
        />
      );
    }

    const { container, root } = render(<Harness />);
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid^="environment-editor-key-"]',
    );
    expect(input).not.toBeNull();
    if (!input) {
      return;
    }

    changeInput(input, 'FOOD');

    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid^="environment-editor-key-"]',
      ),
    ).toBe(input);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('shares one set of grid tracks between the header and each row', () => {
    const { container, root } = render(
      <EnvironmentVariableEditor
        variables={[
          { key: 'FOO', value: 'bar' },
          { key: 'BAZ', value: 'qux', secret: true },
        ]}
        uiMode="key-value"
        encryptionAvailable={true}
        onVariablesChange={(): void => {}}
      />,
    );

    const header = container.querySelector<HTMLElement>(
      '[data-testid="environment-editor-header-key"]',
    )?.parentElement;
    expect(header).toBeTruthy();

    // Scoped to `input`: the mode container carries the testid
    // `environment-editor-key-value`, which also matches a bare `^=` prefix.
    const rowCell = container.querySelector<HTMLElement>(
      'input[data-testid^="environment-editor-key-"]',
    )?.parentElement;
    expect(rowCell).toBeTruthy();

    // Header and row cells must be subgrids so their tracks resolve identically
    // instead of each grid sizing its own `auto` columns (the misalignment bug).
    expect(header?.className).toContain('grid-cols-subgrid');
    expect(rowCell?.className).toContain('grid-cols-subgrid');

    // ...and they must hang off the same track-declaring parent for subgrid to
    // inherit anything at all.
    expect(rowCell?.parentElement).toBe(header?.parentElement);
    expect(header?.parentElement?.className).toContain(
      'grid-cols-[1fr_1.5fr_auto_auto]',
    );

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  // `SharedContainerRunPanel` renders this same editor inside a much narrower
  // panel, so the subgrid invariant has to hold for that consumer's props too
  // (custom `testId`, `readOnly`) and not just the Environments page.
  it('shares grid tracks for the read-only shared-container consumer', () => {
    const { container, root } = render(
      <EnvironmentVariableEditor
        variables={[{ key: 'FOO', value: 'bar' }]}
        uiMode="key-value"
        encryptionAvailable={true}
        readOnly={true}
        testId="shared-container-run-env-editor"
        onVariablesChange={(): void => {}}
      />,
    );

    const header = container.querySelector<HTMLElement>(
      '[data-testid="environment-editor-header-key"]',
    )?.parentElement;
    const rowCell = container.querySelector<HTMLElement>(
      'input[data-testid^="environment-editor-key-"]',
    )?.parentElement;

    expect(header?.className).toContain('grid-cols-subgrid');
    expect(rowCell?.className).toContain('grid-cols-subgrid');
    expect(rowCell?.parentElement).toBe(header?.parentElement);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('associates a row validation message with its key input', () => {
    const { container, root } = render(
      <EnvironmentVariableEditor
        variables={[{ key: 'lower case', value: 'bar' }]}
        uiMode="key-value"
        encryptionAvailable={true}
        onVariablesChange={(): void => {}}
      />,
    );

    const keyInput = container.querySelector<HTMLInputElement>(
      'input[data-testid^="environment-editor-key-"]',
    );
    expect(keyInput).toBeTruthy();
    expect(keyInput?.getAttribute('aria-invalid')).toBe('true');

    const describedBy = keyInput?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    // Subgrid makes the message a flat grid item rather than a DOM sibling, so
    // the only remaining association is this explicit id reference.
    const message = describedBy
      ? container.querySelector<HTMLElement>(`#${describedBy}`)
      : null;
    expect(message).toBeTruthy();
    expect(message?.textContent?.length).toBeGreaterThan(0);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('switches views with the shared Settings segmented tabs and draws its buttons and fields from the shared kit', () => {
    const onUiModeChange = jest.fn();
    const { container, root } = render(
      <EnvironmentVariableEditor
        variables={[{ key: 'FOO', value: 'bar' }]}
        uiMode="key-value"
        encryptionAvailable={true}
        onVariablesChange={(): void => {}}
        onUiModeChange={onUiModeChange}
      />,
    );

    const tabs = container.querySelector<HTMLElement>(
      '[data-testid="environment-editor-mode"]',
    );
    expect(tabs).toBeInstanceOf(HTMLElement);
    expect(tabs?.getAttribute('role')).toBe('tablist');
    // The shared track: the sunk well at the 208px control width, capsule.
    expect(tabs?.className).toContain('bg-depth');
    expect(tabs?.className).toContain('min-w-52');
    expect(tabs?.className).toContain('rounded-full');
    const keyValue = container.querySelector<HTMLButtonElement>(
      '[data-testid="environment-editor-mode-key-value"]',
    );
    const bulk = container.querySelector<HTMLButtonElement>(
      '[data-testid="environment-editor-mode-bulk"]',
    );
    expect(keyValue?.getAttribute('role')).toBe('tab');
    expect(keyValue?.getAttribute('aria-selected')).toBe('true');
    expect(bulk?.getAttribute('aria-selected')).toBe('false');
    // Neutral selection: no accent ink or fill on either tab.
    expect(tabs?.innerHTML).not.toMatch(/fg-accent|bg-accent/);

    act(() => bulk?.click());
    expect(onUiModeChange).toHaveBeenCalledWith('bulk');

    // Add variable and Remove are the shared compact secondary capsule.
    for (const testId of [
      'environment-editor-add-row',
      'environment-editor-remove-',
    ]) {
      const button = container.querySelector<HTMLButtonElement>(
        `button[data-testid^="${testId}"]`,
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button?.className).toContain('h-7');
      expect(button?.className).toContain('rounded-full');
      expect(button?.className).not.toMatch(/hover:bg-(accent|destructive)/);
    }
    // The key field is the shared Settings text field.
    expect(
      container.querySelector<HTMLInputElement>(
        'input[data-testid^="environment-editor-key-"]',
      )?.className,
    ).toContain('shadow-field');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('keeps the other tab visible but unavailable while the current view has an error', () => {
    const onUiModeChange = jest.fn();
    const { container, root } = render(
      <EnvironmentVariableEditor
        variables={[{ key: 'lower case', value: 'bar' }]}
        uiMode="key-value"
        encryptionAvailable={true}
        onVariablesChange={(): void => {}}
        onUiModeChange={onUiModeChange}
      />,
    );
    const bulk = container.querySelector<HTMLButtonElement>(
      '[data-testid="environment-editor-mode-bulk"]',
    );
    expect(bulk).toBeInstanceOf(HTMLButtonElement);
    expect(bulk?.getAttribute('aria-disabled')).toBe('true');
    act(() => bulk?.click());
    expect(onUiModeChange).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it.each(['key-value', 'bulk'] as const)(
    'records the %s editor in session replay (the recorder masks input values)',
    (uiMode) => {
      const { container, root } = render(
        <EnvironmentVariableEditor
          variables={[{ key: 'API_TOKEN', value: 'secret', secret: true }]}
          uiMode={uiMode}
          encryptionAvailable={true}
          onVariablesChange={(): void => {}}
        />,
      );

      const editor = container.querySelector(
        '[data-testid="environment-variable-editor"]',
      );
      expect(editor).not.toBeNull();
      const anchor = container.querySelector(
        uiMode === 'key-value'
          ? '[data-testid="environment-editor-add-row"]'
          : '[data-testid="environment-editor-bulk-textarea"]',
      );
      expect(anchor).not.toBeNull();
      expect(outermostReplayBlock(anchor)).toBeNull();
      expect(
        editor?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
      ).toBeNull();

      act(() => {
        root.unmount();
      });
      container.remove();
    },
  );

  describe('saved secrets (CAN-4411)', () => {
    const stored = { kind: 'stored-secret', ref: 'ssr1_token' } as const;

    // React tracks the last value it saw, so set it through the native setter.
    function type(
      field: HTMLInputElement | HTMLTextAreaElement,
      value: string,
    ): void {
      const prototype =
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      act(() => {
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(
          field,
          value,
        );
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    function renderHarness(
      initial: UserEnvironmentEntryView[],
      uiMode: 'key-value' | 'bulk' = 'key-value',
    ): {
      container: HTMLDivElement;
      root: Root;
      latest: () => UserEnvironmentEntryView[];
    } {
      let latest = initial;
      function Harness(): JSX.Element {
        const [variables, setVariables] = useState(initial);
        return (
          <EnvironmentVariableEditor
            variables={variables}
            uiMode={uiMode}
            encryptionAvailable={true}
            onVariablesChange={(next): void => {
              latest = next;
              setVariables(next);
            }}
          />
        );
      }
      const rendered = render(<Harness />);
      return { ...rendered, latest: () => latest };
    }

    function unmount(container: HTMLDivElement, root: Root): void {
      act(() => {
        root.unmount();
      });
      container.remove();
    }

    it('shows a saved secret as set, keeps it, and locks its secret mark until replaced', () => {
      const { container, root, latest } = renderHarness([
        { key: 'TOKEN', value: stored, secret: true },
      ]);
      const value = container.querySelector<HTMLInputElement>(
        'input[data-testid^="environment-editor-value-"]',
      );
      const secret = container.querySelector<HTMLInputElement>(
        'input[data-testid^="environment-editor-secret-"]',
      );
      const key = container.querySelector<HTMLInputElement>(
        'input[data-testid^="environment-editor-key-"]',
      );
      expect(value?.value).toBe('');
      expect(value?.placeholder).toBe('Saved. Type to replace');
      expect(secret?.disabled).toBe(true);
      if (!value || !key) return;

      type(key, 'RENAMED');
      expect(latest()).toEqual([
        { key: 'RENAMED', value: stored, secret: true },
      ]);

      type(value, 'replacement');
      expect(latest()).toEqual([
        { key: 'RENAMED', value: 'replacement', secret: true },
      ]);
      expect(secret?.disabled).toBe(false);
      unmount(container, root);
    });

    it('keeps a saved secret marked secret when its replacement is cleared', () => {
      const { container, root, latest } = renderHarness([
        { key: 'TOKEN', value: stored, secret: true },
      ]);
      const value = container.querySelector<HTMLInputElement>(
        'input[data-testid^="environment-editor-value-"]',
      );
      const secret = container.querySelector<HTMLInputElement>(
        'input[data-testid^="environment-editor-secret-"]',
      );
      if (!value || !secret) throw new Error('Expected editor row');
      type(value, 'replacement');
      act(() => {
        secret.click();
      });
      expect(latest()).toEqual([{ key: 'TOKEN', value: 'replacement' }]);
      type(value, '');
      expect(latest()).toEqual([{ key: 'TOKEN', value: stored, secret: true }]);
      expect(secret.checked).toBe(true);
      unmount(container, root);
    });

    it('keeps saved secrets out of bulk text and keeps them across bulk edits', () => {
      const { container, root, latest } = renderHarness(
        [
          { key: 'TOKEN', value: stored, secret: true },
          { key: 'LEVEL', value: 'debug', secret: true },
        ],
        'bulk',
      );
      const textarea = container.querySelector<HTMLTextAreaElement>(
        '[data-testid="environment-editor-bulk-textarea"]',
      );
      expect(textarea?.value).toBe('LEVEL=debug');
      expect(
        container.querySelector(
          '[data-testid="environment-editor-bulk-stored"]',
        )?.textContent,
      ).toContain('TOKEN');
      if (!textarea) return;

      type(textarea, 'LEVEL=info\nADDED=1');
      expect(latest()).toEqual([
        { key: 'TOKEN', value: stored, secret: true },
        { key: 'LEVEL', value: 'info', secret: true },
        { key: 'ADDED', value: '1' },
      ]);
      // A line may not name a saved secret, so bulk editing never replaces
      // or drops one; the editor says where to edit it instead.
      type(textarea, 'LEVEL=info\nTOKEN=');
      expect(
        container.querySelector(
          '[data-testid="environment-editor-bulk-validation"]',
        )?.textContent,
      ).toBe('TOKEN is a saved secret. Edit it in Key-Value.');
      type(textarea, 'LEVEL=debug');
      expect(latest()).toEqual([
        { key: 'TOKEN', value: stored, secret: true },
        { key: 'LEVEL', value: 'debug', secret: true },
      ]);
      unmount(container, root);
    });
  });
});
