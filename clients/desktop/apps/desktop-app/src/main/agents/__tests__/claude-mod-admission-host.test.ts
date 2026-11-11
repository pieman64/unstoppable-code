import {
  CLIENT_FEATURE_FLAG_DEFAULTS,
  CLIENT_FEATURE_FLAGS,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';

// Cited by behavior-inventory/claude-mod-admission.yaml: desktop startup's
// installClaudeModAdmissionHost() keeps the default-off admission flag's
// launch effects out of every child environment until the flag turns on.

const FLAG_KEY = CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission.key;
let flagEnabled = false;
type SnapshotListener = (snapshot: FeatureFlagSnapshot) => void;
interface FeatureFlagServiceStub {
  isEnabled: () => boolean;
  onSnapshotChanged: (listener: SnapshotListener) => () => void;
}
interface AbsentPreferences {
  authority: 'absent';
}
const snapshotListeners: SnapshotListener[] = [];

jest.mock(
  '../../feature-flags',
  (): { getFeatureFlagService: () => FeatureFlagServiceStub } => ({
    getFeatureFlagService: (): FeatureFlagServiceStub => ({
      isEnabled: (): boolean => flagEnabled,
      onSnapshotChanged: (listener: SnapshotListener): (() => void) => {
        snapshotListeners.push(listener);
        return (): void => undefined;
      },
    }),
  }),
);
jest.mock(
  '../../lib/preferences-store',
  (): { readPreferencesFileDetailed: () => Promise<AbsentPreferences> } => ({
    readPreferencesFileDetailed: (): Promise<AbsentPreferences> =>
      Promise.resolve({ authority: 'absent' }),
  }),
);

import {
  installClaudeModAdmissionHost,
  resolveClaudeModAdmissionLaunch,
} from '../claude-mod-admission-launch';

function publish(enabled: boolean): void {
  flagEnabled = enabled;
  for (const listener of snapshotListeners) {
    listener({
      values: { ...CLIENT_FEATURE_FLAG_DEFAULTS, [FLAG_KEY]: enabled },
      status: 'ready',
      initialized: true,
      updatedAt: new Date(0).toISOString(),
      error: null,
    });
  }
}

describe('installClaudeModAdmissionHost', () => {
  const inherited = process.env.CLAUDE_CODE_PLUGIN_DIRS;

  beforeAll(() => {
    process.env.CLAUDE_CODE_PLUGIN_DIRS = '/tmp/inherited-plugins';
    installClaudeModAdmissionHost();
  });

  afterAll(() => {
    if (inherited === undefined) delete process.env.CLAUDE_CODE_PLUGIN_DIRS;
    else process.env.CLAUDE_CODE_PLUGIN_DIRS = inherited;
  });

  it('leaves child environments and launches unchanged while the flag is off', async () => {
    expect(getEnhancedEnv().CLAUDE_CODE_PLUGIN_DIRS).toBe(
      '/tmp/inherited-plugins',
    );
    await expect(
      resolveClaudeModAdmissionLaunch({ cwd: process.cwd() }),
    ).resolves.toBeUndefined();
  });

  it('drops inherited Claude plugin dirs while the flag is on, and restores them when it turns off', () => {
    publish(true);
    expect(getEnhancedEnv()).not.toHaveProperty('CLAUDE_CODE_PLUGIN_DIRS');
    publish(false);
    expect(getEnhancedEnv().CLAUDE_CODE_PLUGIN_DIRS).toBe(
      '/tmp/inherited-plugins',
    );
  });
});
