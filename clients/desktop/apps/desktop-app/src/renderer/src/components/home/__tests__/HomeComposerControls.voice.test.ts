/**
 * @jest-environment node
 */
// Source-level coverage keeps this regression test independent of the native
// voice bridge while verifying that pipeline mode does not hide dictation.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'HomeComposerControls.tsx'),
  'utf-8',
);

describe('HomeComposerControls voice availability', () => {
  it('shows voice in both chat and pipeline modes when available', () => {
    expect(SOURCE).toContain('voiceSupported && voiceEnabledPref && (');
    expect(SOURCE).not.toContain(
      'isChatMode && voiceSupported && voiceEnabledPref',
    );
  });

  it('lets the recording row replace the toolbar instead of nesting in it', () => {
    // Nested in the toolbar's flex row, the recording row shrank to its
    // controls and the waveform between them got no width.
    const recording = SOURCE.indexOf('{voiceRecording ? (');
    const row = SOURCE.indexOf('<VoiceRecordingRow', recording);
    const toolbar = SOURCE.indexOf('data-testid="home-composer-toolbar"');
    expect(recording).toBeGreaterThan(-1);
    expect(row).toBeGreaterThan(recording);
    expect(toolbar).toBeGreaterThan(row);
  });

  it('renders a failure surface for the microphone button it shows', () => {
    // A composer that offers dictation must be able to explain a dictation
    // failure; Home shipped the mic button with nowhere for its errors to go.
    expect(SOURCE).toContain('<VoiceDictationErrorModal');
    expect(SOURCE).toContain('guidance={voice.errorGuidance}');
    expect(SOURCE).toContain('onDismiss={voice.dismissError}');
  });

  it('sends from the shared composer send button', () => {
    // Its icon, neutral disabled treatment, and tooltip are pinned by the
    // shared component's rendered tests; Home only wires it.
    const sendButton = SOURCE.match(
      /<ComposerSendButton[^>]*?dataTestId="home-send-button"[^>]*?\/>/,
    )?.[0];

    expect(sendButton).toContain('kind="send"');
    expect(sendButton).toContain('onSend={onSend}');
    expect(sendButton).toContain('disabled={sendDisabled}');
    expect(SOURCE).not.toContain('aria-label="Send"');
  });

  it('keeps the task settings in the box row with the chat composer look', () => {
    // + then the model and effort, then the permission, voice and send; the
    // selectors drop their chevrons and effort opens the panel.
    expect(SOURCE).toContain('data-testid="home-composer-settings"');
    expect(SOURCE).toContain('<ThinkingLevelPanelPicker');
    expect(SOURCE).toContain('hideTriggerChevron');
    // Plan and Pipeline are switched from +; while Plan is on, its tile
    // sits beside + (covered in home-surface.spec.mjs). No mode pill.
    expect(SOURCE).not.toContain('<HomeModePill');
  });

  it('uses 16px app icons for every composer menu action', () => {
    expect(SOURCE).not.toMatch(
      /<(PluginsIcon|SkillIcon|CommandIcon|PlanModeIcon|ScheduleIcon)[^>]*(width|height)=\{14\}/,
    );
    expect(SOURCE).toMatch(/<PluginsIcon width=\{16\} height=\{16\} \/>/);
    expect(SOURCE).toMatch(
      /<PlanModeIcon width=\{16\} height=\{16\} active=\{planMode\} \/>/,
    );
    expect(SOURCE).toMatch(/<ScheduleIcon width=\{16\} height=\{16\} \/>/);
  });

  it('offers Plan mode and Pipeline in the + menu', () => {
    expect(SOURCE).toContain("dataTestId: 'home-plan-mode-button'");
    expect(SOURCE).toContain("dataTestId: 'home-pipeline-mode-button'");
    // The Plan mode suggestion is the composer's tip, which the surface
    // draws in its top drawer; this box hands it the hint.
    expect(SOURCE).toContain('onPlanModeHintChange?.(');
  });
});
