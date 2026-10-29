import type { ProviderCarryoverSummary } from '@canopy/desktop-shared/types';
import {
  providerCarryoverAttention,
  providerCarryoverLine,
} from '../providerCarryoverCopy';

function summary(
  overrides: Partial<ProviderCarryoverSummary> & {
    provider: ProviderCarryoverSummary['provider'];
  },
): ProviderCarryoverSummary {
  return { skills: 0, commands: 0, plugins: 0, attention: [], ...overrides };
}

describe('providerCarryoverLine', () => {
  it('names what Claude Code carries over and where it is ready', () => {
    expect(
      providerCarryoverLine(
        summary({ provider: 'claude', skills: 2, commands: 1, plugins: 1 }),
      ),
    ).toBe('2 skills, 1 command, and 1 plugin ready');
  });

  it('leaves out zero counts and keeps one item unlisted', () => {
    expect(
      providerCarryoverLine(summary({ provider: 'codex', plugins: 3 })),
    ).toBe('3 plugins ready');
  });

  it('tells a user with nothing yet what will carry over', () => {
    expect(providerCarryoverLine(summary({ provider: 'claude' }))).toBe(
      'Skills, commands, and plugins you add to Claude Code are ready in your Claude chats.',
    );
    expect(providerCarryoverLine(summary({ provider: 'codex' }))).toBe(
      'Skills and plugins you add to Codex are ready in your Codex chats.',
    );
    expect(providerCarryoverLine(summary({ provider: 'cursor' }))).toBe(
      'Skills and commands in the folders your Cursor chats read are ready in your Cursor chats.',
    );
  });

  it('describes the folders a Cursor chat reads', () => {
    expect(
      providerCarryoverLine(
        summary({ provider: 'cursor', skills: 3, commands: 1, plugins: 2 }),
      ),
    ).toBe(
      'From the folders your Cursor chats read: 3 skills, 1 command, and 2 plugins, ready in your Cursor chats.',
    );
  });
});

describe('providerCarryoverAttention', () => {
  it('names the entries that could not be loaded, or nothing', () => {
    expect(providerCarryoverAttention(summary({ provider: 'cursor' }))).toBe(
      null,
    );
    expect(
      providerCarryoverAttention(
        summary({
          provider: 'cursor',
          attention: ['~/.cursor/skills/broken', '~/.claude/commands/odd'],
        }),
      ),
    ).toBe("Couldn't load ~/.cursor/skills/broken, ~/.claude/commands/odd.");
  });
});
