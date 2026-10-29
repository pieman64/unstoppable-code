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
import type { UserEnvironmentEntry } from '@canopy/desktop-shared/types';

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
      const [variables, setVariables] = useState<UserEnvironmentEntry[]>([
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
});
