/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SettingsOperationError,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import { FEATURED_LIMIT_ERROR } from '@canopy/protocol/settings/account-publishing';
import {
  usePublicProfileEditor,
  type UsePublicProfileEditorResult,
} from '../use-public-profile-editor';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';

const SENTINEL = 'SENTINEL-SERVER-BODY';

describe('usePublicProfileEditor errors', () => {
  let container: HTMLElement;
  let root: Root;
  let editor: UsePublicProfileEditorResult | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    editor = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Harness(): JSX.Element {
    editor = usePublicProfileEditor();
    return <p data-testid="error">{editor.error?.copy}</p>;
  }

  function render(
    handlers: Partial<Record<SettingsOperationName, FakeSettingsHandler>>,
  ): void {
    const { host } = createTestSettingsHost({
      client: createFakeSettingsClient(handlers),
    });
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <Harness />
        </TestSettingsHost>,
      );
    });
  }

  async function publish(): Promise<void> {
    await act(async () => {
      await editor?.publishArtifact('runs', 'run-1');
    });
  }

  function refusal(status: number, serverCode?: string): () => never {
    return () => {
      throw new SettingsOperationError({
        code: 'failed',
        status,
        message: SENTINEL,
        ...(serverCode !== undefined ? { serverCode } : {}),
      });
    };
  }

  it('shows the featured-work limit copy for its code', async () => {
    render({
      'account.profile.artifacts.publish': refusal(409, 'featured_limit'),
    });
    await publish();

    expect(editor?.error?.copy).toBe(FEATURED_LIMIT_ERROR);
    expect(container.textContent).not.toContain(SENTINEL);
  });

  it('asks for a Private skill when the route refuses a shared one', async () => {
    render({
      'account.profile.artifacts.publish': refusal(409, 'skill_not_private'),
    });
    await publish();

    expect(editor?.error?.copy).toBe(
      'Move this skill to Private before adding it to your profile.',
    );
  });

  it('shows generic copy, never the route text, for any other refusal', async () => {
    render({ 'account.profile.artifacts.publish': refusal(409) });
    await publish();

    expect(editor?.error?.copy).toBe(
      "Couldn't add this to your profile. Try again.",
    );
    expect(container.textContent).not.toContain(SENTINEL);
  });
});
