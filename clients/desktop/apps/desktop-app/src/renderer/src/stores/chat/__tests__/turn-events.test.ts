import type { WorktreeDiscovery } from '@canopy/desktop-shared/types';
import {
  getLeadingSlashCommandName,
  isKnownSlashCommand,
  shouldSuppressImplicitStaleSessionDetection,
} from '../turn-events';

const codexDiscovery: WorktreeDiscovery = {
  slashCommands: [{ name: '/skill', description: 'Run a skill' }],
  mcpServers: [],
  discoveredAt: '2026-08-31T00:00:00.000Z',
  providerType: 'codex',
};

const claudeDiscovery: WorktreeDiscovery = {
  ...codexDiscovery,
  providerType: 'claude',
};

describe('turn event command parsing', () => {
  it('always parses slash-prefixed commands', () => {
    expect(getLeadingSlashCommandName('/skill argument')).toBe('skill');
    expect(
      getLeadingSlashCommandName('/skill argument', {
        allowDollarTrigger: true,
      }),
    ).toBe('skill');
  });

  it('parses dollar-prefixed commands only when explicitly enabled', () => {
    expect(getLeadingSlashCommandName('$skill argument')).toBeNull();
    expect(
      getLeadingSlashCommandName('$skill argument', {
        allowDollarTrigger: true,
      }),
    ).toBe('skill');
    expect(isKnownSlashCommand('$skill argument', codexDiscovery)).toBe(false);
    expect(
      isKnownSlashCommand('$skill argument', codexDiscovery, {
        allowDollarTrigger: true,
      }),
    ).toBe(true);
  });

  it('does not suppress stale-session detection for non-Codex dollar prose', () => {
    expect(
      shouldSuppressImplicitStaleSessionDetection(
        '$100 is the budget',
        claudeDiscovery,
      ),
    ).toBe(false);
    expect(
      shouldSuppressImplicitStaleSessionDetection('$unknown', codexDiscovery, {
        allowDollarTrigger: true,
      }),
    ).toBe(true);
  });
});
