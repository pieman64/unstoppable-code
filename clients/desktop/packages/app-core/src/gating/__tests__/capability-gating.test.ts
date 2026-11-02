import { PANEL_KINDS } from '@canopy/protocol';
import type { CanopyCapabilities } from '../../client/capabilities';
import {
  FEATURE_SURFACES,
  FEATURE_CAPABILITY_REQUIREMENTS,
  PANEL_CAPABILITY_REQUIREMENTS,
  getAvailableFeatureSurfaces,
  getAvailablePanelKinds,
  isFeatureSurface,
  isFeatureSurfaceAvailable,
  isPanelAvailable,
  meetsCapabilityRequirement,
} from '../capability-gating';

/**
 * Desktop-shaped client: every capability at its maximum. Mirrors
 * `createDesktopCapabilities`: the native worktree Open surface exists
 * (`nativeWorktreeOpen: true`), but no desktop panel-layout toggle ships yet
 * (`panelLayoutControls: false`, dormant scaffolding until a real P2 toggle).
 */
const FULL_CAPABILITIES: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: true,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
  nativeWorktreeOpen: true,
  marketplaceOwnedAutomationShares: true,
  marketplaceOwnedShares: true,
  marketplaceSharedCollectionEdit: true,
  customSkillEdit: true,
  automations: true,
  watchers: true,
  workflowManagement: true,
  panelLayoutControls: false,
  costInsights: true,
  workspaceRemoval: 'delete',
  ledger: true,
};

/**
 * Web-portal-shaped client: mirrors `WEB_CAPABILITIES` in
 * `apps/web/src/lib/canopy-client/http-canopy-client.ts` (no local
 * execution, no PTY, read-only files, no voice, API-keys-only settings,
 * pipeline CRUD relayed without local execution, URL routing).
 */
const WEB_CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
  nativeWorktreeOpen: false,
  marketplaceOwnedAutomationShares: false,
  marketplaceOwnedShares: true,
  marketplaceSharedCollectionEdit: false,
  customSkillEdit: false,
  panelLayoutControls: false,
  workspaceRemoval: 'delete',
};

/**
 * Most-restricted client: every capability at its minimum. The optional
 * `nativeWorktreeOpen` / `panelLayoutControls` fields are intentionally left
 * unset here to exercise the default-deny path (unset ⇒ hidden).
 */
const MINIMAL_CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'none',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'read-only',
  routing: 'url',
  overviewNotifications: false,
};

describe('PANEL_CAPABILITY_REQUIREMENTS', () => {
  it('maps every protocol panel kind (closed union stays exhaustive)', () => {
    expect(Object.keys(PANEL_CAPABILITY_REQUIREMENTS).sort()).toEqual(
      [...PANEL_KINDS].sort(),
    );
  });

  it('requires local execution for pipeline run panels', () => {
    expect(PANEL_CAPABILITY_REQUIREMENTS['pipeline-execution']).toEqual({
      localExecution: true,
    });
    expect(isPanelAvailable(FULL_CAPABILITIES, 'pipeline-execution')).toBe(
      true,
    );
    expect(isPanelAvailable(WEB_CAPABILITIES, 'pipeline-execution')).toBe(
      false,
    );
    expect(isPanelAvailable(MINIMAL_CAPABILITIES, 'pipeline-execution')).toBe(
      false,
    );
  });

  it('gates Cost and Session breakdown on costInsights', () => {
    expect(PANEL_CAPABILITY_REQUIREMENTS.cost).toEqual({
      costInsights: true,
    });
    expect(PANEL_CAPABILITY_REQUIREMENTS['session-breakdown']).toEqual({
      costInsights: true,
    });

    const disabled: CanopyCapabilities = {
      ...FULL_CAPABILITIES,
      costInsights: false,
    };
    for (const kind of ['cost', 'session-breakdown']) {
      expect(isPanelAvailable(FULL_CAPABILITIES, kind)).toBe(true);
      expect(isPanelAvailable(disabled, kind)).toBe(false);
      expect(isPanelAvailable(WEB_CAPABILITIES, kind)).toBe(false);
      expect(isPanelAvailable(MINIMAL_CAPABILITIES, kind)).toBe(false);
    }
  });
});

describe('meetsCapabilityRequirement costInsights axis', () => {
  it('defaults to unavailable until the host explicitly supplies costInsights', () => {
    expect(
      meetsCapabilityRequirement(MINIMAL_CAPABILITIES, {
        costInsights: true,
      }),
    ).toBe(false);
    expect(
      meetsCapabilityRequirement(
        { ...FULL_CAPABILITIES, costInsights: false },
        { costInsights: true },
      ),
    ).toBe(false);
    expect(
      meetsCapabilityRequirement(FULL_CAPABILITIES, { costInsights: true }),
    ).toBe(true);
  });
});

describe('isPanelAvailable', () => {
  it('shows every panel kind to a full-capability (desktop-shaped) client', () => {
    for (const kind of PANEL_KINDS) {
      expect(isPanelAvailable(FULL_CAPABILITIES, kind)).toBe(true);
    }
  });

  it('hides exactly terminal, browser and the Ledger from a web-shaped client', () => {
    expect(isPanelAvailable(WEB_CAPABILITIES, 'terminal')).toBe(false);
    expect(isPanelAvailable(WEB_CAPABILITIES, 'browser')).toBe(false);
    // No web host reads the Ledger yet, so it reports no `ledger` capability.
    expect(isPanelAvailable(WEB_CAPABILITIES, 'ledger')).toBe(false);

    expect(isPanelAvailable(WEB_CAPABILITIES, 'chat')).toBe(true);
    expect(isPanelAvailable(WEB_CAPABILITIES, 'file-diff')).toBe(true);
    expect(isPanelAvailable(WEB_CAPABILITIES, 'file-explorer')).toBe(true);
    expect(isPanelAvailable(WEB_CAPABILITIES, 'activity-section')).toBe(true);
    expect(isPanelAvailable(WEB_CAPABILITIES, 'activity-card')).toBe(true);
    expect(isPanelAvailable(WEB_CAPABILITIES, 'usage')).toBe(true);
  });

  it('additionally hides file surfaces when fileSystemAccess is none', () => {
    expect(isPanelAvailable(MINIMAL_CAPABILITIES, 'file-diff')).toBe(false);
    expect(isPanelAvailable(MINIMAL_CAPABILITIES, 'file-explorer')).toBe(false);
    // Universal surfaces survive even the most restricted client.
    expect(isPanelAvailable(MINIMAL_CAPABILITIES, 'chat')).toBe(true);
    expect(isPanelAvailable(MINIMAL_CAPABILITIES, 'activity-section')).toBe(
      true,
    );
    expect(isPanelAvailable(MINIMAL_CAPABILITIES, 'activity-card')).toBe(true);
  });

  it('gates both plan panel kinds on local execution', () => {
    expect(PANEL_CAPABILITY_REQUIREMENTS.plan).toEqual({
      localExecution: true,
    });
    expect(PANEL_CAPABILITY_REQUIREMENTS['plan-diagram']).toEqual({
      localExecution: true,
    });
    for (const kind of ['plan', 'plan-diagram']) {
      expect(isPanelAvailable(FULL_CAPABILITIES, kind)).toBe(true);
      expect(isPanelAvailable(WEB_CAPABILITIES, kind)).toBe(false);
      expect(isPanelAvailable(MINIMAL_CAPABILITIES, kind)).toBe(false);
    }
  });

  it('makes both subagent panel kinds universal', () => {
    expect(PANEL_CAPABILITY_REQUIREMENTS.subagents).toEqual({});
    expect(PANEL_CAPABILITY_REQUIREMENTS['subagent-chat']).toEqual({});
    for (const kind of ['subagents', 'subagent-chat']) {
      expect(isPanelAvailable(FULL_CAPABILITIES, kind)).toBe(true);
      expect(isPanelAvailable(WEB_CAPABILITIES, kind)).toBe(true);
      expect(isPanelAvailable(MINIMAL_CAPABILITIES, kind)).toBe(true);
    }
  });

  it('defaults unknown/future panel kinds to hidden, even for full clients', () => {
    // Deliberate default-hidden: an unknown kind may carry requirements this
    // build cannot evaluate, and a registry-driven host has no definition to
    // render it with anyway. Hiding degrades safely; showing can break.
    expect(isPanelAvailable(FULL_CAPABILITIES, 'quantum-whiteboard')).toBe(
      false,
    );
    expect(isPanelAvailable(FULL_CAPABILITIES, '')).toBe(false);
    expect(isPanelAvailable(WEB_CAPABILITIES, 'quantum-whiteboard')).toBe(
      false,
    );
  });
});

describe('getAvailablePanelKinds', () => {
  it('returns all kinds in canonical order for a full-capability client', () => {
    expect(getAvailablePanelKinds(FULL_CAPABILITIES)).toEqual([...PANEL_KINDS]);
  });

  it('returns exactly the web-supported kinds for a web-shaped client', () => {
    expect(getAvailablePanelKinds(WEB_CAPABILITIES)).toEqual([
      'chat',
      'file-diff',
      'activity-section',
      'file-explorer',
      'activity-card',
      'usage',
      'automations',
      'chat-visuals',
      'subagents',
      'subagent-chat',
    ]);
  });

  it('agrees with isPanelAvailable for every kind and capability shape', () => {
    for (const capabilities of [
      FULL_CAPABILITIES,
      WEB_CAPABILITIES,
      MINIMAL_CAPABILITIES,
    ]) {
      const available = getAvailablePanelKinds(capabilities);
      for (const kind of PANEL_KINDS) {
        expect(available.includes(kind)).toBe(
          isPanelAvailable(capabilities, kind),
        );
      }
    }
  });
});

describe('meetsCapabilityRequirement', () => {
  it('treats an empty requirement as universal', () => {
    expect(meetsCapabilityRequirement(MINIMAL_CAPABILITIES, {})).toBe(true);
  });

  it('treats leveled requirements as minimums, not exact matches', () => {
    // read-write satisfies a 'read' minimum…
    expect(
      meetsCapabilityRequirement(FULL_CAPABILITIES, {
        fileSystemAccess: 'read',
      }),
    ).toBe(true);
    // …but read does not satisfy a 'read-write' minimum.
    expect(
      meetsCapabilityRequirement(WEB_CAPABILITIES, {
        fileSystemAccess: 'read-write',
      }),
    ).toBe(false);
    expect(
      meetsCapabilityRequirement(WEB_CAPABILITIES, { pipelines: 'crud-only' }),
    ).toBe(true);
    expect(
      meetsCapabilityRequirement(WEB_CAPABILITIES, { pipelines: 'execute' }),
    ).toBe(false);
  });

  it('requires every field of a multi-field requirement (conjunction)', () => {
    const requirement = {
      localExecution: true,
      fileSystemAccess: 'read',
    } as const;
    expect(meetsCapabilityRequirement(FULL_CAPABILITIES, requirement)).toBe(
      true,
    );
    // Web has read access but no local execution — one failing field fails.
    expect(meetsCapabilityRequirement(WEB_CAPABILITIES, requirement)).toBe(
      false,
    );
  });

  it('default-denies the optional boolean axes when unset or false (=== true)', () => {
    // Desktop opts into native Open but not the panel-layout toggle.
    expect(
      meetsCapabilityRequirement(FULL_CAPABILITIES, {
        nativeWorktreeOpen: true,
      }),
    ).toBe(true);
    expect(
      meetsCapabilityRequirement(FULL_CAPABILITIES, {
        panelLayoutControls: true,
      }),
    ).toBe(false);
    // Web sets both false explicitly; minimal leaves them unset. Both deny.
    for (const capabilities of [WEB_CAPABILITIES, MINIMAL_CAPABILITIES]) {
      expect(
        meetsCapabilityRequirement(capabilities, { automations: true }),
      ).toBe(false);
      expect(meetsCapabilityRequirement(capabilities, { watchers: true })).toBe(
        false,
      );
      expect(
        meetsCapabilityRequirement(capabilities, { nativeWorktreeOpen: true }),
      ).toBe(false);
      expect(
        meetsCapabilityRequirement(capabilities, { panelLayoutControls: true }),
      ).toBe(false);
    }
  });

  it('default-denies the Ledger unless the host reads it', () => {
    expect(
      meetsCapabilityRequirement(FULL_CAPABILITIES, { ledger: true }),
    ).toBe(true);
    expect(
      meetsCapabilityRequirement(
        { ...FULL_CAPABILITIES, ledger: false },
        { ledger: true },
      ),
    ).toBe(false);
    expect(
      meetsCapabilityRequirement(MINIMAL_CAPABILITIES, { ledger: true }),
    ).toBe(false);
  });

  it('default-denies workspace removal without changing existing surface gating', () => {
    expect(MINIMAL_CAPABILITIES.workspaceRemoval).toBeUndefined();

    const workspaceRemovalValues: readonly (false | 'archive')[] = [
      false,
      'archive',
    ];
    for (const workspaceRemoval of workspaceRemovalValues) {
      const withWorkspaceRemoval: CanopyCapabilities = {
        ...MINIMAL_CAPABILITIES,
        workspaceRemoval,
      };
      expect(getAvailablePanelKinds(withWorkspaceRemoval)).toEqual(
        getAvailablePanelKinds(MINIMAL_CAPABILITIES),
      );
      expect(getAvailableFeatureSurfaces(withWorkspaceRemoval)).toEqual(
        getAvailableFeatureSurfaces(MINIMAL_CAPABILITIES),
      );
    }
  });
});

describe('feature-surface gating', () => {
  it('maps every declared feature surface', () => {
    expect(Object.keys(FEATURE_CAPABILITY_REQUIREMENTS).sort()).toEqual(
      [...FEATURE_SURFACES].sort(),
    );
  });

  it('shows every feature surface except the dormant panel-layout toggle to a full-capability client', () => {
    const available = getAvailableFeatureSurfaces(FULL_CAPABILITIES);
    // Native Open is exposed; the panel-layout toggle stays hidden until a
    // real desktop host opts in (`panelLayoutControls` is false everywhere).
    expect(available).toContain('native-worktree-open');
    expect(available).not.toContain('panel-layout-controls');
    // Every other surface remains available in canonical order.
    expect(available).toEqual(
      FEATURE_SURFACES.filter((surface) => surface !== 'panel-layout-controls'),
    );
  });

  it('hides both new worktree-top-bar surfaces from web and minimal clients', () => {
    for (const capabilities of [WEB_CAPABILITIES, MINIMAL_CAPABILITIES]) {
      expect(
        isFeatureSurfaceAvailable(capabilities, 'native-worktree-open'),
      ).toBe(false);
      expect(
        isFeatureSurfaceAvailable(capabilities, 'panel-layout-controls'),
      ).toBe(false);
    }
  });

  it('shows Marketplace owned automation shares only to a host that opts in', () => {
    expect(
      isFeatureSurfaceAvailable(
        FULL_CAPABILITIES,
        'marketplace-owned-automation-shares',
      ),
    ).toBe(true);
    for (const capabilities of [WEB_CAPABILITIES, MINIMAL_CAPABILITIES]) {
      expect(
        isFeatureSurfaceAvailable(
          capabilities,
          'marketplace-owned-automation-shares',
        ),
      ).toBe(false);
    }
  });

  it('shows the every-tab "Shared by me" filter only to a host that opts in (CAN-4263)', () => {
    for (const capabilities of [FULL_CAPABILITIES, WEB_CAPABILITIES]) {
      expect(
        isFeatureSurfaceAvailable(capabilities, 'marketplace-owned-shares'),
      ).toBe(true);
    }
    // Unset (an older payload or an unconfigured host) stays hidden.
    expect(
      isFeatureSurfaceAvailable(
        MINIMAL_CAPABILITIES,
        'marketplace-owned-shares',
      ),
    ).toBe(false);
  });

  it('offers shared collection Edit only on a host with a local catalog (CAN-4263)', () => {
    expect(
      isFeatureSurfaceAvailable(
        FULL_CAPABILITIES,
        'marketplace-shared-collection-edit',
      ),
    ).toBe(true);
    // Web owners Unshare there and edit in the desktop app.
    expect(
      isFeatureSurfaceAvailable(
        WEB_CAPABILITIES,
        'marketplace-shared-collection-edit',
      ),
    ).toBe(false);
    expect(
      isFeatureSurfaceAvailable(
        MINIMAL_CAPABILITIES,
        'marketplace-shared-collection-edit',
      ),
    ).toBe(false);
  });

  it('offers custom skill Edit only on a host with a skill editor (CAN-4844)', () => {
    expect(
      isFeatureSurfaceAvailable(FULL_CAPABILITIES, 'custom-skill-edit'),
    ).toBe(true);
    // Web shows the item disabled with a desktop reason.
    expect(
      isFeatureSurfaceAvailable(WEB_CAPABILITIES, 'custom-skill-edit'),
    ).toBe(false);
    // Unset (an older payload or an unconfigured host) stays unavailable.
    expect(
      isFeatureSurfaceAvailable(
        { ...FULL_CAPABILITIES, customSkillEdit: undefined },
        'custom-skill-edit',
      ),
    ).toBe(false);
    expect(
      isFeatureSurfaceAvailable(MINIMAL_CAPABILITIES, 'custom-skill-edit'),
    ).toBe(false);
  });

  it('shows the scheduled workflow surfaces only to a host that runs automations', () => {
    for (const surface of ['workflow-schedule', 'workflow-automations']) {
      expect(isFeatureSurfaceAvailable(FULL_CAPABILITIES, surface)).toBe(true);
      // Web and minimal leave `automations` unset; explicit `false` also denies.
      for (const capabilities of [
        WEB_CAPABILITIES,
        MINIMAL_CAPABILITIES,
        { ...FULL_CAPABILITIES, automations: false },
      ]) {
        expect(isFeatureSurfaceAvailable(capabilities, surface)).toBe(false);
      }
    }
    // The axes are independent: watchers alone does not unlock automations.
    expect(
      isFeatureSurfaceAvailable(
        { ...WEB_CAPABILITIES, watchers: true },
        'workflow-automations',
      ),
    ).toBe(false);
  });

  it('shows workflow watchers only to a host that reports watchers', () => {
    expect(
      isFeatureSurfaceAvailable(FULL_CAPABILITIES, 'workflow-watchers'),
    ).toBe(true);
    for (const capabilities of [
      WEB_CAPABILITIES,
      MINIMAL_CAPABILITIES,
      { ...FULL_CAPABILITIES, watchers: false },
      { ...WEB_CAPABILITIES, automations: true },
    ]) {
      expect(isFeatureSurfaceAvailable(capabilities, 'workflow-watchers')).toBe(
        false,
      );
    }
  });

  it('shows Customize workflow management only to a host that reports it', () => {
    expect(
      meetsCapabilityRequirement(FULL_CAPABILITIES, {
        workflowManagement: true,
      }),
    ).toBe(true);
    expect(
      isFeatureSurfaceAvailable(FULL_CAPABILITIES, 'workflow-management'),
    ).toBe(true);
    // Web and minimal leave it unset; explicit `false` also denies, and the
    // automations axis alone does not unlock it.
    for (const capabilities of [
      WEB_CAPABILITIES,
      MINIMAL_CAPABILITIES,
      { ...FULL_CAPABILITIES, workflowManagement: false },
      { ...WEB_CAPABILITIES, automations: true, watchers: true },
    ]) {
      expect(
        meetsCapabilityRequirement(capabilities, { workflowManagement: true }),
      ).toBe(false);
      expect(
        isFeatureSurfaceAvailable(capabilities, 'workflow-management'),
      ).toBe(false);
    }
  });

  it('default-denies the optional surfaces whether the field is unset or false', () => {
    // MINIMAL leaves both optional fields unset → default-hidden.
    expect(
      isFeatureSurfaceAvailable(MINIMAL_CAPABILITIES, 'native-worktree-open'),
    ).toBe(false);
    expect(
      isFeatureSurfaceAvailable(MINIMAL_CAPABILITIES, 'panel-layout-controls'),
    ).toBe(false);
    // Explicit `false` is likewise hidden (no dead UI from a bare `true`).
    const explicitFalse: CanopyCapabilities = {
      ...FULL_CAPABILITIES,
      nativeWorktreeOpen: false,
      panelLayoutControls: false,
    };
    expect(
      isFeatureSurfaceAvailable(explicitFalse, 'native-worktree-open'),
    ).toBe(false);
    expect(
      isFeatureSurfaceAvailable(explicitFalse, 'panel-layout-controls'),
    ).toBe(false);
  });

  it('exposes panel-layout-controls once a host opts in (P2 desktop toggle)', () => {
    const withToggle: CanopyCapabilities = {
      ...FULL_CAPABILITIES,
      panelLayoutControls: true,
    };
    expect(isFeatureSurfaceAvailable(withToggle, 'panel-layout-controls')).toBe(
      true,
    );
    expect(getAvailableFeatureSurfaces(withToggle)).toContain(
      'panel-layout-controls',
    );
  });

  it('hides desktop-only affordances from a web-shaped client', () => {
    expect(isFeatureSurfaceAvailable(WEB_CAPABILITIES, 'voice-dictation')).toBe(
      false,
    );
    expect(isFeatureSurfaceAvailable(WEB_CAPABILITIES, 'file-editing')).toBe(
      false,
    );
    expect(
      isFeatureSurfaceAvailable(WEB_CAPABILITIES, 'pipeline-execution'),
    ).toBe(false);
    expect(isFeatureSurfaceAvailable(WEB_CAPABILITIES, 'full-settings')).toBe(
      false,
    );
    // Web relays pipeline CRUD, so editing stays available.
    expect(
      isFeatureSurfaceAvailable(WEB_CAPABILITIES, 'pipeline-editing'),
    ).toBe(true);
    // "Shared by me" lists account shares on every tab on web too.
    expect(getAvailableFeatureSurfaces(WEB_CAPABILITIES)).toEqual([
      'pipeline-editing',
      'marketplace-owned-shares',
    ]);
  });

  it('defaults unknown feature surfaces to hidden', () => {
    expect(
      isFeatureSurfaceAvailable(FULL_CAPABILITIES, 'holographic-mode'),
    ).toBe(false);
    expect(isFeatureSurface('holographic-mode')).toBe(false);
    expect(isFeatureSurface('voice-dictation')).toBe(true);
    expect(isFeatureSurface('native-worktree-open')).toBe(true);
    expect(isFeatureSurface('panel-layout-controls')).toBe(true);
    expect(isFeatureSurface(42)).toBe(false);
  });
});
