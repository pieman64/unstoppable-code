/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import type { ShareGateContext } from '../useShareAccess';

const mockRequestShare = jest.fn<void, [ShareGateContext, () => void]>();
jest.mock('../useShareAccess', () => ({
  useShareAccess: (): Record<string, unknown> => ({
    requestShare: mockRequestShare,
    shareGateModal: null,
  }),
}));

import { type ShareAction, useShareAction } from '../useShareAction';

describe('useShareAction', () => {
  let container: HTMLElement;
  let root: Root;
  let action: ShareAction;

  function Probe(): null {
    action = useShareAction();
    return null;
  }

  function render(): void {
    act(() => {
      root.render(<Probe />);
    });
  }

  beforeEach(() => {
    mockRequestShare.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('routes a gated kind through the sign-in prompt with its own copy', () => {
    render();
    const open = jest.fn();
    action.share('skill', open);

    expect(open).not.toHaveBeenCalled();
    expect(mockRequestShare).toHaveBeenCalledTimes(1);
    const [context, proceed] = mockRequestShare.mock.calls[0] ?? [];
    expect(context?.title).toBe('Sign in to share');
    expect(context?.description).toContain('share this skill');
    expect(proceed).toBe(open);
  });

  it('keeps the plugin prompt about the public link', () => {
    render();
    action.share('plugin', jest.fn());
    expect(mockRequestShare.mock.calls[0]?.[0]).toEqual({
      title: 'Sign in to share plugins',
      description: 'Connect your account to create a public plugin link.',
    });
  });

  it.each(['agent', 'automation'] as const)(
    'opens the %s dialog directly, with no gate in front of it',
    (kind) => {
      render();
      const open = jest.fn();
      action.share(kind, open);

      expect(open).toHaveBeenCalledTimes(1);
      expect(mockRequestShare).not.toHaveBeenCalled();
    },
  );

  it('offers every kind', () => {
    render();
    for (const kind of [
      'skill',
      'pipeline',
      'collection',
      'plugin',
      'agent',
      'automation',
    ] as const) {
      expect(action.canShare(kind)).toBe(true);
    }
  });
});
