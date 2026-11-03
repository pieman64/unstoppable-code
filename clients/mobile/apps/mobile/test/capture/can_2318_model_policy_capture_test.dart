// Visual-evidence capture for CAN-2318 mobile org model policy in Remote
// Control.
//
// What changed: the model picker sheet now shows each catalog row's
// `description` (since CAN-3917 in the long-press details, not inline), and
// the desktop's projected catalog (which already drops org-policy-blocked
// models) is what mobile shows. The blocked row simply is not offered; Ollama
// stays selectable by design.
//
// Run both stages from `apps/mobile` (the same spec is copied to a clean
// origin/develop worktree for the before stage):
//
//   CAN2318_STAGE=before flutter test test/capture/can_2318_model_policy_capture_test.dart --update-goldens
//   CAN2318_STAGE=after  flutter test test/capture/can_2318_model_policy_capture_test.dart --update-goldens
//
// Captures are deterministic: the in-repo fake repository supplies a fixed
// snapshot with zero latency; no live desktop, agents, or network are
// involved. Output is written to the gitignored `<repo>/.playwright/can-2318/`
// directory.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';

import '../support/fake_remote_control_repository.dart';

final String? _requestedStage = Platform.environment['CAN2318_STAGE'];
final String _stage = switch (_requestedStage) {
  null => 'after',
  'before' => 'before',
  'after' => 'after',
  final value => throw ArgumentError.value(
    value,
    'CAN2318_STAGE',
    'must be either "before" or "after"',
  ),
};

String _capture(String name) =>
    '../../../../.playwright/can-2318/$name-$_stage.png';

Future<void> _loadRealFont() async {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Verdana.ttf',
    '/Library/Fonts/Arial.ttf',
  ];
  for (final path in candidates) {
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    for (final family in ['Roboto', '.SF UI Text', '.SF UI Display']) {
      final loader = FontLoader(family)..addFont(Future.value(bytes));
      await loader.load();
    }
    return;
  }
}

Future<void> _loadMaterialIcons() async {
  final candidates = <String>[
    if (Platform.environment['FLUTTER_ROOT'] case final root?)
      '$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    for (final launcher in [
      '/opt/homebrew/bin/flutter',
      '/usr/local/bin/flutter',
    ])
      if (File(launcher).existsSync())
        '${File(launcher).resolveSymbolicLinksSync().replaceFirst(RegExp(r'/flutter$'), '')}/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
  ];
  for (final path in candidates) {
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader('MaterialIcons')..addFont(Future.value(bytes))).load();
    return;
  }
}

/// The full projected catalog an org with no model policy would see.
final _unfilteredCatalog = [
  ModelOption.fromJson({
    'id': 'claude-sonnet',
    'label': 'Claude Sonnet 4.5',
    'provider': 'claude',
    'kind': 'model',
    'available': true,
    'description': 'Balanced speed and capability for everyday work.',
  }),
  ModelOption.fromJson({
    'id': 'claude-opus',
    'label': 'Claude Opus 4.1',
    'provider': 'claude',
    'kind': 'model',
    'available': true,
    'description': 'Deepest reasoning for hard, multi-step problems.',
  }),
  ModelOption.fromJson({
    'id': 'gpt-5-codex',
    'label': 'GPT-5 Codex',
    'provider': 'codex',
    'kind': 'model',
    'available': true,
    'description': 'Codex-tuned model for large refactors.',
  }),
  ModelOption.fromJson({
    'id': 'ollama:llama3',
    'label': 'Llama 3',
    'provider': 'ollama',
    'kind': 'model',
    'available': true,
    'description': 'Runs locally; never leaves this machine.',
  }),
];

/// What the desktop projects once the org blocks Opus and Codex. Ollama is
/// exempt from the policy by design and survives the filter.
final _filteredCatalog = [
  ModelOption.fromJson({
    'id': 'claude-sonnet',
    'label': 'Claude Sonnet 4.5',
    'provider': 'claude',
    'kind': 'model',
    'available': true,
    'description': 'Balanced speed and capability for everyday work.',
  }),
  ModelOption.fromJson({
    'id': 'ollama:llama3',
    'label': 'Llama 3',
    'provider': 'ollama',
    'kind': 'model',
    'available': true,
    'description': 'Runs locally; never leaves this machine.',
  }),
];

RemoteSessionSnapshot _snapshot(List<ModelOption> catalog) =>
    RemoteSessionSnapshot(
      workspaces: const [
        RemoteWorkspace(
          localId: 'ws-1',
          name: 'acme-web',
          type: RemoteWorkspaceType.singleRepo,
          rootPath: '~/code/acme-web',
        ),
      ],
      worktrees: const [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'feature/oauth',
        ),
      ],
      standaloneChats: const [],
      chatSummaries: [
        RemoteChatSummary(
          chatId: 'chat-1',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'OAuth work',
          active: true,
          providerType: 'claude',
          model: 'claude-sonnet',
          modelLabel: 'Claude Sonnet 4.5',
          planMode: false,
          thinkingLevel: 'off',
          fastMode: false,
          providerAvailability: const ProviderAvailability(
            claude: true,
            codex: true,
          ),
          availableModels: catalog,
          modelCatalogProjected: catalog.isNotEmpty,
        ),
      ],
      chatMessages: const [
        RemoteChatMessage(
          messageId: 'm-1',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Wired the callback route and added a test.',
        ),
      ],
    );

Future<void> _pumpModelPicker(
  WidgetTester tester,
  List<ModelOption> catalog,
) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  final repository = FakeRemoteControlRepository();
  repository.snapshotBuilder = () => _snapshot(catalog);
  final viewModel = RemoteControlViewModel(
    repository: repository,
    stateRefreshDebounce: Duration.zero,
  );
  await tester.runAsync(() => viewModel.connect('123456'));
  final worktree = viewModel.worktreesFor('ws-1').single;

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        // `create` (not `.value`) so the widget tree owns disposal: tearing
        // the tree down disposes the view model, cancelling its hydration
        // watchdog timers before the pending-timer invariant runs. An
        // `addTearDown` dispose runs too late and the test fails with
        // pending timers.
        ChangeNotifierProvider<RemoteControlViewModel>(
          create: (_) => viewModel,
        ),
        ChangeNotifierProvider<TurnFeedbackController>(
          create: (_) =>
              TurnFeedbackController(repository: MockTurnFeedbackRepository()),
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: ThemeMode.dark,
        home: RemoteChatScreen.worktree(worktree: worktree),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));

  await tester.tap(find.byKey(const ValueKey('composer-model')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

Future<void> _captureSurface(String name) async {
  final surface = find.byType(MaterialApp);
  expect(surface, findsOneWidget);
  if (_requestedStage == null) return;
  // No explicit directory creation: `--update-goldens` creates the parent
  // directories itself, and `matchesGoldenFile` resolves its path against the
  // *test file's* directory while a bare `Directory(...)` resolves against the
  // process CWD — the two only agree when the run starts from `apps/mobile`.
  await expectLater(surface, matchesGoldenFile(_capture(name)));
}

void main() {
  group('CAN-2318 model policy captures', () {
    setUpAll(() async {
      TestWidgetsFlutterBinding.ensureInitialized();
      await _loadRealFont();
      await _loadMaterialIcons();
    });

    testWidgets('picker with no org policy shows the full catalog', (
      tester,
    ) async {
      await _pumpModelPicker(tester, _unfilteredCatalog);

      expect(
        find.byKey(const ValueKey('model-option-claude-opus')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('model-option-gpt-5-codex')),
        findsOneWidget,
      );
      await _captureSurface('model-picker-unfiltered');
    });

    testWidgets('picker with an org policy omits the blocked rows', (
      tester,
    ) async {
      await _pumpModelPicker(tester, _filteredCatalog);

      // Blocked models never reach mobile: the desktop projection dropped
      // them before the snapshot was built.
      expect(
        find.byKey(const ValueKey('model-option-claude-opus')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('model-option-gpt-5-codex')),
        findsNothing,
      );
      // Ollama is exempt from the policy and stays selectable.
      expect(
        find.byKey(const ValueKey('model-option-ollama:llama3')),
        findsOneWidget,
      );
      await _captureSurface('model-picker-filtered');
    });

    testWidgets('rows show their catalog descriptions', (tester) async {
      await _pumpModelPicker(tester, _unfilteredCatalog);

      if (_stage == 'after') {
        // Rows stay compact; the description is in the long-press details.
        const row = ValueKey('model-option-claude-sonnet');
        const description = 'Balanced speed and capability for everyday work.';
        expect(find.text(description), findsNothing);
        await tester.longPress(find.byKey(row));
        await tester.pumpAndSettle();
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('model-details-claude-sonnet')),
            matching: find.text(description),
          ),
          findsOneWidget,
        );
      } else {
        // Before this change the description was parsed away and never shown.
        expect(
          find.text('Balanced speed and capability for everyday work.'),
          findsNothing,
        );
      }
      await _captureSurface('model-picker-descriptions');
    });
  });
}
