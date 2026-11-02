import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORCHESTRATOR_LABEL, REMOTE_CONTROL_LABEL } from '../ui-labels';

/**
 * The Flutter pairing screen tells users which desktop controls reveal the
 * 6-digit code, naming the account menu entry and the enable button. It cannot
 * import {@link REMOTE_CONTROL_LABEL} across the TS/Dart boundary, so it
 * hardcodes both strings.
 *
 * `ui-labels.ts` promises a rename touches one line. Without this test that
 * promise is a comment: renaming the label would leave the mobile screen
 * pointing at controls that no longer exist, and nothing would fail.
 */
const MOBILE_LIB = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'mobile',
  'lib',
);

const MOBILE_DIR = join(MOBILE_LIB, 'ui', 'features', 'remote', 'views');

const MOBILE_PAIRING_VIEW = join(
  MOBILE_DIR,
  'widgets',
  'connect_desktop_view.dart',
);
const MOBILE_REMOTE_SCREEN = join(MOBILE_DIR, 'remote_screen.dart');
const MOBILE_REPOSITORY = join(
  MOBILE_LIB,
  'data',
  'repositories',
  'remote_control_repository.dart',
);

function readMobileSource(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Could not read the mobile source at ${path}. ` +
        'If it moved, update this path — the point of this test is that the ' +
        'Dart copy cannot import REMOTE_CONTROL_LABEL and must be kept in ' +
        'step by hand.',
    );
  }
}

describe('REMOTE_CONTROL_LABEL mobile mirror', () => {
  const pairingView = readMobileSource(MOBILE_PAIRING_VIEW);
  const remoteScreen = readMobileSource(MOBILE_REMOTE_SCREEN);
  const repository = readMobileSource(MOBILE_REPOSITORY);

  it('names the desktop account menu entry the label currently uses', () => {
    expect(pairingView).toContain(
      `Click ${REMOTE_CONTROL_LABEL} in the account menu`,
    );
  });

  it('titles the disconnected Remote tab with the current label', () => {
    // Anchored to the disconnected branch's complete Text widget. The
    // connected branch now renders the paired device name and status, so a
    // bare substring match could pass against unrelated copy while this title
    // went stale.
    expect(remoteScreen).toContain(`: const Text('${REMOTE_CONTROL_LABEL}')`);
  });

  it('names the enable button the label currently builds', () => {
    // Mirrors ENABLE_BUTTON in CanopyPortalModal.tsx, which is
    // `Enable ${REMOTE_CONTROL_LABEL}`.
    expect(pairingView).toContain(`Click Enable ${REMOTE_CONTROL_LABEL}`);
  });

  it('matches the rejection the commands route composes', () => {
    // Unlike the three copy mirrors above, this one is behavioral. The
    // commands route answers a non-ACTIVE session with
    // `Active ${REMOTE_CONTROL_LABEL.toLowerCase()} session not found`, and
    // `isRemoteSessionUnavailableError` compares against exactly that string
    // to decide whether to re-probe a pairing it may then end. A rename would
    // silently disable orphan detection with a fully green mobile suite.
    expect(repository).toContain(
      `'active ${REMOTE_CONTROL_LABEL.toLowerCase()} session not found'`,
    );
  });
});

describe('ORCHESTRATOR_LABEL mobile mirror', () => {
  // Each Dart site hard-codes the label because it cannot import it. Anchored
  // to the full expression so unrelated copy cannot satisfy the match.
  it.each([
    [
      [
        'ui',
        'features',
        'home',
        'views',
        'widgets',
        'home_navigation_drawer.dart',
      ],
      `HomeTab.advisor => '${ORCHESTRATOR_LABEL}'`,
    ],
    [
      ['ui', 'features', 'remote', 'views', 'remote_app_advisor_screen.dart'],
      `content: const Text('${ORCHESTRATOR_LABEL}')`,
    ],
    [
      [
        'ui',
        'features',
        'remote',
        'views',
        'remote_app_advisor_chat_screen.dart',
      ],
      `(chatId == null ? 'New chat' : '${ORCHESTRATOR_LABEL}')`,
    ],
    [
      [
        'ui',
        'features',
        'remote',
        'views',
        'remote_app_advisor_chat_screen.dart',
      ],
      `hintText: 'Message ${ORCHESTRATOR_LABEL}…'`,
    ],
    [
      ['ui', 'core', 'chat', 'view_models', 'tool_call_display.dart'],
      `'app-advisor' => '${ORCHESTRATOR_LABEL}'`,
    ],
    [
      // Lowercased like its sibling chips, matching CollapsedTurnSummary.
      ['ui', 'core', 'chat', 'view_models', 'turn_grouping.dart'],
      `appAdvisor('${ORCHESTRATOR_LABEL.toLowerCase()}')`,
    ],
    [
      ['ui', 'features', 'stats', 'stats_aggregation.dart'],
      `'APP_ADVISOR': '${ORCHESTRATOR_LABEL}'`,
    ],
    [
      [
        'ui',
        'features',
        'remote',
        'view_models',
        'app_advisor_controller.dart',
      ],
      `"Couldn't load ${ORCHESTRATOR_LABEL} chats from the desktop. Try again."`,
    ],
    [
      ['data', 'repositories', 'remote_app_advisor_commands.dart'],
      `'Update the desktop app to use ${ORCHESTRATOR_LABEL} here.'`,
    ],
  ])('%j says the current label', (segments, snippet) => {
    expect(readMobileSource(join(MOBILE_LIB, ...segments))).toContain(snippet);
  });
});
