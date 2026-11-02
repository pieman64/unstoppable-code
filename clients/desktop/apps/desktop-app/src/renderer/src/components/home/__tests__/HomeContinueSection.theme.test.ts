/**
 * @jest-environment node
 */
// Source-level coverage avoids mounting the card's project and chat stores.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const HOME_SURFACE_SOURCE = readFileSync(
  join(__dirname, '..', 'HomeSurface.tsx'),
  'utf-8',
);

// Keep these narrow host-boundary guards until the corresponding negative
// cases are exercised through Home. Shared component and Electron suites own
// rendered theme, layout, Continue actions, and visible send-error coverage.
describe('Home Continue host boundaries', () => {
  it('keeps the below-composer sections alive while composing', () => {
    // Removing a render gate is insufficient if its producing hook still
    // goes inert on a non-empty draft.
    expect(HOME_SURFACE_SOURCE).not.toContain('draftIsEmpty');
    expect(HOME_SURFACE_SOURCE).toMatch(/\{suggestedPrompts\.length > 0 && \(/);
  });

  it('preserves project fixes independently of the retired checklist', () => {
    expect(HOME_SURFACE_SOURCE).toContain('HomeWorkspaceReadiness');
  });

  it('gates the Home retry action on retryable send failures', () => {
    // The retry button must live in the truthy branch, so an inverted gate or
    // an ungated button fails.
    expect(HOME_SURFACE_SOURCE).toMatch(
      /sendErrorRetryable \?\s*\(\s*<NoticeButton[^>]*data-testid="home-composer-retry"/,
    );
  });
});
