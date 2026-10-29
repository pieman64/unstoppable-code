/**
 * @jest-environment node
 */
// Source-level coverage for the Home speed wiring, following the other Home
// composer suites: the effort panel, cycle, availability view, and step-down
// carry their own behavioral tests (`ThinkingLevelControl`,
// `CodexSpeedControl`, `useCodexSpeedControl`, `useCodexSpeedDowngrade`), and
// the Electron Home handoff specs drive the real Regular/Fast/Ultra fast flow.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'HomeComposerControls.tsx'),
  'utf-8',
);

describe('HomeComposerControls Codex speed', () => {
  it('stages an exact speed rather than toggling the legacy boolean', () => {
    expect(SOURCE).not.toContain('setFastMode(');
    expect(SOURCE).not.toContain('resolveHomeFastMode');
    expect(SOURCE).toContain('resolveHomeSpeed(');
    expect(SOURCE).toContain('setSpeed(');
  });

  it('keeps speed in the effort panel bolt, with Ultra fast as its third state', () => {
    // No separate speed chip beside the effort trigger, as on develop.
    expect(SOURCE).not.toContain('buildCodexSpeedChip');
    expect(SOURCE).not.toContain("'home-fast-mode-button'");
    expect(SOURCE).toContain('fastMode: {');
    expect(SOURCE).toContain("on: effectiveSpeed !== 'standard'");
    expect(SOURCE).toContain("ultra: effectiveSpeed === 'ultrafast'");
    expect(SOURCE).toContain('onToggle: cycleSpeed');
  });

  it('cycles with availability for the draft route, including Auto and the billing lane', () => {
    // Availability comes from the host's Home-scoped route projection, never
    // from the global catalog alone.
    expect(SOURCE).toContain('useContextualCodexSpeedControl({');
    expect(SOURCE).toContain("kind: 'home'");
    expect(SOURCE).toContain('auto: autoSelected');
    expect(SOURCE).toContain(
      "aiCreditsRouted: nextChatBilling === 'ai-credits'",
    );
    expect(SOURCE).toContain('nextCodexSpeed(');
    // Both the effort panel bolt and the /fast composer action use the
    // same cycle.
    expect(SOURCE.match(/cycleSpeed/g)?.length).toBeGreaterThanOrEqual(3);
    // A model that cannot run Ultra fast steps the draft down instead of
    // keeping a blocked choice.
    expect(SOURCE).toContain('useCodexSpeedDowngrade({');
    expect(SOURCE).toContain('apply: setSpeed');
  });
});
