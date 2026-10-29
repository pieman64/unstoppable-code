/**
 * @jest-environment node
 */
// Source-level coverage avoids mounting the card's project and chat stores.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'HomeContinueSection.tsx'),
  'utf-8',
);
const HOME_SURFACE_SOURCE = readFileSync(
  join(__dirname, '..', 'HomeSurface.tsx'),
  'utf-8',
);

function expectUnborderedElevation(
  source: string,
  testId: string,
  shadow: string,
): void {
  const className = source.match(
    new RegExp(`data-testid="${testId}"[\\s\\S]*?className="([^"]+)"`),
  )?.[1];

  expect(className).toContain(shadow);
  expect(className).not.toMatch(/(?:^|\s)(?:border|ring)(?:-|\s|$)/);
}

describe('HomeContinueSection theme colors', () => {
  it('uses only the semantic background on the home canvas', () => {
    const homeSurface = HOME_SURFACE_SOURCE.match(
      /data-testid="home-surface"[\s\S]*?className="([^"]+)"/,
    )?.[1];

    expect(homeSurface).toContain('bg-base');
    expect(homeSurface).toContain('justify-center');
    expect(homeSurface).not.toContain('justify-start');
    expect(HOME_SURFACE_SOURCE).not.toContain('radial-gradient');
  });

  it('centers the composer box with related chrome positioned around it', () => {
    // The frame's geometry (anchor, centred group, translated shell, hung
    // heading, measured pull-up) is `ComposerHeroFrame`'s, shared with web and
    // tested there. Home mounts it with its own rhythm and test ids.
    expect(HOME_SURFACE_SOURCE).toContain('<ComposerHeroFrame');
    expect(HOME_SURFACE_SOURCE).toContain(
      'anchorTestId="home-composer-anchor"',
    );
    expect(HOME_SURFACE_SOURCE).toContain('groupTestId="home-composer-group"');
    expect(HOME_SURFACE_SOURCE).toContain('shellTestId="home-composer-shell"');
    expect(HOME_SURFACE_SOURCE).toContain('rhythm="spacious"');

    expect(HOME_SURFACE_SOURCE).toContain('data-testid="home-heading"');
    expect(HOME_SURFACE_SOURCE).toContain('useHomeHeading');
    expect(HOME_SURFACE_SOURCE).toContain('homeHeadingComposerGap()');
    expect(HOME_SURFACE_SOURCE).toContain('homeComposerRef');
    expect(HOME_SURFACE_SOURCE).not.toContain('home-brand-label');
    expect(HOME_SURFACE_SOURCE).not.toContain('home-heading-divider');
    expect(HOME_SURFACE_SOURCE).not.toContain('-translate-y-10');
    // Below-composer sections go in the frame's in-flow `below` slot, not
    // inside the composer, or the frame's gap never applies to them.
    expect(HOME_SURFACE_SOURCE).toMatch(
      /below=\{\s*<>\s*\{belowComposerGallery \? \(/,
    );
  });

  it('keeps the below-composer sections alive while composing', () => {
    // Both halves matter: removing a render gate does nothing while the
    // producing hook still goes inert on a non-empty draft, which is how the
    // chips kept vanishing on the first keystroke.
    expect(HOME_SURFACE_SOURCE).not.toContain('draftIsEmpty');
    expect(HOME_SURFACE_SOURCE).toMatch(/\{suggestedPrompts\.length > 0 && \(/);
  });

  it('does not render a standalone readiness section below the composer', () => {
    expect(HOME_SURFACE_SOURCE).not.toContain('HomeWorkspaceReadiness');
  });

  it('uses shared SuggestionRow actions for Continue recommendations', () => {
    expect(SOURCE).toContain("from '@canopy/ui-shared'");
    expect(SOURCE).toContain('<SuggestionRow');
    expect(SOURCE).toContain('data-testid="home-resume-button"');
    expect(SOURCE).toContain('data-testid="home-interrupted-sessions-resume"');
    expect(SOURCE).toContain('fg-quaternary');
    expect(SOURCE).toContain('Resume {summary.count} interrupted session');
    expect(SOURCE).not.toMatch(/variant="ghost"[\s\S]*?home-resume-button/);
    expect(SOURCE).not.toMatch(
      /variant="ghost"[\s\S]*?home-interrupted-sessions-resume/,
    );
  });

  it('uses only UI Kit elevation on the home surfaces', () => {
    const composerClassName = HOME_SURFACE_SOURCE.match(
      /data-testid="home-composer"[\s\S]*?className="([^"]+)"/,
    )?.[1];

    expect(composerClassName).toContain('bg-tertiary');
    expect(composerClassName).toContain('z-20');
    expect(composerClassName).not.toContain('bg-card');
    expectUnborderedElevation(
      HOME_SURFACE_SOURCE,
      'home-composer',
      'shadow-lg',
    );
  });

  it('renders context switchers in a grey depth overhang above the composer', () => {
    expect(HOME_SURFACE_SOURCE).toMatch(
      /data-testid="home-composer-context-overhang"[\s\S]*?<HomeComposerContextRow[\s\S]*?<\/HomeComposerContextRow>[\s\S]*?data-testid="home-composer"/,
    );
    // The composer box must still not CONTAIN the context row.
    expect(HOME_SURFACE_SOURCE).not.toMatch(
      /data-testid="home-composer"[\s\S]*?<HomeComposerContextRow/,
    );

    const overhangClassName = HOME_SURFACE_SOURCE.match(
      /data-testid="home-composer-context-overhang"[\s\S]*?className="([^"]+)"/,
    )?.[1];
    expect(overhangClassName).toContain('bg-depth');
    expect(overhangClassName).toContain('rounded-t-2xl');
    expect(overhangClassName).toContain('mx-4');
    expect(overhangClassName).toContain('-mb-4');
    expect(overhangClassName).toContain('p-1');
    expect(overhangClassName).toContain('pb-5');
    expect(overhangClassName).toContain('shadow-2xs');
    expect(overhangClassName).toContain('z-10');
    expect(overhangClassName).toContain('pointer-events-auto');
    // The overhang hangs in the frame's out-of-flow `above` slot.
    expect(HOME_SURFACE_SOURCE).toMatch(/above=\{\s*<>/);

    const contextSource = readFileSync(
      join(__dirname, '..', 'HomeComposerContextRow.tsx'),
      'utf-8',
    );
    // The graduated row always keeps its context pickers on one line.
    const contextClassName = contextSource.match(
      /SINGLE_LINE_ROW_CLASS_NAME =\s*"([^"]+)"/,
    )?.[1];
    expect(contextSource).toContain('className={SINGLE_LINE_ROW_CLASS_NAME}');
    expect(contextClassName).toContain('flex-nowrap');
    expect(contextClassName).toContain('gap-0');
    expect(contextClassName).not.toContain('mb-2');
    expect(contextClassName).not.toContain('border');
    expect(contextClassName).not.toContain('bg-');
  });

  it('keeps composer errors inside the elevated composer, not under a resume overhang', () => {
    expect(HOME_SURFACE_SOURCE).toMatch(
      /data-testid="home-composer"[\s\S]*?data-testid="home-composer-error"[\s\S]*?<DraftComposerEditor/,
    );
    expect(HOME_SURFACE_SOURCE).toContain('<Notice');
    expect(HOME_SURFACE_SOURCE).toContain('title="Couldn’t send"');
    expect(HOME_SURFACE_SOURCE).toContain('sendErrorRetryable ?');
    expect(HOME_SURFACE_SOURCE).toContain('data-testid="home-composer-retry"');
  });

  it('renders Continue recommendations as list rows below the composer', () => {
    const resumeCardClassName = SOURCE.match(
      /data-testid="home-resume-card"[\s\S]*?className="([^"]+)"/,
    )?.[1];

    expect(resumeCardClassName).not.toContain('mt-12');
    expect(resumeCardClassName).toContain('gap-3');
    expect(resumeCardClassName).not.toContain('absolute');
    expect(resumeCardClassName).not.toContain('bg-depth');
    expect(resumeCardClassName).not.toContain('rounded-b-2xl');
    expect(resumeCardClassName).not.toContain('shadow-2xs');
    // The startup resume row intentionally has no dismiss control: the offer
    // clears via Resume or by navigating to any workspace/worktree/chat.
    expect(SOURCE).not.toContain('home-resume-dismiss');
    expect(SOURCE).toMatch(
      /resumeDetails\.worktreeName \?\?[\s\S]*?resumeDetails\.chatTitle \?\?[\s\S]*?resumeDetails\.targetName/,
    );
    expect(SOURCE).toContain(
      'worktreeName: worktree.label?.trim() || branchName',
    );
    expect(SOURCE).toMatch(
      /data-testid="home-resume-details"[\s\S]*?<SuggestionRow/,
    );
    expect(SOURCE).toMatch(
      /data-testid="home-interrupted-sessions-banner"[\s\S]*?<SuggestionRow/,
    );
    expect(SOURCE).toContain('text-m font-medium fg-primary');
    // Continue leads the live below-composer stack, ungated by the
    // onboarding checklist, so a returning user's resume row stays directly
    // below the composer (CAN-4746). The gallery branch is a static fixture.
    const liveBelowStack = HOME_SURFACE_SOURCE.slice(
      HOME_SURFACE_SOURCE.indexOf('<HomeBelowComposerGallery />'),
      HOME_SURFACE_SOURCE.indexOf('{pipelineLauncher.ctx &&'),
    );
    const continueAt = liveBelowStack.indexOf('<HomeContinueSection');
    const onboardingHostAt = liveBelowStack.indexOf(
      'ref={setOnboardingHomeHost}',
    );
    const chipsAt = liveBelowStack.indexOf('<SuggestedPromptChips');
    expect(continueAt).toBeGreaterThan(-1);
    expect(onboardingHostAt).toBeGreaterThan(continueAt);
    expect(chipsAt).toBeGreaterThan(onboardingHostAt);
    expect(liveBelowStack).not.toContain('onboardingChecklistShown');
    // HomeContinueSection is the single owner now; the old StartupResumeCard
    // and HomeInterruptedSessionsBanner components are gone, not re-exported.
    expect(HOME_SURFACE_SOURCE).not.toContain('HomeInterruptedSessionsBanner');
    expect(HOME_SURFACE_SOURCE).not.toContain('StartupResumeCard');
    expect(SOURCE).toContain('Continue');
  });
});
