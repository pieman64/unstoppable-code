/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  TelemetrySharingPreferences,
  TelemetrySharingVisibility,
} from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { DATA_SHARING_SCOPE_ORDER } from '@canopy/ui-shared';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { TelemetrySharingControls } from '../TelemetrySharingControls';
import type { TelemetryLockMap } from '../telemetryLocks';
import { TELEMETRY_SCOPE_DESCRIPTIONS } from '../telemetry-sharing';

const ALL_SCOPES: TelemetrySharingVisibility[] = [
  'off',
  'private',
  'organization',
];

const OFF: TelemetrySharingPreferences = {
  transcripts: 'off',
  plans: 'off',
  metadata: 'off',
  summaries: 'off',
};

const NO_LOCKS: TelemetryLockMap = {
  transcripts: null,
  plans: null,
  metadata: null,
  summaries: null,
};

/** Acme requires transcripts at organization visibility. */
const REQUIRE_TRANSCRIPTS: TelemetryLockMap = {
  ...NO_LOCKS,
  transcripts: 'organization',
};

/** Acme prohibits transcripts everywhere, including the member's own account. */
const PROHIBIT_TRANSCRIPTS: TelemetryLockMap = {
  ...NO_LOCKS,
  transcripts: 'off',
};

const LOCK_TOOLTIP = 'Managed by Acme. Contact an admin to change.';
const BLOCKED_TOOLTIP = 'Blocked by Acme. Its work stays on your machine.';

describe('TelemetrySharingControls locking', () => {
  let container: HTMLElement;
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

  function render(
    value: TelemetrySharingPreferences,
    onChange: (next: TelemetrySharingPreferences) => void,
    locked: TelemetryLockMap,
  ): void {
    act(() => {
      root.render(
        <TelemetrySharingControls
          value={value}
          onChange={onChange}
          availableScopes={ALL_SCOPES}
          locked={locked}
          lockTooltip={LOCK_TOOLTIP}
          blockedTooltip={BLOCKED_TOOLTIP}
        />,
      );
    });
  }

  it('forces a required scope to Organization and disables its selector', () => {
    render(OFF, () => {}, REQUIRE_TRANSCRIPTS);

    const row = container.querySelector(
      '[data-testid="telemetry-sharing-row-transcripts"]',
    );
    expect(row?.getAttribute('data-locked')).toBe('true');

    const orgButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-organization"]',
    );
    expect(orgButton?.getAttribute('aria-pressed')).toBe('true');
    expect(orgButton?.disabled).toBe(true);

    // An unlocked row stays editable.
    const plansOff = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-plans-off"]',
    );
    expect(plansOff?.disabled).toBe(false);
  });

  it('pins a prohibited scope to Off with a lock icon and ignores clicks', () => {
    const onChange = jest.fn();
    // The stored value is `organization`; the prohibition must win in the
    // display, otherwise the member is told they are sharing data the org
    // forbade.
    render(
      { ...OFF, transcripts: 'organization' },
      onChange,
      PROHIBIT_TRANSCRIPTS,
    );

    const row = container.querySelector(
      '[data-testid="telemetry-sharing-row-transcripts"]',
    );
    expect(row?.getAttribute('data-locked')).toBe('true');

    const offButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-off"]',
    );
    expect(offButton?.getAttribute('aria-pressed')).toBe('true');
    expect(offButton?.disabled).toBe(true);
    // The lock icon rides the pinned `off` button, not just a pinned `organization`.
    expect(
      container.querySelector(
        '[data-testid="telemetry-sharing-transcripts-off"] [data-testid="telemetry-sharing-transcripts-lock"]',
      ),
    ).not.toBeNull();

    const orgButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-organization"]',
    );
    expect(orgButton?.getAttribute('aria-pressed')).toBe('false');
    expect(orgButton?.disabled).toBe(true);
    act(() => {
      orgButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('names the prohibiting org on a blocked scope, with no scope description', () => {
    render(OFF, () => {}, PROHIBIT_TRANSCRIPTS);

    const offButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-off"]',
    );
    act(() => {
      // Tooltips open for keyboard focus only (`:focus-visible` semantics), so
      // a Tab keydown must reach the document before the focus that follows.
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      offButton?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });

    // The tooltip is portaled to document.body, not into the container.
    const tooltip = document.querySelector('[role="tooltip"]');
    // Exactly the note: a prohibited row drops the scope description, which
    // would otherwise describe a value the member cannot select.
    expect(tooltip?.textContent).toBe(BLOCKED_TOOLTIP);
    // The required-lock wording must not be used for a prohibition — "contact an
    // admin to change" implies the block is negotiable and org-scoped.
    expect(tooltip?.textContent).not.toContain('Managed by');
  });

  it('shows the default scope description in the tooltip', () => {
    render(OFF, () => {}, NO_LOCKS);

    const privateButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-plans-private"]',
    );
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      privateButton?.dispatchEvent(
        new FocusEvent('focusin', { bubbles: true }),
      );
    });

    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe(TELEMETRY_SCOPE_DESCRIPTIONS.private);
  });

  it('shows a lock icon only on the locked scope', () => {
    render(OFF, () => {}, REQUIRE_TRANSCRIPTS);

    expect(
      container.querySelector(
        '[data-testid="telemetry-sharing-transcripts-lock"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="telemetry-sharing-plans-lock"]'),
    ).toBeNull();
  });

  it('ignores clicks on a locked scope', () => {
    const onChange = jest.fn();
    render(OFF, onChange, REQUIRE_TRANSCRIPTS);

    // The locked row pins the Organization button; clicking it is a no-op.
    const orgButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-organization"]',
    );
    act(() => {
      orgButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('hides the "Set all to" bulk control when any scope is locked', () => {
    render(OFF, () => {}, REQUIRE_TRANSCRIPTS);

    expect(
      container.querySelector('[data-testid="telemetry-sharing-bulk-off"]'),
    ).toBeNull();
  });

  it('hides the bulk control for a prohibition too', () => {
    render(OFF, () => {}, PROHIBIT_TRANSCRIPTS);

    expect(
      container.querySelector('[data-testid="telemetry-sharing-bulk-off"]'),
    ).toBeNull();
  });

  it('shows the bulk control and sets every scope when nothing is locked', () => {
    const onChange = jest.fn();
    render(OFF, onChange, NO_LOCKS);

    const bulkOrg = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-bulk-organization"]',
    );
    expect(bulkOrg).not.toBeNull();
    act(() => {
      bulkOrg?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({
      transcripts: 'organization',
      plans: 'organization',
      metadata: 'organization',
      summaries: 'organization',
    });
  });

  it('lets every plan pick Off per row and in bulk', () => {
    const onChange = jest.fn();
    const justMe: TelemetrySharingPreferences = {
      transcripts: 'private',
      plans: 'private',
      metadata: 'private',
      summaries: 'private',
    };
    act(() => {
      root.render(
        <TelemetrySharingControls
          value={justMe}
          onChange={onChange}
          availableScopes={ALL_SCOPES}
          locked={NO_LOCKS}
        />,
      );
    });

    // Off is not a paid perk: the row button is a plain, selectable segment.
    const transcriptsOff = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-off"]',
    );
    expect(transcriptsOff?.disabled).toBe(false);
    expect(transcriptsOff?.getAttribute('aria-disabled')).toBeNull();
    act(() => {
      transcriptsOff?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...justMe,
      transcripts: 'off',
    });

    const bulkOff = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-bulk-off"]',
    );
    expect(bulkOff?.getAttribute('aria-disabled')).toBeNull();
    act(() => {
      bulkOff?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(OFF);
  });

  it('leaves a stored Off selected and selectable', () => {
    act(() => {
      root.render(
        <TelemetrySharingControls
          value={OFF}
          onChange={() => {}}
          availableScopes={ALL_SCOPES}
          locked={NO_LOCKS}
        />,
      );
    });

    const transcriptsOff = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-off"]',
    );
    expect(transcriptsOff?.disabled).toBe(false);
    expect(transcriptsOff?.getAttribute('aria-disabled')).toBeNull();
    const bulkOff = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-bulk-off"]',
    );
    expect(bulkOff?.disabled).toBe(false);
    expect(bulkOff?.getAttribute('aria-disabled')).toBeNull();
  });

  it('sizes each row picker to its labels, with no empty track after them', () => {
    act(() => {
      root.render(
        <TelemetrySharingControls
          value={OFF}
          onChange={() => {}}
          availableScopes={ALL_SCOPES}
          locked={NO_LOCKS}
        />,
      );
    });

    const track = container.querySelector<HTMLElement>(
      '[data-testid="telemetry-sharing-metadata-selector"]',
    );
    expect(track).not.toBeNull();
    expect(track?.className).not.toContain('min-w-52');
  });

  it('persists edits from rawValue so a sibling stored Off is not overwritten', () => {
    const onChange = jest.fn();
    // Display differs (transcripts shows `private`), but the raw stored
    // preference still has transcripts genuinely `off`.
    const displayFloored: TelemetrySharingPreferences = {
      transcripts: 'private',
      plans: 'private',
      metadata: 'private',
      summaries: 'private',
    };
    const rawStored: TelemetrySharingPreferences = {
      transcripts: 'off',
      plans: 'private',
      metadata: 'private',
      summaries: 'private',
    };
    act(() => {
      root.render(
        <TelemetrySharingControls
          value={displayFloored}
          rawValue={rawStored}
          onChange={onChange}
          availableScopes={ALL_SCOPES}
          locked={NO_LOCKS}
        />,
      );
    });

    // Change an unrelated scope (plans -> organization).
    const plansOrg = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-plans-organization"]',
    );
    act(() => {
      plansOrg?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // transcripts must remain the genuine `off`, not the displayed `private`.
    expect(onChange).toHaveBeenCalledWith({
      transcripts: 'off',
      plans: 'organization',
      metadata: 'private',
      summaries: 'private',
    });
  });

  // CAN-3459: locks are display only. They describe the SELECTED org's policy,
  // which main applies per item to that org's work; writing them into the saved
  // preference would leak one org's rules into Personal and other orgs' work.
  it("saves the member's own values, never the locks, when changing an unlocked scope", () => {
    const onChange = jest.fn();
    render({ ...OFF, summaries: 'private' }, onChange, {
      ...NO_LOCKS,
      transcripts: 'off',
      summaries: 'organization',
      metadata: 'organization',
    });

    const plansOrg = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-plans-organization"]',
    );
    act(() => {
      plansOrg?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({
      transcripts: 'off',
      plans: 'organization',
      metadata: 'off',
      summaries: 'private',
    });
  });

  it('uses the supplied scope descriptions in the per-scope tooltips', () => {
    act(() => {
      root.render(
        <TelemetrySharingControls
          value={OFF}
          onChange={() => {}}
          availableScopes={['off', 'private', 'organization']}
          scopeDescriptions={{
            off: 'Off copy',
            private: 'Private copy',
            team: 'Team copy',
            organization: 'Uploaded and visible to everyone in Acme.',
          }}
        />,
      );
    });
    const orgButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-plans-organization"]',
    );
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      orgButton?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe(
      'Uploaded and visible to everyone in Acme.',
    );
  });
});

describe('TelemetrySharingControls feature disclosure', () => {
  let container: HTMLElement;
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

  function render(value: TelemetrySharingPreferences): void {
    act(() => {
      root.render(
        <TelemetrySharingControls
          value={value}
          onChange={() => {}}
          availableScopes={ALL_SCOPES}
          locked={NO_LOCKS}
        />,
      );
    });
  }

  function pills(scope: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      `[data-testid="telemetry-sharing-features-${scope}"]`,
    );
  }

  it('renders rows in the canonical least-invasive-first order', () => {
    render(OFF);

    const keys = Array.from(
      container.querySelectorAll('[data-testid^="telemetry-sharing-row-"]'),
    ).map((row) =>
      row.getAttribute('data-testid')?.replace('telemetry-sharing-row-', ''),
    );
    expect(keys).toEqual([...DATA_SHARING_SCOPE_ORDER]);
  });

  it('renders feature pills on every row, unlocked or not', () => {
    render(OFF);

    for (const scope of DATA_SHARING_SCOPE_ORDER) {
      expect(pills(scope)).not.toBeNull();
    }
  });

  it('flips the caption from Enables to Powers with the member’s own value', () => {
    render(OFF);
    expect(pills('metadata')?.getAttribute('data-sharing')).toBe('false');
    expect(pills('metadata')?.textContent).toContain('Enables');
    // Off frames what sharing would add, so no pill reads as crossed out.
    expect(pills('metadata')?.querySelector('.line-through')).toBeNull();

    render({ ...OFF, metadata: 'organization' });
    expect(pills('metadata')?.getAttribute('data-sharing')).toBe('true');
    expect(pills('metadata')?.textContent).toContain('Powers');
  });

  it('treats a private-only upload as not sharing', () => {
    // `private` uploads, but only the author can see it — it powers no org
    // surface, so promising the pills' features would be false.
    render({ ...OFF, metadata: 'private' });

    expect(pills('metadata')?.getAttribute('data-sharing')).toBe('false');
    expect(pills('metadata')?.textContent).toContain('Enables');
  });

  it('omits enforcement-only features from the member view', () => {
    render({ ...OFF, transcripts: 'organization', metadata: 'organization' });

    // A member's own Transcripts setting never stops their own run share, so the
    // Shared runs pill must not appear here even though the org card shows it.
    expect(
      container.querySelector(
        '[data-testid="telemetry-sharing-features-transcripts-pill-shared-runs"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="telemetry-sharing-features-transcripts-pill-organization-memory"]',
      ),
    ).not.toBeNull();
  });

  it('flags dependent scopes that are on while Usage metadata is not shared', () => {
    render({
      transcripts: 'off',
      plans: 'organization',
      metadata: 'off',
      summaries: 'off',
    });

    const note = container.querySelector(
      '[data-testid="telemetry-sharing-dependency-note-plans"]',
    );
    expect(note?.textContent).toContain('Usage metadata');
    // The prerequisite row never flags itself, and a scope that is off has no
    // silent failure to warn about.
    expect(
      container.querySelector(
        '[data-testid="telemetry-sharing-dependency-note-metadata"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="telemetry-sharing-dependency-note-transcripts"]',
      ),
    ).toBeNull();
  });

  it('says Session summaries also cover Ledger entries, only while the Ledger is on', () => {
    const ledgerNote = (): Element | null =>
      container.querySelector('[data-testid="telemetry-sharing-ledger-note"]');
    const setLedgerFlag = (enabled: boolean): void => {
      const snapshot = getDefaultFeatureFlagSnapshot();
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key] = enabled;
      act(() => {
        useFeatureFlagsStore.setState({ snapshot });
      });
    };
    setLedgerFlag(false);
    try {
      render(OFF);
      expect(ledgerNote()).toBeNull();

      setLedgerFlag(true);
      expect(ledgerNote()?.textContent).toBe('Also covers Feed entries.');
      expect(
        ledgerNote()?.closest(
          '[data-testid="telemetry-sharing-row-summaries"]',
        ),
      ).not.toBeNull();
    } finally {
      act(() => {
        useFeatureFlagsStore.setState({
          snapshot: getDefaultFeatureFlagSnapshot(),
        });
      });
    }
  });

  it('drops the dependency note once Usage metadata is shared', () => {
    render({
      transcripts: 'off',
      plans: 'organization',
      metadata: 'organization',
      summaries: 'off',
    });

    expect(
      container.querySelector(
        '[data-testid="telemetry-sharing-dependency-note-plans"]',
      ),
    ).toBeNull();
  });
});
