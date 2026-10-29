import { subagentCapabilitiesForKind } from '../subagent-capabilities';
import type { SubagentViewerCapabilities } from '../types';

const CAPABILITIES: SubagentViewerCapabilities = {
  stop: true,
  messaging: true,
  worktreeDetails: true,
  nativeInterrupt: true,
  openWorkflow: true,
  stopWorkflow: true,
};

describe('subagent viewer capabilities', () => {
  it('keeps workflow agents read-only while retaining workflow actions', () => {
    expect(subagentCapabilitiesForKind(CAPABILITIES, 'workflow-agent')).toEqual(
      {
        stop: false,
        messaging: false,
        worktreeDetails: false,
        nativeInterrupt: false,
        openWorkflow: true,
        stopWorkflow: true,
      },
    );
  });

  it.each(['workflow-run', 'workflow-phase'] as const)(
    'keeps %s groups read-only while retaining workflow actions',
    (kind) => {
      expect(subagentCapabilitiesForKind(CAPABILITIES, kind)).toEqual({
        stop: false,
        messaging: false,
        worktreeDetails: false,
        nativeInterrupt: false,
        openWorkflow: true,
        stopWorkflow: true,
      });
    },
  );

  it('keeps workflow-agent capability objects stable after narrowing', () => {
    const alreadyNarrowed: SubagentViewerCapabilities = {
      ...CAPABILITIES,
      stop: false,
      messaging: false,
      worktreeDetails: false,
      nativeInterrupt: false,
    };

    expect(subagentCapabilitiesForKind(alreadyNarrowed, 'workflow-agent')).toBe(
      alreadyNarrowed,
    );
  });

  it('keeps the host object for managed and Claude agents', () => {
    expect(subagentCapabilitiesForKind(CAPABILITIES, 'managed')).toBe(
      CAPABILITIES,
    );
    expect(subagentCapabilitiesForKind(CAPABILITIES, 'claude-native')).toBe(
      CAPABILITIES,
    );
  });

  it('disables Codex native interrupt without changing unrelated flags', () => {
    expect(subagentCapabilitiesForKind(CAPABILITIES, 'codex-native')).toEqual({
      ...CAPABILITIES,
      nativeInterrupt: false,
    });
    const noNativeInterrupt: SubagentViewerCapabilities = {
      ...CAPABILITIES,
      nativeInterrupt: false,
    };
    expect(subagentCapabilitiesForKind(noNativeInterrupt, 'codex-native')).toBe(
      noNativeInterrupt,
    );
  });
});
