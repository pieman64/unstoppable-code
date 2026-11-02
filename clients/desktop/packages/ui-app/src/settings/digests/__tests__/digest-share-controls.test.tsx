/** @jest-environment jsdom */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SettingsOperationError,
  settingsErrorCodeForStatus,
} from '@canopy/protocol/settings';
import {
  DigestShareControls,
  type DigestShareControlsProps,
} from '../digest-share-controls';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';

let container: HTMLDivElement;
let root: Root;
let client: FakeSettingsClient = createFakeSettingsClient();

/** The test host's web origin, which every absolute share URL resolves on. */
const WEB_ORIGIN = 'https://canopy.test';

function Controls(props: DigestShareControlsProps): JSX.Element {
  const { host } = createTestSettingsHost({
    client,
    privacy: { blockClassName: 'replay-block', maskClassName: 'replay-mask' },
  });
  return (
    <TestSettingsHost host={host}>
      <DigestShareControls {...props} />
    </TestSettingsHost>
  );
}

// `stubClipboard` redefines a global for the whole Jest environment.
// Restoring the ORIGINAL descriptor (rather than deleting the property) is the
// only correct undo: `clipboard` may or may not exist on the jsdom navigator,
// and a blanket delete would strip a real one.
const globalRestores: (() => void)[] = [];

function stubGlobal(target: object, property: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, property);
  globalRestores.push(() => {
    if (original) Object.defineProperty(target, property, original);
    else Reflect.deleteProperty(target, property);
  });
  Object.defineProperty(target, property, { configurable: true, value });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  while (globalRestores.length > 0) globalRestores.pop()?.();
  client = createFakeSettingsClient();
});

// The trigger stays inside `container`; everything it opens is portaled.
function trigger(): HTMLButtonElement {
  const value = container.querySelector('[data-testid="digest-share-trigger"]');
  if (!(value instanceof HTMLButtonElement))
    throw new Error('Missing digest-share-trigger');
  return value;
}

// `FloatingMenu` and `DialogModal` both portal to document.body, so neither the
// popover nor the dialog is ever inside `container`.
function queryPopover(): Element | null {
  return document.body.querySelector('[data-testid="digest-share-popover"]');
}

function button(testId: string): HTMLButtonElement {
  const value = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(value instanceof HTMLButtonElement))
    throw new Error(`Missing ${testId}`);
  return value;
}

function queryDialog(): Element | null {
  return document.body.querySelector(
    '[data-testid="digest-share-confirm-dialog"]',
  );
}

function confirmButton(): HTMLButtonElement {
  const dialog = queryDialog();
  if (!dialog) throw new Error('Confirmation dialog is not open');
  const value = dialog.querySelector('[data-testid="confirm-dialog-confirm"]');
  if (!(value instanceof HTMLButtonElement))
    throw new Error('Missing confirm button');
  return value;
}

/**
 * Answers both share operations the way the server does and records what was
 * asked: the mutation `body` (action and sharing state), and the operation
 * plus the digest and organization it targeted.
 */
function stubShare(bodies: unknown[], targets: string[] = []): void {
  const handle =
    (operation: string) =>
    (input: unknown): unknown => {
      if (typeof input !== 'object' || input === null)
        throw new Error('Expected an input object');
      const { digestId, organizationId, ...body }: Record<string, unknown> = {
        ...input,
      };
      targets.push(
        [operation, organizationId, digestId]
          .filter((part): part is string => typeof part === 'string')
          .join(':'),
      );
      bodies.push(body);
      return {
        sharePath:
          body.action === 'rotate'
            ? '/share/digests/new-slug'
            : '/share/digests/old-slug',
        // Rotating replaces the slug on a digest that is already shared, so
        // the server always answers `true` — sharing cannot be rotated into
        // an off state.
        sharingEnabled:
          body.action === 'set-sharing' ? body.sharingEnabled : true,
      };
    };
  client = createFakeSettingsClient({
    'account.digests.share.update': handle('account.digests.share.update'),
    'organization.digests.sharing.update': handle(
      'organization.digests.sharing.update',
    ),
  });
}

function stubClipboard(): jest.Mock {
  const writeText = jest.fn(async (): Promise<void> => {
    await Promise.resolve();
  });
  stubGlobal(globalThis.navigator, 'clipboard', { writeText });
  return writeText;
}

async function render(
  sharingEnabled = true,
  owner: DigestShareControlsProps['owner'] = { kind: 'account' },
): Promise<void> {
  await act(async () => {
    root.render(
      <Controls
        owner={owner}
        digestId="digest-1"
        initialSharePath="/share/digests/old-slug"
        initialSharingEnabled={sharingEnabled}
      />,
    );
    await Promise.resolve();
  });
}

/** Everything but the trigger lives behind a user interaction now. */
async function openPopover(): Promise<void> {
  await act(async () => {
    trigger().click();
    await Promise.resolve();
  });
}

describe('DigestShareControls', () => {
  it('toggles sharing and rotates the capability link through the owning API', async () => {
    const bodies: unknown[] = [];
    const urls: string[] = [];
    stubShare(bodies, urls);
    await render();
    await openPopover();

    await act(async () => {
      button('digest-sharing-toggle').click();
      await Promise.resolve();
    });
    await act(async () => {
      confirmButton().click();
      await Promise.resolve();
    });
    // Rotating is only offered while sharing is on, so turn it back on first.
    await act(async () => {
      button('digest-sharing-toggle').click();
      await Promise.resolve();
    });
    await act(async () => {
      button('digest-rotate-share-link').click();
      await Promise.resolve();
    });
    await act(async () => {
      confirmButton().click();
      await Promise.resolve();
    });

    expect(bodies).toEqual([
      { action: 'set-sharing', sharingEnabled: false },
      { action: 'set-sharing', sharingEnabled: true },
      { action: 'rotate' },
    ]);
    expect(urls).toEqual([
      'account.digests.share.update:digest-1',
      'account.digests.share.update:digest-1',
      'account.digests.share.update:digest-1',
    ]);
    expect(document.body.textContent).toContain(
      'Previous links no longer work',
    );
  });

  // Both actions permanently invalidate every URL already distributed, and
  // there is no undo. Naming the consequence after the mutation is the wrong
  // order — a user tapping the switch to see what it does should not discover
  // it by breaking a link they pasted into a channel.
  it.each([
    ['digest-sharing-toggle', 'Turn off sharing?'],
    ['digest-rotate-share-link', 'Create a new share link?'],
  ])('confirms before %s invalidates existing links', async (testId, title) => {
    const bodies: unknown[] = [];
    stubShare(bodies);
    await render();
    await openPopover();

    await act(async () => {
      button(testId).click();
      await Promise.resolve();
    });

    expect(queryDialog()).not.toBeNull();
    expect(document.body.textContent).toContain(title);
    expect(bodies).toEqual([]);
    // The popover and the dialog both portal to the body, so leaving the
    // popover open would make the dialog read as an outside press.
    expect(queryPopover()).toBeNull();
  });

  it('cancelling leaves the existing link untouched', async () => {
    const bodies: unknown[] = [];
    stubShare(bodies);
    await render();
    await openPopover();

    await act(async () => {
      button('digest-rotate-share-link').click();
      await Promise.resolve();
    });
    const cancel = Array.from(
      queryDialog()?.querySelectorAll('button') ?? [],
    ).find((element) => element.firstChild?.textContent === 'Cancel');
    await act(async () => {
      cancel?.click();
      await Promise.resolve();
    });

    expect(queryDialog()).toBeNull();
    expect(bodies).toEqual([]);
  });

  // Turning sharing ON is additive: nothing is invalidated, so an extra modal
  // would just be friction.
  it('enables sharing without a confirmation step', async () => {
    const bodies: unknown[] = [];
    stubShare(bodies);
    await render(false);
    await openPopover();

    await act(async () => {
      button('digest-sharing-toggle').click();
      await Promise.resolve();
    });

    expect(bodies).toEqual([{ action: 'set-sharing', sharingEnabled: true }]);
  });

  it('labels the trigger by live sharing state and updates it after enabling', async () => {
    const bodies: unknown[] = [];
    stubShare(bodies);
    await render(false);

    expect(trigger().textContent).toContain('Share');
    expect(trigger().textContent).not.toContain('Shared');

    await openPopover();
    await act(async () => {
      button('digest-sharing-toggle').click();
      await Promise.resolve();
    });

    expect(trigger().textContent).toContain('Shared');
  });

  it('labels the trigger Shared when sharing is already on', async () => {
    stubShare([]);
    await render();

    expect(trigger().textContent).toContain('Shared');
  });

  it('opens the popover from the trigger and closes it on Escape', async () => {
    stubShare([]);
    await render();

    expect(queryPopover()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    await openPopover();

    expect(queryPopover()).not.toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(queryPopover()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('returns focus to the trigger when the visible close button closes it', async () => {
    stubShare([]);
    await render();
    await openPopover();

    const close = document.body.querySelector('button[aria-label="Close"]');
    if (!(close instanceof HTMLButtonElement))
      throw new Error('Missing popover close button');
    close.focus();

    await act(async () => {
      close.click();
      await Promise.resolve();
    });

    expect(queryPopover()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  // Opening a confirmation unmounts the control that was just activated, so
  // without an explicit hand-off focus falls to `<body>` and a keyboard user
  // has to traverse the entire page to reach a dialog portaled to the end of
  // it. The dialog then claims focus itself (asserted separately below).
  it.each([['digest-sharing-toggle'], ['digest-rotate-share-link']])(
    'moves focus off the unmounted control when %s opens its confirmation',
    async (testId) => {
      stubShare([]);
      await render();
      await openPopover();

      const control = button(testId);
      control.focus();
      expect(document.activeElement).toBe(control);

      await act(async () => {
        control.click();
        await Promise.resolve();
      });

      const dialog = queryDialog();
      expect(dialog).not.toBeNull();
      expect(queryPopover()).toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      // Focus must end up inside the modal, not resting on the background
      // trigger where Enter/Space would reopen the popover over the dialog.
      expect(dialog?.contains(document.activeElement)).toBe(true);
    },
  );

  // `aria-modal="true"` is a promise about focus. The confirm lands on Cancel
  // so a reflexive Enter backs out of a destructive action instead of
  // committing it.
  it('focuses Cancel and traps Tab inside the confirmation', async () => {
    stubShare([]);
    await render();
    await openPopover();

    await act(async () => {
      button('digest-rotate-share-link').click();
      await Promise.resolve();
    });

    const dialog = queryDialog();
    expect(document.activeElement).toBe(button('confirm-dialog-cancel'));

    // Tab from the last focusable in the dialog cycles back to the first
    // rather than walking the page behind the overlay.
    const focusables = Array.from(
      dialog?.querySelectorAll('button') ?? [],
    ).filter((element) => !element.disabled);
    const last = focusables[focusables.length - 1];
    last.focus();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
  });

  // Every ordinary dismissal has to clear the last interaction's outcome, not
  // just the two that happen to route through `FloatingMenu.onOpenChange`.
  // Closing via the trigger and via the visible Close button both bypassed it.
  it.each([
    [
      'the trigger toggle',
      async (): Promise<void> => {
        await act(async () => {
          trigger().click();
          await Promise.resolve();
        });
      },
    ],
    [
      'the visible close button',
      async (): Promise<void> => {
        const close = document.body.querySelector('button[aria-label="Close"]');
        if (!(close instanceof HTMLButtonElement))
          throw new Error('Missing popover close button');
        await act(async () => {
          close.click();
          await Promise.resolve();
        });
      },
    ],
    [
      'Escape',
      async (): Promise<void> => {
        await act(async () => {
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
          await Promise.resolve();
        });
      },
    ],
    [
      // The fourth path, and the one that had no coverage: `FloatingMenu`
      // detects an outside press on `pointerdown` and calls `onOpenChange`.
      'an outside press',
      async (): Promise<void> => {
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        await act(async () => {
          outside.dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true }),
          );
          await Promise.resolve();
        });
        // `FloatingMenu` arms `suppressNextClick` on the outside pointerdown so
        // the press that dismissed the surface cannot also activate whatever it
        // landed on. A real pointer sequence delivers that click to the pressed
        // element; deliver it here too, or the suppression would swallow the
        // NEXT click instead — which in this test is the reopen.
        await act(async () => {
          outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await Promise.resolve();
        });
        outside.remove();
      },
    ],
  ])(
    'clears the status line when the popover is dismissed with %s',
    async (_label, dismiss) => {
      stubShare([]);
      stubClipboard();
      await render();
      await openPopover();

      await act(async () => {
        button('digest-copy-share-link').click();
        await Promise.resolve();
      });
      expect(queryPopover()?.textContent).toContain('Share link copied.');
      expect(button('digest-copy-share-link').textContent).toContain('Copied');

      await dismiss();
      expect(queryPopover()).toBeNull();
      await openPopover();

      expect(queryPopover()?.textContent).not.toContain('Share link copied.');
      // `copied` leaks the same way the status does: reopening inside the 2s
      // window must not claim a link is on the clipboard.
      expect(button('digest-copy-share-link').textContent).toContain('Copy');
      expect(button('digest-copy-share-link').textContent).not.toContain(
        'Copied',
      );
    },
  );

  // A live region is only announced when text changes inside a region the
  // screen reader was ALREADY tracking. Both confirmed actions unmount the
  // popover while the mutation runs, so a region inside it would be recreated
  // with its content and announce nothing.
  it('keeps one stable live region across a confirmation round-trip', async () => {
    stubShare([]);
    await render();

    const before = document.body.querySelector('[role="status"]');
    expect(before).not.toBeNull();
    expect(before?.textContent).toBe('');

    await openPopover();
    await act(async () => {
      button('digest-rotate-share-link').click();
      await Promise.resolve();
    });
    // The popover is gone during the mutation; the region must not be.
    expect(queryPopover()).toBeNull();
    expect(document.body.querySelector('[role="status"]')).toBe(before);

    await act(async () => {
      confirmButton().click();
      await Promise.resolve();
    });

    expect(document.body.querySelector('[role="status"]')).toBe(before);
    expect(before?.textContent).toContain('A new share link is ready.');
  });

  // The visible copy of the status must not be announced a second time.
  it('exposes exactly one announced copy of the status text', async () => {
    stubShare([]);
    stubClipboard();
    await render();
    await openPopover();

    await act(async () => {
      button('digest-copy-share-link').click();
      await Promise.resolve();
    });

    const announced = Array.from(
      document.body.querySelectorAll('[role="status"]'),
    ).filter((element) => element.textContent?.includes('Share link copied.'));
    expect(announced).toHaveLength(1);
  });

  // Rotating replaces the link, so a "Copied" label from the previous link
  // would be claiming something untrue about the clipboard.
  it('drops the Copied label when a rotate replaces the link', async () => {
    stubShare([]);
    stubClipboard();
    await render();
    await openPopover();

    await act(async () => {
      button('digest-copy-share-link').click();
      await Promise.resolve();
    });
    expect(button('digest-copy-share-link').textContent).toContain('Copied');

    await act(async () => {
      button('digest-rotate-share-link').click();
      await Promise.resolve();
    });
    await act(async () => {
      confirmButton().click();
      await Promise.resolve();
    });

    expect(button('digest-copy-share-link').textContent).not.toContain(
      'Copied',
    );
  });

  // The link the user pastes elsewhere has to be absolute; the component only
  // holds the relative capability path.
  it('copies the absolute share URL and says so', async () => {
    stubShare([]);
    const writeText = stubClipboard();
    await render();
    await openPopover();

    await act(async () => {
      button('digest-copy-share-link').click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(
      `${WEB_ORIGIN}/share/digests/old-slug`,
    );
    expect(document.body.textContent).toContain('Share link copied.');
  });

  // The status line lives inside the popover, so dismissing to a bare page
  // would swallow the only feedback a rotate produces.
  it('reopens the popover with the new link after a confirmed rotate', async () => {
    const bodies: unknown[] = [];
    stubShare(bodies);
    await render();
    await openPopover();

    await act(async () => {
      button('digest-rotate-share-link').click();
      await Promise.resolve();
    });
    await act(async () => {
      confirmButton().click();
      await Promise.resolve();
    });

    expect(queryPopover()).not.toBeNull();
    expect(queryPopover()?.textContent).toContain('A new share link is ready.');
    const field = document.body.querySelector(
      '[data-testid="digest-share-link"]',
    );
    if (!(field instanceof HTMLInputElement))
      throw new Error('Missing share link field');
    expect(field.value).toBe(`${WEB_ORIGIN}/share/digests/new-slug`);
  });

  // Turning sharing off already rotated the slug, so there is no link left to
  // copy and nothing left to rotate. A disabled control would imply otherwise.
  it('hides the link row and rotate action while sharing is off', async () => {
    stubShare([]);
    await render(false);
    await openPopover();

    expect(
      document.body.querySelector('[data-testid="digest-share-link"]'),
    ).toBeNull();
    expect(
      document.body.querySelector('[data-testid="digest-copy-share-link"]'),
    ).toBeNull();
    expect(
      document.body.querySelector('[data-testid="digest-rotate-share-link"]'),
    ).toBeNull();
    expect(queryPopover()?.textContent).toContain('Turn on sharing');
  });
});

describe('DigestShareControls: organization profile audiences', () => {
  const ACME = {
    organizationId: 'org-acme',
    organizationName: 'Acme',
    featured: false,
    lapsed: false,
  };
  const DESIGN = {
    organizationId: 'org-design',
    organizationName: 'Design Collective',
    featured: true,
    lapsed: false,
  };
  /** Lapsed and not featured: granting is impossible, so the toggle is dead. */
  const LAPSED_OFF = {
    organizationId: 'org-lapsed',
    organizationName: 'Archive Labs',
    featured: false,
    lapsed: true,
  };
  /**
   * Lapsed but ALREADY featured: the toggle must stay live. This is the case
   * that makes filtering lapsed orgs out of the list the wrong fix — it would
   * strip the only control that can withdraw the grant.
   */
  const LAPSED_ON = {
    organizationId: 'org-lapsed-on',
    organizationName: 'Old Guild',
    featured: true,
    lapsed: true,
  };

  /**
   * Answers the profile-feature operation and records what it was asked:
   * `featured: true` features (PUT), `false` unfeatures (DELETE). A failure
   * rejects the way the settings client does, carrying the status the
   * component branches on.
   */
  function stubFeature(
    calls: { digestId: string; organizationId: string; featured: boolean }[],
    ok = true,
    status = ok ? 200 : 500,
  ): void {
    client = createFakeSettingsClient({
      'account.digests.profileFeature.set': (input: unknown) => {
        if (typeof input !== 'object' || input === null)
          throw new Error('Expected an input object');
        const record: Record<string, unknown> = { ...input };
        const call = {
          digestId: String(record.digestId),
          organizationId: String(record.organizationId),
          featured: record.featured === true,
        };
        calls.push(call);
        if (!ok)
          throw new SettingsOperationError({
            code: settingsErrorCodeForStatus(status, { write: true }),
            status,
          });
        return { organizationId: call.organizationId, featured: call.featured };
      },
    });
  }

  async function renderWithAudiences(
    audiences = [ACME, DESIGN],
    sharingEnabled = false,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <Controls
          owner={{ kind: 'account' }}
          digestId="digest-1"
          initialSharePath="/share/digests/old-slug"
          initialSharingEnabled={sharingEnabled}
          initialAudiences={audiences}
        />,
      );
      await Promise.resolve();
    });
  }

  function featureDialog(): Element | null {
    return document.body.querySelector(
      '[data-testid="digest-feature-confirm-dialog"]',
    );
  }

  function featureConfirmButton(): HTMLButtonElement {
    const dialog = featureDialog();
    if (!dialog) throw new Error('Feature confirmation dialog is not open');
    const value = dialog.querySelector(
      '[data-testid="confirm-dialog-confirm"]',
    );
    if (!(value instanceof HTMLButtonElement))
      throw new Error('Missing confirm button');
    return value;
  }

  it('omits the organization section entirely for a digest with no audiences', async () => {
    // Org digests pass no audiences and must keep the link-only popover.
    await renderWithAudiences([]);
    await openPopover();

    expect(
      document.body.querySelector('[data-testid="digest-profile-audiences"]'),
    ).toBeNull();
  });

  it('lists organizations alphabetically with their current feature state', async () => {
    await renderWithAudiences([DESIGN, ACME]);
    await openPopover();

    // The helper is conditional on purpose: it renders above the toggle list
    // regardless of toggle state, so it must not claim members can already
    // open the digest.
    expect(
      document.body.querySelector('[data-testid="digest-profile-audiences"]')
        ?.textContent,
    ).toContain(
      'Turn on an organization to let its current members open this from your member profile.',
    );

    const toggles = Array.from(
      document.body.querySelectorAll(
        '[role="switch"][aria-label^="Share on your"]',
      ),
    );
    expect(toggles.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Share on your Acme profile',
      'Share on your Design Collective profile',
    ]);
    expect(toggles.map((t) => t.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
    ]);
  });

  it('confirms before featuring and PUTs only after the user agrees', async () => {
    const calls: {
      digestId: string;
      organizationId: string;
      featured: boolean;
    }[] = [];
    stubFeature(calls);
    await renderWithAudiences();
    await openPopover();

    await act(async () => {
      button('digest-profile-audience-toggle-org-acme').click();
      await Promise.resolve();
    });
    // Nothing is granted on the press alone.
    expect(calls).toEqual([]);
    expect(featureDialog()?.textContent).toContain(
      'may include work from outside Acme',
    );
    // The share-on-profile wording is the point of this dialog: without these
    // the title and confirm label could revert to the old "feature" vocabulary
    // with nothing failing.
    expect(featureDialog()?.textContent).toContain(
      'Share on your Acme profile?',
    );
    expect(featureConfirmButton().textContent).toContain('Share on profile');

    await act(async () => {
      featureConfirmButton().click();
      await Promise.resolve();
    });

    expect(calls).toEqual([
      { digestId: 'digest-1', organizationId: 'org-acme', featured: true },
    ]);
    expect(
      button('digest-profile-audience-toggle-org-acme').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(queryPopover()?.textContent).toContain(
      'Shared on your Acme profile.',
    );
  });

  it('cancelling the confirmation grants nothing and restores the popover', async () => {
    const calls: {
      digestId: string;
      organizationId: string;
      featured: boolean;
    }[] = [];
    stubFeature(calls);
    await renderWithAudiences();
    await openPopover();

    await act(async () => {
      button('digest-profile-audience-toggle-org-acme').click();
      await Promise.resolve();
    });
    const cancel = featureDialog()?.querySelector(
      '[data-testid="confirm-dialog-cancel"]',
    );
    if (!(cancel instanceof HTMLButtonElement))
      throw new Error('Missing cancel button');
    await act(async () => {
      cancel.click();
      await Promise.resolve();
    });

    expect(calls).toEqual([]);
    expect(featureDialog()).toBeNull();
    expect(queryPopover()).not.toBeNull();
    expect(
      button('digest-profile-audience-toggle-org-acme').getAttribute(
        'aria-checked',
      ),
    ).toBe('false');
  });

  it('unfeatures immediately with DELETE and no confirmation', async () => {
    // Removing access only takes access away and is one click to undo, so the
    // confirmation that guards the grant would be pure friction here.
    const calls: {
      digestId: string;
      organizationId: string;
      featured: boolean;
    }[] = [];
    stubFeature(calls);
    await renderWithAudiences();
    await openPopover();

    await act(async () => {
      button('digest-profile-audience-toggle-org-design').click();
      await Promise.resolve();
    });

    expect(featureDialog()).toBeNull();
    expect(calls).toEqual([
      { digestId: 'digest-1', organizationId: 'org-design', featured: false },
    ]);
    expect(
      button('digest-profile-audience-toggle-org-design').getAttribute(
        'aria-checked',
      ),
    ).toBe('false');
    expect(queryPopover()?.textContent).toContain(
      'Removed from your Design Collective profile.',
    );
  });

  it('keeps the previous toggle state and offers a retry when the request fails', async () => {
    const calls: {
      digestId: string;
      organizationId: string;
      featured: boolean;
    }[] = [];
    stubFeature(calls, false);
    await renderWithAudiences();
    await openPopover();

    await act(async () => {
      button('digest-profile-audience-toggle-org-design').click();
      await Promise.resolve();
    });

    // Still featured: the UI must not claim a change the server refused.
    expect(
      button('digest-profile-audience-toggle-org-design').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(queryPopover()?.textContent).toContain(
      "Couldn't update profile sharing. Try again.",
    );
  });

  it('reports a 404 as terminal instead of prompting a retry that cannot succeed', async () => {
    // 404 is what the route returns once the digest has left READY, the
    // membership was revoked, or the org was soft-deleted. None of those
    // recover on retry, so "Try again." would send the user into a loop.
    const calls: {
      digestId: string;
      organizationId: string;
      featured: boolean;
    }[] = [];
    stubFeature(calls, false, 404);
    await renderWithAudiences();
    await openPopover();

    await act(async () => {
      button('digest-profile-audience-toggle-org-design').click();
      await Promise.resolve();
    });

    expect(
      button('digest-profile-audience-toggle-org-design').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(queryPopover()?.textContent).toContain(
      'This digest can no longer be shared with Design Collective.',
    );
    expect(queryPopover()?.textContent).not.toContain('Try again.');
  });

  it('disables granting into a lapsed org but keeps revocation available', async () => {
    // The two directions are gated differently on purpose. Granting into a
    // lapsed org would produce a row nobody can read — and one that becomes
    // effective on its own if the org is later restored. Revoking must always
    // work: an owner cannot be stuck unable to withdraw a grant because
    // someone else's billing failed.
    const calls: {
      digestId: string;
      organizationId: string;
      featured: boolean;
    }[] = [];
    stubFeature(calls);
    await renderWithAudiences([LAPSED_OFF, LAPSED_ON]);
    await openPopover();

    expect(
      button('digest-profile-audience-toggle-org-lapsed').hasAttribute(
        'disabled',
      ),
    ).toBe(true);
    expect(
      button('digest-profile-audience-toggle-org-lapsed-on').hasAttribute(
        'disabled',
      ),
    ).toBe(false);

    // And the live one actually revokes.
    await act(async () => {
      button('digest-profile-audience-toggle-org-lapsed-on').click();
      await Promise.resolve();
    });
    expect(calls.some((call) => !call.featured)).toBe(true);
  });

  it('explains why a lapsed org cannot be featured', async () => {
    await renderWithAudiences([LAPSED_OFF, LAPSED_ON]);
    await openPopover();

    const text = queryPopover()?.textContent ?? '';
    const offToggle = button('digest-profile-audience-toggle-org-lapsed');
    const onToggle = button('digest-profile-audience-toggle-org-lapsed-on');
    // Not-featured: granting is unavailable.
    expect(text).toContain('Unavailable while the subscription is inactive');
    expect(offToggle.getAttribute('aria-describedby')).toBe(
      'digest-profile-audience-lapsed-org-lapsed',
    );
    // Already-featured says something different — the grant exists, it just
    // cannot be opened right now — so the owner understands why the toggle is
    // still live for this one.
    expect(text).toContain(
      'Members cannot open this while the subscription is inactive',
    );
    expect(onToggle.getAttribute('aria-describedby')).toBe(
      'digest-profile-audience-lapsed-org-lapsed-on',
    );
  });

  it('says nothing about subscriptions for a healthy org', async () => {
    await renderWithAudiences([ACME, DESIGN]);
    await openPopover();

    expect(queryPopover()?.textContent ?? '').not.toContain(
      'subscription is inactive',
    );
    expect(
      button('digest-profile-audience-toggle-org-acme').hasAttribute(
        'aria-describedby',
      ),
    ).toBe(false);
  });

  it('still offers a retry for a 401, which is recoverable after re-auth', async () => {
    // Guards the terminal branch from over-reaching back to "all of 4xx". An
    // expired session is the most likely 4xx on a detail page left open, and
    // calling it permanent would be a confident false statement.
    const calls: {
      digestId: string;
      organizationId: string;
      featured: boolean;
    }[] = [];
    stubFeature(calls, false, 401);
    await renderWithAudiences();
    await openPopover();

    await act(async () => {
      button('digest-profile-audience-toggle-org-design').click();
      await Promise.resolve();
    });

    expect(queryPopover()?.textContent).toContain(
      "Couldn't update profile sharing. Try again.",
    );
  });

  it('reads Shared when only a profile audience is featured and the link is off', async () => {
    // The trigger answers "shared with anyone", not "anonymous link on".
    await renderWithAudiences([DESIGN], false);

    expect(trigger().textContent).toContain('Shared');
  });

  it('reads Share when the link is off and nothing is featured', async () => {
    await renderWithAudiences([ACME], false);

    expect(trigger().textContent).toContain('Share');
    expect(trigger().textContent).not.toContain('Shared');
  });

  it('leaves profile audiences untouched when the public link is turned off', async () => {
    // The two facets are independent: rotating or disabling the capability
    // link must not revoke a member-only profile grant, and vice versa.
    const bodies: unknown[] = [];
    stubShare(bodies);
    await renderWithAudiences([DESIGN], true);
    await openPopover();

    await act(async () => {
      button('digest-sharing-toggle').click();
      await Promise.resolve();
    });
    await act(async () => {
      confirmButton().click();
      await Promise.resolve();
    });

    expect(
      button('digest-profile-audience-toggle-org-design').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    // Still "Shared" on the strength of the profile audience alone.
    expect(trigger().textContent).toContain('Shared');
  });

  it('disables every audience toggle while a mutation is in flight', async () => {
    let release: (() => void) | null = null;
    client = createFakeSettingsClient({
      'account.digests.profileFeature.set': async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { organizationId: 'org-design', featured: false };
      },
    });
    await renderWithAudiences();
    await openPopover();

    await act(async () => {
      button('digest-profile-audience-toggle-org-design').click();
      await Promise.resolve();
    });

    expect(button('digest-profile-audience-toggle-org-acme').disabled).toBe(
      true,
    );
    expect(button('digest-profile-audience-toggle-org-design').disabled).toBe(
      true,
    );
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
  });

  it('features through the account operation for every audience', async () => {
    const calls: {
      digestId: string;
      organizationId: string;
      featured: boolean;
    }[] = [];
    stubFeature(calls);
    await renderWithAudiences();
    await openPopover();

    await act(async () => {
      button('digest-profile-audience-toggle-org-design').click();
      await Promise.resolve();
    });

    expect(client.calls.map((call) => call.operation)).toEqual([
      'account.digests.profileFeature.set',
    ]);
  });
});

describe('DigestShareControls: owners and privacy', () => {
  it('updates an organization digest through the organization operation', async () => {
    const bodies: unknown[] = [];
    const targets: string[] = [];
    stubShare(bodies, targets);
    await render(false, { kind: 'organization', organizationId: 'org-1' });
    await openPopover();

    await act(async () => {
      button('digest-sharing-toggle').click();
      await Promise.resolve();
    });

    expect(targets).toEqual([
      'organization.digests.sharing.update:org-1:digest-1',
    ]);
    expect(bodies).toEqual([{ action: 'set-sharing', sharingEnabled: true }]);
  });

  it('reports the generic sharing failure, never the server text, when the update is rejected', async () => {
    client = createFakeSettingsClient({
      'account.digests.share.update': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 500,
          message: 'SENTINEL share update exploded',
        });
      },
    });
    await render(false);
    await openPopover();

    await act(async () => {
      button('digest-sharing-toggle').click();
      await Promise.resolve();
    });

    expect(queryPopover()?.textContent).toContain(
      "Couldn't update sharing. Try again.",
    );
    expect(queryPopover()?.textContent).not.toContain('SENTINEL');
  });

  it('blocks the share URL from session replay', async () => {
    stubShare([]);
    await render();
    await openPopover();

    const field = document.body.querySelector(
      '[data-testid="digest-share-link"]',
    );
    expect(field?.classList.contains('replay-block')).toBe(true);
  });
});
