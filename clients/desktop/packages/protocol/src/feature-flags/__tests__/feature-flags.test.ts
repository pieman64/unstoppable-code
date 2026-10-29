import {
  CLIENT_FEATURE_FLAGS,
  CLIENT_FEATURE_FLAG_DEFAULTS,
  CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS,
  CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
  getDefaultFeatureFlagSnapshot,
  isClientFeatureFlagConfirmedEnabled,
  type ClientFeatureFlagKey,
  type ClientFeatureFlagValues,
  type FeatureFlagSnapshot,
} from '../index';

describe('client feature flag registry', () => {
  it.each(['not_configured', 'initializing', 'error'] as const)(
    'keeps Copilot off without a live verdict: %s',
    (status) => {
      expect(getDefaultFeatureFlagSnapshot(status).values).toHaveProperty(
        'canopy-desktop-copilot-harness',
        false,
      );
    },
  );

  it.each([
    ['not_configured', true],
    ['initializing', false],
    ['error', false],
  ] as const)(
    'uses the confirmed OpenCode default for %s',
    (status, expected) => {
      expect(
        getDefaultFeatureFlagSnapshot(status).values[
          'canopy-desktop-opencode-harness'
        ],
      ).toBe(expected);
    },
  );

  it.each([
    ['not_configured', false],
    ['initializing', false],
    ['error', false],
  ] as const)('launches the account proxy dark for %s', (status, expected) => {
    expect(
      getDefaultFeatureFlagSnapshot(status).values[
        'canopy-desktop-account-proxy'
      ],
    ).toBe(expected);
  });

  it.each([
    ['not_configured', true],
    ['initializing', false],
    ['error', false],
  ] as const)(
    'turns the desktop External agents menu %s to %s',
    (status, expected) => {
      expect(
        getDefaultFeatureFlagSnapshot(status).values[
          'canopy-desktop-external-agents-menu'
        ],
      ).toBe(expected);
    },
  );

  it.each([
    ['not_configured', true],
    ['initializing', false],
    ['error', false],
  ] as const)('turns desktop hosted settings %s to %s', (status, expected) => {
    expect(
      getDefaultFeatureFlagSnapshot(status).values[
        'canopy-desktop-hosted-settings'
      ],
    ).toBe(expected);
  });

  it.each([
    ['not_configured', false],
    ['initializing', false],
    ['error', false],
  ] as const)('launches daemon Files reads dark for %s', (status, expected) => {
    expect(
      getDefaultFeatureFlagSnapshot(status).values[
        'canopy-desktop-daemon-files-reads'
      ],
    ).toBe(expected);
  });

  it('registers the expected client-visible flags', () => {
    const keys = Object.values(CLIENT_FEATURE_FLAGS).map((entry) => entry.key);
    expect(keys).toEqual([
      'canopy-desktop-labs-early-access',
      'canopy-desktop-labs-sidebar',
      'canopy-desktop-labs-activity-card',
      'canopy-desktop-labs-minimal-layout',
      'canopy-desktop-labs-comet-spinners',
      'canopy-desktop-labs-chat-tab-previews',
      'canopy-desktop-labs-subagents-view',
      'canopy-desktop-labs-archived-chats-card',
      'canopy-desktop-labs-clean-chat',
      'canopy-desktop-labs-proxy-account-cards',
      'canopy-desktop-labs-pr-hover-cards',
      'canopy-desktop-labs-overview-page',
      'canopy-desktop-labs-kanban-page',
      'canopy-desktop-labs-statistics-page',
      'canopy-desktop-labs-audit-trail-page',
      'canopy-desktop-posthog-capture-enabled',
      'canopy-desktop-posthog-session-replay-sample-rate',
      'canopy-desktop-posthog-autocapture-enabled',
      'canopy-shared-release-notes-enabled',
      'canopy-portal-enabled',
      'canopy-ledger-enabled',
      'canopy-shared-claude-model-fable5',
      'canopy-digests-enabled',
      'canopy-shared-custom-agents',
      'canopy-cloud-sign-in-required',
      'canopy-guest-mode-enabled',
      'canopy-portal-sse-commands',
      'canopy-portal-sse-events',
      'canopy-portal-async-snapshots',
      'canopy-portal-destructive-actions',
      'canopy-device-remote-control',
      'canopy-desktop-pr-split',
      'canopy-desktop-cursor-harness',
      'canopy-desktop-cursor-harness-released',
      'canopy-desktop-copilot-harness',
      'canopy-desktop-opencode-harness',
      'canopy-desktop-claude-tui-workers',
      'canopy-desktop-claude-tui-chats',
      'canopy-desktop-workspace-code-graph',
      'canopy-desktop-chat-visuals',
      'canopy-billing-enabled',
      'canopy-desktop-suggested-prompts',
      'canopy-desktop-start-page',
      'canopy-desktop-shared-containers',
      'canopy-shared-container-external-sharing',
      'canopy-cloud-agents',
      'canopy-activation-journey-enabled',
      'canopy-shared-org-projects-enabled',
      'canopy-shared-auto-model-routing',
      'canopy-shared-mcp-account-connections',
      'canopy-shared-space-notification-settings',
      'canopy-cloud-git-enabled',
      'canopy-free-access-enabled',
      'canopy-desktop-account-proxy',
      'canopy-desktop-skill-suggestions',
      'canopy-desktop-hosted-settings',
      'canopy-desktop-daemon-files-reads',
      'canopy-desktop-external-agents-menu',
    ]);
  });

  it('turns chat visuals on without LaunchDarkly and off when it is unavailable', () => {
    expect(CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals.key).toBe(
      'canopy-desktop-chat-visuals',
    );
    // Local development and tests run without LaunchDarkly; release builds
    // always bundle a client ID, so users still need the flag enabled there.
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-desktop-chat-visuals'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-desktop-chat-visuals'
      ],
    ).toBe(false);
  });

  it('fails open locally and closed on evaluator failure for Auto routing', () => {
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-shared-auto-model-routing'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-shared-auto-model-routing'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-shared-org-projects-enabled', () => {
    // An unconfigured runtime shows organization projects (decision
    // 2026-09-28), while a LaunchDarkly outage still hides the context
    // switcher, catalog rows, and every org-project route.
    expect(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled
        .launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-shared-org-projects-enabled'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-shared-org-projects-enabled'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-cloud-agents', () => {
    // Disabled-default is ON (local dev / hermetic harness can reach the cloud
    // surface without LaunchDarkly); enabled-but-unavailable stays OFF so a
    // deployed environment fails closed while the surface is dark-launched.
    expect(
      CLIENT_FEATURE_FLAGS.canopyCloudAgents.launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyCloudAgents
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS['canopy-cloud-agents'],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-cloud-agents'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-desktop-shared-containers', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers
        .launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-desktop-shared-containers'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-desktop-shared-containers'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-portal-sse-events', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyPortalSseEvents
        .launchDarklyDisabledDefaultValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAGS.canopyPortalSseEvents
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-portal-sse-events'
      ],
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-portal-sse-events'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-portal-async-snapshots', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyPortalAsyncSnapshots
        .launchDarklyDisabledDefaultValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAGS.canopyPortalAsyncSnapshots
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-portal-async-snapshots'
      ],
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-portal-async-snapshots'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-portal-enabled', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyPortalEnabled.launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyPortalEnabled
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-portal-enabled'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-portal-enabled'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-ledger-enabled', () => {
    // The confirmed LD09 defaults are locally enabled and unavailable-closed.
    expect(
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-ledger-enabled'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-ledger-enabled'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-shared-claude-model-fable5', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5
        .launchDarklyDisabledDefaultValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-shared-claude-model-fable5'
      ],
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-shared-claude-model-fable5'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-shared-custom-agents', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopySharedCustomAgents
        .launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopySharedCustomAgents
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-shared-custom-agents'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-shared-custom-agents'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-cloud-sign-in-required', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired
        .launchDarklyDisabledDefaultValue,
    ).toBe(false);
    // Flipped false in CAN-934 so the gate no longer fails closed when
    // LaunchDarkly is configured but unavailable (guest mode covers first run).
    expect(
      CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-cloud-sign-in-required'
      ],
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-cloud-sign-in-required'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-guest-mode-enabled', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled
        .launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-guest-mode-enabled'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-guest-mode-enabled'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-desktop-pr-split', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit
        .launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-desktop-pr-split'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-desktop-pr-split'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-desktop-claude-tui-workers', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers
        .launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-desktop-claude-tui-workers'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-desktop-claude-tui-workers'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-desktop-claude-tui-chats', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats
        .launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-desktop-claude-tui-chats'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-desktop-claude-tui-chats'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-desktop-workspace-code-graph', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph
        .launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-desktop-workspace-code-graph'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-desktop-workspace-code-graph'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-billing-enabled', () => {
    expect(
      CLIENT_FEATURE_FLAGS.canopyBillingEnabled
        .launchDarklyDisabledDefaultValue,
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAGS.canopyBillingEnabled
        .launchDarklyEnabledUnavailableValue,
    ).toBe(false);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-billing-enabled'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-billing-enabled'
      ],
    ).toBe(false);
  });

  it('defines both LaunchDarkly default modes for canopy-shared-space-notification-settings', () => {
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
        'canopy-shared-space-notification-settings'
      ],
    ).toBe(true);
    expect(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
        'canopy-shared-space-notification-settings'
      ],
    ).toBe(false);
  });

  it('default maps only contain registered client-visible keys', () => {
    const registryKeys = new Set(
      Object.values(CLIENT_FEATURE_FLAGS).map((entry) => entry.key),
    );
    for (const defaultMap of [
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS,
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
    ]) {
      const defaultKeys = Object.keys(defaultMap);
      for (const key of defaultKeys) {
        expect(registryKeys.has(key as ClientFeatureFlagKey)).toBe(true);
      }
      expect(defaultKeys).toHaveLength(registryKeys.size);
    }
  });
});

describe('getDefaultFeatureFlagSnapshot', () => {
  it('returns LaunchDarkly-disabled defaults by default', () => {
    const snapshot: FeatureFlagSnapshot = getDefaultFeatureFlagSnapshot();
    const expected: ClientFeatureFlagValues = {
      'canopy-desktop-labs-early-access': 'offered',
      'canopy-desktop-labs-sidebar': 'offered',
      'canopy-desktop-labs-activity-card': 'offered',
      'canopy-desktop-labs-minimal-layout': 'offered',
      'canopy-desktop-labs-comet-spinners': 'offered',
      'canopy-desktop-labs-chat-tab-previews': 'offered',
      'canopy-desktop-labs-subagents-view': 'offered',
      'canopy-desktop-labs-archived-chats-card': 'offered',
      'canopy-desktop-labs-clean-chat': 'offered',
      'canopy-desktop-labs-proxy-account-cards': 'offered',
      'canopy-desktop-labs-pr-hover-cards': 'offered',
      'canopy-desktop-labs-overview-page': 'offered',
      'canopy-desktop-labs-kanban-page': 'offered',
      'canopy-desktop-labs-statistics-page': 'offered',
      'canopy-desktop-labs-audit-trail-page': 'offered',
      'canopy-desktop-posthog-capture-enabled': true,
      'canopy-desktop-posthog-session-replay-sample-rate': 100,
      'canopy-desktop-posthog-autocapture-enabled': true,
      'canopy-shared-release-notes-enabled': false,
      'canopy-portal-enabled': true,
      'canopy-ledger-enabled': true,
      'canopy-shared-claude-model-fable5': false,
      'canopy-digests-enabled': true,
      'canopy-shared-custom-agents': true,
      'canopy-cloud-sign-in-required': false,
      'canopy-guest-mode-enabled': true,
      'canopy-portal-sse-commands': false,
      'canopy-portal-sse-events': false,
      'canopy-portal-async-snapshots': false,
      'canopy-portal-destructive-actions': false,
      'canopy-device-remote-control': true,
      'canopy-desktop-pr-split': true,
      'canopy-desktop-cursor-harness': true,
      'canopy-desktop-cursor-harness-released': false,
      'canopy-desktop-copilot-harness': false,
      'canopy-desktop-opencode-harness': true,
      'canopy-desktop-claude-tui-workers': true,
      'canopy-desktop-claude-tui-chats': true,
      'canopy-desktop-workspace-code-graph': true,
      'canopy-desktop-chat-visuals': true,
      'canopy-billing-enabled': true,
      'canopy-desktop-suggested-prompts': true,
      'canopy-desktop-start-page': true,
      'canopy-cloud-agents': true,
      'canopy-activation-journey-enabled': false,
      'canopy-desktop-shared-containers': true,
      'canopy-shared-container-external-sharing': true,
      'canopy-shared-org-projects-enabled': true,
      'canopy-shared-auto-model-routing': true,
      'canopy-shared-mcp-account-connections': false,
      'canopy-shared-space-notification-settings': true,
      'canopy-cloud-git-enabled': false,
      'canopy-free-access-enabled': true,
      'canopy-desktop-account-proxy': false,
      'canopy-desktop-external-agents-menu': true,
      'canopy-desktop-skill-suggestions': true,
      'canopy-desktop-hosted-settings': true,
      'canopy-desktop-daemon-files-reads': false,
    };
    expect(snapshot.values).toEqual(expected);
  });

  it('uses status="not_configured" and error=null by default', () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    expect(snapshot.status).toBe('not_configured');
    expect(snapshot.error).toBeNull();
    expect(snapshot.initialized).toBe(false);
  });

  it('uses LaunchDarkly-enabled unavailable fallbacks for failure snapshots by default', () => {
    const snapshot = getDefaultFeatureFlagSnapshot('error', 'kaboom');
    expect(snapshot.status).toBe('error');
    expect(snapshot.error).toBe('kaboom');
    expect(snapshot.values).toEqual(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
    );
  });

  it('allows callers to explicitly choose the default mode', () => {
    const snapshot = getDefaultFeatureFlagSnapshot(
      'error',
      'kaboom',
      'launchdarkly_disabled',
    );
    expect(snapshot.values).toEqual(
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS,
    );
  });

  it('returns a fresh values object on every call', () => {
    const first = getDefaultFeatureFlagSnapshot();
    const second = getDefaultFeatureFlagSnapshot();
    expect(first).not.toBe(second);
    expect(first.values).not.toBe(second.values);
  });

  it('does not let snapshot mutation leak into the registry default', () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-portal-enabled'] = false;

    // The registry default must remain untouched.
    expect(CLIENT_FEATURE_FLAG_DEFAULTS['canopy-portal-enabled']).toBe(true);

    // A fresh snapshot must also remain untouched.
    const refreshed = getDefaultFeatureFlagSnapshot();
    expect(refreshed.values['canopy-portal-enabled']).toBe(true);
    expect(refreshed.values).not.toBe(snapshot.values);
  });

  it('returns a JSON-serializable updatedAt timestamp', () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    expect(typeof snapshot.updatedAt).toBe('string');
    // Round-trips through Date without throwing.
    expect(Number.isNaN(Date.parse(snapshot.updatedAt))).toBe(false);
  });
});

describe('isClientFeatureFlagConfirmedEnabled', () => {
  it('treats a not_configured true default as not confirmed', () => {
    const snapshot = getDefaultFeatureFlagSnapshot('not_configured');
    expect(
      isClientFeatureFlagConfirmedEnabled(
        snapshot,
        CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
      ),
    ).toBe(false);
  });

  it('returns true for a configured snapshot with a true value', () => {
    const snapshot = getDefaultFeatureFlagSnapshot('ready');
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key] = true;
    snapshot.initialized = true;

    expect(
      isClientFeatureFlagConfirmedEnabled(
        snapshot,
        CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
      ),
    ).toBe(true);
  });

  it('returns false for configured snapshots with a false value', () => {
    const snapshot = getDefaultFeatureFlagSnapshot('ready');
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key] = false;
    snapshot.initialized = true;

    expect(
      isClientFeatureFlagConfirmedEnabled(
        snapshot,
        CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
      ),
    ).toBe(false);
  });
});

it('uses the confirmed Cursor harness defaults', () => {
  expect(
    CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
      'canopy-desktop-cursor-harness'
    ],
  ).toBe(true);
  expect(
    CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
      'canopy-desktop-cursor-harness'
    ],
  ).toBe(false);
});

it('keeps skill suggestions on when unconfigured and off when unavailable', () => {
  expect(CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key).toBe(
    'canopy-desktop-skill-suggestions',
  );
  expect(
    CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
      'canopy-desktop-skill-suggestions'
    ],
  ).toBe(true);
  expect(
    CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
      'canopy-desktop-skill-suggestions'
    ],
  ).toBe(false);
});

it('registers account MCP connections with both defaults disabled', () => {
  const flag = CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections;
  expect(flag).toEqual({
    key: 'canopy-shared-mcp-account-connections',
    description:
      'Account-scoped MCP connections (web vault + proxy) in the cloud picker and desktop MCP tab',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
  });
  expect(CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[flag.key]).toBe(
    false,
  );
  expect(
    CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[flag.key],
  ).toBe(false);
});

it('registers cloud Git with both defaults disabled', () => {
  const flag = CLIENT_FEATURE_FLAGS.canopyCloudGitEnabled;
  expect(flag).toEqual({
    key: 'canopy-cloud-git-enabled',
    description:
      'Connect GitHub for cloud: personal GitHub authorization and installation targets for cloud projects',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
  });
  expect(CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[flag.key]).toBe(
    false,
  );
  expect(
    CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[flag.key],
  ).toBe(false);
});

it('registers free access on without LaunchDarkly and off in an outage (CAN-3926)', () => {
  const flag = CLIENT_FEATURE_FLAGS.canopyFreeAccessEnabled;
  expect(flag.key).toBe('canopy-free-access-enabled');
  expect(CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[flag.key]).toBe(
    true,
  );
  expect(
    CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[flag.key],
  ).toBe(false);
});

it('declares every PostHog default in every snapshot', () => {
  expect(getDefaultFeatureFlagSnapshot().values).toMatchObject({
    'canopy-desktop-posthog-capture-enabled': true,
    'canopy-desktop-posthog-session-replay-sample-rate': 100,
    'canopy-desktop-posthog-autocapture-enabled': true,
  });
  for (const status of ['initializing', 'error'] as const) {
    expect(getDefaultFeatureFlagSnapshot(status).values).toMatchObject({
      'canopy-desktop-posthog-capture-enabled': false,
      'canopy-desktop-posthog-session-replay-sample-rate': 0,
      'canopy-desktop-posthog-autocapture-enabled': false,
    });
  }
});

it('keeps Cursor release off until explicitly enabled in either evaluation mode', () => {
  expect(
    CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[
      'canopy-desktop-cursor-harness-released'
    ],
  ).toBe(false);
  expect(
    CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[
      'canopy-desktop-cursor-harness-released'
    ],
  ).toBe(false);
});

it('keeps release notes off in both fallback modes', () => {
  expect(
    getDefaultFeatureFlagSnapshot('not_configured').values[
      'canopy-shared-release-notes-enabled'
    ],
  ).toBe(false);
  expect(
    getDefaultFeatureFlagSnapshot('error').values[
      'canopy-shared-release-notes-enabled'
    ],
  ).toBe(false);
});
