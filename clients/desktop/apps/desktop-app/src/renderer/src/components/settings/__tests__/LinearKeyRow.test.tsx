/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';
import { LinearKeyRow } from '../LinearKeyRow';

jest.mock('@/hooks/useLinearStatus', () => ({
  invalidateLinearStatusCache: jest.fn(),
  useLinearStatus: jest.fn((token: string) =>
    token
      ? { authenticated: true, displayName: 'Linear User', error: null }
      : null,
  ),
}));

describe('LinearKeyRow', () => {
  let container: HTMLElement;
  let root: Root;
  const loadLinearToken = jest.fn();
  const saveLinearToken = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loadLinearToken.mockResolvedValue('lin_api_saved');
    saveLinearToken.mockResolvedValue({ success: true });
    Object.assign(window, {
      api: { loadLinearToken, saveLinearToken },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  async function renderRow(): Promise<void> {
    await act(async () => {
      root.render(<LinearKeyRow />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function tokenInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-linear-token-input"]',
    );
    if (!input) throw new Error('Linear token input not found');
    return input;
  }

  it('renders one bare row, so the caller places it in a group or card', async () => {
    await renderRow();

    expect(container.children).toHaveLength(1);
    expect(container.querySelector('section')).toBeNull();
    expect(tokenInput().value).toBe('lin_api_saved');
    expect(tokenInput().disabled).toBe(false);
  });

  it('blocks only the Linear account name from session replay', async () => {
    await renderRow();

    expect(container.textContent).toContain('Signed in as Linear User');
    expectReplayBlocksOnlyValue(container, 'Linear User');
    expect(outermostReplayBlock(tokenInput())).toBeNull();
  });
});
