/** @jest-environment jsdom */
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): null => null,
}));
jest.mock('@/hooks/useMarketplaceList', () => ({
  useMarketplaceList: (): {
    cache: { marketplaces: never[] };
    loading: boolean;
    refresh: jest.Mock;
  } => ({
    cache: { marketplaces: [] },
    loading: false,
    refresh: jest.fn(),
  }),
}));
jest.mock('@/hooks/useInvocableInventory', () => ({
  useInvocableInventory: (): {
    entries: never[];
    loading: boolean;
    refresh: jest.Mock;
  } => ({
    entries: [],
    loading: false,
    refresh: jest.fn(),
  }),
}));

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditableHooks } from '@/lib/editableHooks';
import { HookActionEditor } from '../HookActionEditor';
import { ScriptCommandEditor } from '../ScriptCommandEditor';
import { ScriptConfigEditor } from '../ScriptConfigEditor';
import { outermostReplayBlock } from '@/test-utils/replay';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('script and hook editors in session replay', () => {
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

  async function render(node: JSX.Element): Promise<Element> {
    await act(async () => {
      root.render(node);
      await Promise.resolve();
    });
    const editor = container.firstElementChild;
    if (!editor) throw new Error('Editor did not render');
    return editor;
  }

  /**
   * Commands and hook configuration are not output: session replay records
   * them, and the recorder masks every input and textarea value itself.
   */
  function expectNothingBlocked(editor: Element): void {
    expect(outermostReplayBlock(editor)).toBeNull();
    const fields = Array.from(
      container.querySelectorAll('input, textarea, select'),
    );
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(outermostReplayBlock(field)).toBeNull();
    }
  }

  it('records the script config editor', async () => {
    const editor = await render(
      <ScriptConfigEditor
        label="Setup script"
        scriptName="setup"
        command="export API_TOKEN=secret"
        timeoutSeconds={120}
        onCommandChange={(): void => undefined}
        onTimeoutSecondsChange={(): void => undefined}
        defaultTimeoutSeconds={300}
        devServerPatterns={[]}
        onDevServerPatternsChange={(): void => undefined}
      />,
    );
    expect(container.querySelector('textarea')?.value).toBe(
      'export API_TOKEN=secret',
    );
    expectNothingBlocked(editor);
  });

  it('records the script command editor', async () => {
    const editor = await render(
      <ScriptCommandEditor
        label="Command"
        value="export API_TOKEN=secret"
        onChange={(): void => undefined}
      />,
    );
    expectNothingBlocked(editor);
  });

  it('records every hook action and the add-action form', async () => {
    const hooks: EditableHooks = {
      'pr:create': [
        {
          uiId: 'command-hook',
          type: 'command',
          command: 'curl -H "Authorization: Bearer secret" example.test',
        },
      ],
    };
    const editor = await render(
      <HookActionEditor
        hooks={hooks}
        onChange={(): void => undefined}
        allowDisable={false}
        pluginSelectionMode="portable"
      />,
    );
    expect(container.textContent).toContain('Add hook action');
    expectNothingBlocked(editor);
  });
});
