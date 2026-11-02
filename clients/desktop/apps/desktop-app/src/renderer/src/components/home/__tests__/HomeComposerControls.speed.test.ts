/**
 * @jest-environment node
 */
// Keep the Home route-projection boundary guard until an integration test
// covers Auto/AI Credits invalidation. The shared speed-control suites and
// Electron Home handoff specs cover speed cycling and persisted handoffs.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'HomeComposerControls.tsx'),
  'utf-8',
);

describe('HomeComposerControls Codex speed', () => {
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
