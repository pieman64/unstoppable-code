// Visual-evidence capture for App Advisor over Remote Control (CAN-3989).
//
// What changed: the side menu gains an Advisor destination directly above
// Remote control. It lists the paired desktop's Advisor chats, opens one
// chat, and shows an update prompt for desktops without Advisor support. The
// Advisor screens are new, so only the side menu has a "before": the same
// drawer without the Advisor row.
//
// Run from `apps/mobile`:
//
//   CAN_3989_CAPTURE=1 flutter test test/capture/can_3989_app_advisor_capture_test.dart --update-goldens
//
// Output: <repo>/.playwright/can-3989-mobile-app-advisor/*.png (gitignored).

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_app_advisor.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/views/widgets/home_navigation_drawer.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_app_advisor_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_app_advisor_screen.dart';
import 'package:provider/provider.dart';

import '../support/fake_remote_control_repository.dart';
import '../support/reduced_motion.dart';

final bool _capturing = Platform.environment['CAN_3989_CAPTURE'] == '1';
const String _captureRoot =
    '../../../../.playwright/can-3989-mobile-app-advisor';

/// The app's own fonts, so captures show real glyphs instead of test boxes.
Future<void> _loadAppFonts() async {
  await (FontLoader(
    'Inter',
  )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
  await (FontLoader(
    'MaterialIcons',
  )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
}

Map<String, dynamic> _chat(
  String chatId, {
  required String workEntryId,
  required int workEntryOrder,
  String? workEntryTitle,
  String? title,
  int order = 0,
  bool? active,
  bool? turnActive,
  List<Map<String, dynamic>>? pendingQuestions,
  String? model,
  String? modelLabel,
}) => {
  'chatId': chatId,
  'title': title ?? 'Chat',
  'workEntryId': workEntryId,
  'workEntryTitle': ?workEntryTitle,
  'workEntryOrder': workEntryOrder,
  'order': order,
  'active': ?active,
  'turnActive': ?turnActive,
  'pendingQuestions': ?pendingQuestions,
  'model': ?model,
  'modelLabel': ?modelLabel,
  'providerType': 'claude',
  'availableModels': [
    for (final (id, label) in [
      ('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
      ('claude-opus-5-5', 'Claude Opus 5.5'),
    ])
      {
        'id': id,
        'label': label,
        'provider': 'claude',
        'vendor': 'anthropic',
        'available': true,
        'isDefault': id == 'claude-sonnet-5-5',
      },
  ],
};

RemoteChatMessage _message(
  String messageId,
  String role,
  String text, {
  String status = 'complete',
  int createdAtMs = 0,
}) => RemoteChatMessage.fromWireJson({
  'messageId': messageId,
  'chatId': 'c1',
  'role': role,
  'status': status,
  'text': text,
  'createdAtMs': 1792300000000 + createdAtMs,
});

final _snapshot = RemoteAppAdvisorSnapshotEvent(
  chats: [
    for (final chat in [
      _chat(
        'c1',
        workEntryId: 'e1',
        workEntryOrder: 0,
        workEntryTitle: 'Why is the release build slow?',
        title: 'Build timing',
        active: true,
        turnActive: true,
        model: 'claude-sonnet-5-5',
        modelLabel: 'Claude Sonnet 5.5',
        pendingQuestions: [
          {
            'requestId': 'q1',
            'questions': [
              {
                'header': 'Scope',
                'question': 'Which build should I profile?',
                'options': ['macOS release', 'Windows release'],
              },
            ],
          },
        ],
      ),
      _chat('c2', workEntryId: 'e1', workEntryOrder: 0, order: 1),
      _chat(
        'c3',
        workEntryId: 'e2',
        workEntryOrder: 1,
        workEntryTitle: 'Set up a nightly pipeline',
      ),
      _chat(
        'c4',
        workEntryId: 'e3',
        workEntryOrder: 2,
        workEntryTitle: 'Explain the sidebar groups setting',
      ),
    ])
      RemoteAppAdvisorChat.fromJson(chat),
  ],
  chatMessages: [
    _message('u1', 'user', 'Why did the last release build take 40 minutes?'),
    _message(
      'a1',
      'assistant',
      'The notarization step waited on Apple for 31 minutes. Compiling and '
          'signing took 9 minutes, which matches the previous builds.',
      createdAtMs: 1000,
    ),
    _message('u2', 'user', 'Can you profile it to be sure?', createdAtMs: 2000),
    _message(
      'a2',
      'assistant',
      'I can. Tell me which build to profile.',
      status: 'streaming',
      createdAtMs: 3000,
    ),
  ],
);

void main() {
  useReducedMotion();

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadAppFonts();
  });

  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    final theme = mode.name;

    Future<FakeRemoteControlRepository> pump(
      WidgetTester tester,
      Widget screen, {
      bool supportsAppAdvisor = true,
      bool seed = true,
    }) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final repository = FakeRemoteControlRepository()
        ..supportsAppAdvisor = supportsAppAdvisor
        ..connectedStatus = RemotePortalConnectionStatus.active
        ..appAdvisorSettings = {
          'model': 'claude-sonnet-5-5',
          'availableModels': _snapshot.chats.first.summary.availableModels
              .map(
                (model) => {
                  'id': model.id,
                  'label': model.label,
                  'provider': model.provider,
                  'vendor': model.vendor,
                  'available': true,
                },
              )
              .toList(),
        };
      final viewModel = RemoteControlViewModel(repository: repository);
      addTearDown(viewModel.dispose);
      await tester.runAsync(() => viewModel.connect('123456'));
      await tester.pumpWidget(
        ChangeNotifierProvider<RemoteControlViewModel>.value(
          value: viewModel,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            themeMode: mode,
            home: screen,
          ),
        ),
      );
      await tester.pump();
      if (seed) {
        repository.eventsController.add(
          RemotePortalEventBatch(events: [_snapshot], nextCursor: 1),
        );
      }
      await tester.pumpAndSettle();
      return repository;
    }

    Future<void> capture(
      WidgetTester tester,
      String name, {
      String stage = 'after',
    }) async {
      expect(tester.takeException(), isNull);
      if (!_capturing) return;
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('$_captureRoot/$name-mobile-$stage-$theme.png'),
      );
    }

    for (final stage in ['before', 'after']) {
      testWidgets('side menu $stage ($theme)', (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            themeMode: mode,
            home: HomeNavigationDrawer(
              tabs: [
                for (final tab in organizationHomeTabs)
                  if (stage == 'after' || tab != HomeTab.advisor) tab,
              ],
              selectedTab: stage == 'after' ? HomeTab.advisor : HomeTab.remote,
              onSelected: (_) {},
              onNewChat: () {},
              onOpenSettings: () {},
            ),
          ),
        );
        await tester.pumpAndSettle();
        await capture(tester, 'side-menu', stage: stage);
      });
    }

    testWidgets('Advisor list ($theme)', (tester) async {
      await pump(tester, const RemoteAppAdvisorScreen());
      expect(find.text('Why is the release build slow?'), findsOneWidget);
      await capture(tester, 'list');
    });

    testWidgets('Advisor chat with a question ($theme)', (tester) async {
      await pump(tester, const RemoteAppAdvisorChatScreen(chatId: 'c1'));
      expect(find.text('Which build should I profile?'), findsOneWidget);
      await capture(tester, 'chat');
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('model-option-claude-opus-5-5')),
        findsOneWidget,
      );
      await capture(tester, 'model-picker');
    });

    testWidgets('new Advisor chat ($theme)', (tester) async {
      await pump(tester, const RemoteAppAdvisorChatScreen(), seed: false);
      expect(find.text('Claude Sonnet 5.5'), findsOneWidget);
      await capture(tester, 'new-chat');
    });

    testWidgets('Advisor update prompt ($theme)', (tester) async {
      await pump(
        tester,
        const RemoteAppAdvisorScreen(),
        supportsAppAdvisor: false,
        seed: false,
      );
      expect(find.byType(AppAdvisorUpdatePrompt), findsOneWidget);
      await capture(tester, 'update-prompt');
    });
  }
}
