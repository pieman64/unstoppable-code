import { COMMAND_DEFINITIONS } from '@/lib/keyboardShortcuts';
import {
  ESSENTIAL_SHORTCUT_COMMAND_IDS,
  PANEL_SHORTCUT_COMMAND_IDS,
  SURFACE_SHORTCUT_COMMAND_IDS,
} from '../keyboardShortcutSections';

describe('KeyboardShortcutsTab', () => {
  it('includes the shortcut used to open the shortcuts page', () => {
    expect(ESSENTIAL_SHORTCUT_COMMAND_IDS).toContain('open-shortcuts-settings');
  });

  it('lists every context-aware surface shortcut with a definition and shortcut string (ECW-7984)', () => {
    expect(SURFACE_SHORTCUT_COMMAND_IDS.length).toBeGreaterThan(0);
    for (const commandId of SURFACE_SHORTCUT_COMMAND_IDS) {
      const definition = COMMAND_DEFINITIONS.find(
        (entry) => entry.id === commandId,
      );
      expect(definition).toBeDefined();
      expect(definition?.shortcut).toBeTruthy();
    }
  });

  it('lists every panel command with a definition and a default shortcut', () => {
    expect(PANEL_SHORTCUT_COMMAND_IDS.length).toBeGreaterThan(0);
    for (const commandId of PANEL_SHORTCUT_COMMAND_IDS) {
      const definition = COMMAND_DEFINITIONS.find(
        (entry) => entry.id === commandId,
      );
      expect(definition).toBeDefined();
      expect(definition?.category).toBe('panels');
      expect(definition?.shortcut).toBeTruthy();
      expect(definition?.requiresWorktree).toBe(true);
    }
  });

  it('keeps panel section ids in sync with the shortcut binding table', async () => {
    const { PANEL_SHORTCUT_BINDINGS } = await import('@/lib/panels/commands');
    // A command can have several bindings (platform scope, alternates), but
    // appears once in the section.
    expect([...PANEL_SHORTCUT_COMMAND_IDS].sort()).toEqual(
      [...new Set(PANEL_SHORTCUT_BINDINGS.map((binding) => binding.id))].sort(),
    );
  });
});
