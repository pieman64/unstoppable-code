/** @jest-environment jsdom */

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setNativeInputValue } from '@/test-utils/dom';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { MemoryUsedButton } from '../MemoryUsedDialog';

const mockOpenAccountOrganizationPage = jest.fn<
  'settings' | 'web',
  [unknown]
>();
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openAccountOrganizationPage: (route: unknown): 'settings' | 'web' =>
    mockOpenAccountOrganizationPage(route),
}));

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('MemoryUsedButton', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const submitOrgMemoryFeedback = jest.fn();
  const getOrgMemoryFeedback = jest.fn();
  const loadCanopyCloudAccount = jest.fn();

  beforeEach(() => {
    submitOrgMemoryFeedback.mockReset();
    submitOrgMemoryFeedback.mockResolvedValue({ recorded: true });
    loadCanopyCloudAccount.mockReset();
    loadCanopyCloudAccount.mockResolvedValue({ capabilities: [] });
    getOrgMemoryFeedback.mockReset();
    getOrgMemoryFeedback.mockResolvedValue({
      feedback: null,
      canSubmit: true,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getOrgMemoryFeedback,
        submitOrgMemoryFeedback,
        loadCanopyCloudAccount,
      },
    });
  });

  afterEach(() => {
    // Unmount before resetting the store and API so a re-render never runs
    // against the restored (absent) preload API.
    act(() => root?.unmount());
    root = null;
    useWorkspaceContextStore.setState((store) => ({
      state: { ...store.state, organizations: [] },
    }));
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('stays read-only for legacy facts persisted without fact ids', () => {
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            facts: [
              {
                factText: 'The deployment region is eu-west-1.',
                validAt: '2026-07-13',
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });

    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="memory-used-button"]',
    );
    expect(button?.textContent).toContain('1 memory used');
    expect(button?.getAttribute('aria-label')).toBe(
      'Show organization memories used for this message',
    );

    act(() => button?.click());

    const dialog = document.querySelector('[data-testid="memory-used-dialog"]');
    expect(dialog?.textContent).toContain(
      'The deployment region is eu-west-1.',
    );
    expect(dialog?.textContent).toContain('As of 2026-07-13');
    expect(dialog?.textContent).toContain('Organization');
    expect(dialog?.querySelector('textarea')).toBeNull();
    expect(
      dialog?.querySelector('[data-testid="memory-feedback-like"]'),
    ).toBeNull();
  });

  it('names the searched organization in the intro and on each fact', async () => {
    useWorkspaceContextStore.setState((store) => ({
      state: {
        ...store.state,
        organizations: [
          { id: ORG_B, name: 'Beta', role: 'MEMBER' },
          { id: ORG_A, name: 'Acme', role: 'MEMBER' },
        ],
      },
    }));
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            organizationExternalId: ORG_A,
            searchId: 'search-1',
            facts: [
              {
                factId: 'fact-1',
                factText: 'The database proxy uses port 4031.',
                validAt: null,
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click(),
    );
    await act(async () => {});

    expect(
      document.querySelector('[data-testid="memory-used-intro"]')?.textContent,
    ).toContain("Suggestions from Acme's past sessions");
    expect(
      document.querySelector('[data-testid="memory-used-organization-name"]')
        ?.textContent,
    ).toBe('Acme');
    expect(
      document.querySelector('[data-testid="memory-used-fact-organization"]')
        ?.textContent,
    ).toBe('Acme');
    expect(document.body.textContent).not.toContain('Beta');
    expect(
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.getAttribute('aria-label'),
    ).toBe('Show organization memories used for this message');
  });

  describe('View in organization memory', () => {
    async function openDialog(
      role: 'OWNER' | 'ADMIN' | 'MEMBER',
      factId: string | null = 'fact-1',
      memoryOrganizationId: string = ORG_A,
    ): Promise<void> {
      useWorkspaceContextStore.setState((store) => ({
        state: {
          ...store.state,
          organizations: [{ id: ORG_A, name: 'Acme', role }],
        },
      }));
      root = createRoot(document.body);
      act(() => {
        root?.render(
          <MemoryUsedButton
            memory={{
              organizationExternalId: memoryOrganizationId,
              searchId: 'search-1',
              facts: [
                {
                  ...(factId === null ? {} : { factId }),
                  factText: 'The database proxy uses port 4031.',
                  validAt: null,
                  sourceTurnIds: ['turn-1'],
                },
              ],
            }}
          />,
        );
      });
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="memory-used-button"]',
          )
          ?.click(),
      );
      await act(async () => {});
    }

    function viewButton(): HTMLButtonElement | null {
      return document.querySelector<HTMLButtonElement>(
        '[data-testid="memory-used-fact-view-in-memory"]',
      );
    }

    beforeEach(() => mockOpenAccountOrganizationPage.mockReset());

    it.each([
      ['OWNER', 'settings', false],
      ['ADMIN', 'settings', false],
      ['OWNER', 'web', true],
    ] as const)(
      'lets an %s open the fact (%s keeps the dialog: %p)',
      async (role, result, staysOpen) => {
        mockOpenAccountOrganizationPage.mockReturnValue(result);
        await openDialog(role);
        act(() => viewButton()?.click());
        expect(mockOpenAccountOrganizationPage).toHaveBeenCalledWith({
          scope: 'organization',
          organizationId: ORG_A,
          page: 'memory',
          factId: 'fact-1',
        });
        expect(
          document.querySelector('[data-testid="memory-used-dialog"]') !== null,
        ).toBe(staysOpen);
      },
    );

    it("opens the membership's ID when the turn's ID differs in case", async () => {
      mockOpenAccountOrganizationPage.mockReturnValue('settings');
      await openDialog('OWNER', 'fact-1', ORG_A.toUpperCase());
      act(() => viewButton()?.click());
      expect(mockOpenAccountOrganizationPage).toHaveBeenCalledWith({
        scope: 'organization',
        organizationId: ORG_A,
        page: 'memory',
        factId: 'fact-1',
      });
    });

    it('is absent for a member, who cannot open organization memory', async () => {
      await openDialog('MEMBER');
      expect(viewButton()).toBeNull();
    });

    it('is absent for a fact without an ID', async () => {
      await openDialog('OWNER', null);
      expect(viewButton()).toBeNull();
    });
  });

  it('names the org from the cloud account when the context mirror lists none', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      capabilities: ['memorySearch'],
      organizations: [
        { id: ORG_B, name: 'Beta' },
        { id: ORG_A.toUpperCase(), name: 'Acme' },
      ],
    });
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            organizationExternalId: ORG_A,
            facts: [
              {
                factText: 'The database proxy uses port 4031.',
                validAt: null,
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click(),
    );
    await act(async () => {});

    expect(
      document.querySelector('[data-testid="memory-used-organization-name"]')
        ?.textContent,
    ).toBe('Acme');
    expect(loadCanopyCloudAccount).toHaveBeenCalledTimes(1);
  });

  it('shows facts but hides feedback for a legacy turn without a searched org', async () => {
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            searchId: 'search-1',
            facts: [
              {
                factId: 'fact-1',
                factText: 'The database proxy uses port 4031.',
                validAt: null,
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click(),
    );
    await act(async () => {});

    const dialog = document.querySelector('[data-testid="memory-used-dialog"]');
    expect(dialog?.textContent).toContain('The database proxy uses port 4031.');
    expect(
      dialog?.querySelector('[data-testid="memory-used-fact-organization"]')
        ?.textContent,
    ).toBe('Organization');
    expect(
      dialog?.querySelector('[data-testid="memory-used-organization-name"]'),
    ).toBeNull();
    expect(
      dialog?.querySelector('[data-testid="memory-feedback-like"]'),
    ).toBeNull();
    expect(getOrgMemoryFeedback).not.toHaveBeenCalled();
    expect(submitOrgMemoryFeedback).not.toHaveBeenCalled();
    expect(loadCanopyCloudAccount).not.toHaveBeenCalled();
  });

  it('submits once and replaces the controls with an animated confirmation', async () => {
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            organizationExternalId: ORG_A,
            searchId: 'search-1',
            facts: [
              {
                factId: 'fact-1',
                factText: 'The database proxy uses port 4031.',
                validAt: null,
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click(),
    );
    await act(async () => {});

    const like = document.querySelector<HTMLButtonElement>(
      '[data-testid="memory-feedback-like"]',
    );
    await act(async () => {
      like?.click();
      await Promise.resolve();
    });
    expect(submitOrgMemoryFeedback).toHaveBeenCalledWith({
      organizationExternalId: ORG_A,
      searchId: 'search-1',
      factId: 'fact-1',
      rating: 'like',
    });
    expect(submitOrgMemoryFeedback).toHaveBeenCalledTimes(1);
    const submitted = document.querySelector(
      '[data-testid="memory-feedback-submitted"]',
    );
    expect(submitted?.textContent).toContain('Feedback submitted');
    expect(submitted?.className).toContain('animate-fade-in');
    expect(
      document.querySelector('[data-testid="memory-feedback-dislike"]'),
    ).toBeNull();
  });

  it('restores retry controls when feedback IPC rejects', async () => {
    submitOrgMemoryFeedback.mockRejectedValueOnce(new Error('IPC unavailable'));
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            organizationExternalId: ORG_A,
            searchId: 'search-1',
            facts: [
              {
                factId: 'fact-1',
                factText: 'The database proxy uses port 4031.',
                validAt: null,
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click(),
    );
    await act(async () => {});

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-feedback-like"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Couldn’t submit. Try again.');
    expect(
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-feedback-like"]',
        )
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
    expect(document.body.textContent).not.toContain('Submitting…');
    expect(
      Array.from(document.querySelectorAll('span')).find((element) =>
        element.textContent?.includes('Couldn’t submit.'),
      )?.className,
    ).toContain('fg-destructive');
  });

  it('clears the optimistic rating when feedback is declined', async () => {
    submitOrgMemoryFeedback.mockResolvedValueOnce({ recorded: false });
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            organizationExternalId: ORG_A,
            searchId: 'search-1',
            facts: [
              {
                factId: 'fact-1',
                factText: 'The database proxy uses port 4031.',
                validAt: null,
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click(),
    );
    await act(async () => {});

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-feedback-like"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Couldn’t submit. Try again.');
    expect(
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-feedback-like"]',
        )
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('allows a comment as the single feedback submission', async () => {
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            organizationExternalId: ORG_A,
            searchId: 'search-1',
            facts: [
              {
                factId: 'fact-1',
                factText: 'The database proxy uses port 4031.',
                validAt: null,
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click(),
    );
    await act(async () => {});

    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-feedback-comment-toggle"]',
        )
        ?.click(),
    );
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="memory-feedback-comment-input"]',
    );
    expect(input).not.toBeNull();
    act(() => {
      if (input) {
        setNativeInputValue(input, '  Port moved to 4032 last week.  ');
      }
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-feedback-comment-send"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(submitOrgMemoryFeedback).toHaveBeenLastCalledWith({
      organizationExternalId: ORG_A,
      searchId: 'search-1',
      factId: 'fact-1',
      comment: 'Port moved to 4032 last week.',
    });
    expect(document.body.textContent).toContain('Feedback submitted');
  });

  it('includes typed comment text when a rating submits the feedback', async () => {
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            organizationExternalId: ORG_A,
            searchId: 'search-1',
            facts: [
              {
                factId: 'fact-1',
                factText: 'The database proxy uses port 4031.',
                validAt: null,
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click(),
    );
    await act(async () => {});

    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-feedback-comment-toggle"]',
        )
        ?.click(),
    );
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="memory-feedback-comment-input"]',
    );
    act(() => {
      if (input) setNativeInputValue(input, '  Stale port information.  ');
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-feedback-dislike"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(submitOrgMemoryFeedback).toHaveBeenLastCalledWith({
      organizationExternalId: ORG_A,
      searchId: 'search-1',
      factId: 'fact-1',
      rating: 'dislike',
      comment: 'Stale port information.',
    });
    expect(document.body.textContent).toContain('Feedback submitted');
  });

  it('retrieves prior feedback and never re-enables its controls', async () => {
    getOrgMemoryFeedback.mockResolvedValueOnce({
      feedback: {
        rating: 'dislike',
        createdAt: '2026-07-31T10:00:00.000Z',
      },
      canSubmit: false,
    });
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            organizationExternalId: ORG_A,
            searchId: 'search-1',
            facts: [
              {
                factId: 'fact-1',
                factText: 'The database proxy uses port 4031.',
                validAt: null,
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click(),
    );
    await act(async () => {});

    expect(getOrgMemoryFeedback).toHaveBeenCalledWith({
      organizationExternalId: ORG_A,
      searchId: 'search-1',
      factId: 'fact-1',
    });
    expect(document.body.textContent).toContain('Feedback submitted');
    expect(
      document.querySelector('[data-testid="memory-feedback-like"]'),
    ).toBeNull();
    expect(submitOrgMemoryFeedback).not.toHaveBeenCalled();
  });

  it('keeps an expired unsubmitted occurrence read-only', async () => {
    getOrgMemoryFeedback.mockResolvedValueOnce({
      feedback: null,
      canSubmit: false,
    });
    root = createRoot(document.body);
    act(() => {
      root?.render(
        <MemoryUsedButton
          memory={{
            organizationExternalId: ORG_A,
            searchId: 'expired-search',
            facts: [
              {
                factId: 'fact-1',
                factText: 'The database proxy uses port 4031.',
                validAt: null,
                sourceTurnIds: ['turn-1'],
              },
            ],
          }}
        />,
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="memory-used-button"]')
        ?.click(),
    );
    await act(async () => {});

    expect(
      document.querySelector('[data-testid="memory-feedback-like"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain('Checking feedback');
    expect(submitOrgMemoryFeedback).not.toHaveBeenCalled();
  });
});
