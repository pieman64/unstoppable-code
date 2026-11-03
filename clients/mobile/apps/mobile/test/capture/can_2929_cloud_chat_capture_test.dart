// CAN-2929 / CAN-3143: visual evidence for the mobile cloud chat surfaces.
// @capture-keep: Retains deterministic mobile cloud-chat visual evidence.
// @capture-reference: .playwright/can-2929/report.md
//
// What changed: an interim "Cloud chats" entry in the navigation drawer, a
// workspaces/chats list screen, and a chat screen composed from the shared
// chat stack (transcript, composer with cloud model catalog, ask-user card,
// Stop, in-place continuation through the composer, and inline error banners).
// The empty Cloud state and review recovery states are retained as CAN-3143
// references.
//
// Run both stages from `apps/mobile`:
//
//   CAN2929_CAPTURE=1 CAN2929_STAGE=before flutter test --no-pub test/capture/can_2929_cloud_chat_capture_test.dart --update-goldens
//   CAN2929_CAPTURE=1 CAN2929_STAGE=after  flutter test --no-pub test/capture/can_2929_cloud_chat_capture_test.dart --update-goldens
//
// The list and chat screens are new, so only the drawer has a "before": that
// stage renders the tab set with the Cloud entry hidden, exactly what the
// shell shows when the server reports cloud agents unavailable. Both color
// modes use bundled fonts, the in-memory fake repository, and fixed frames;
// no live account, agent, or network is involved. Output goes to the
// gitignored `<repo>/.playwright/can-2929/` directory.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/main.dart'
    show
        buildNoOrganizationShellProviders,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chats_screen.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:provider/provider.dart';

import '../support/cloud_chat_providers.dart';
import '../support/fake_cloud_chat_repository.dart';
import '../support/settings_root_providers.dart';

final bool _enabled = Platform.environment['CAN2929_CAPTURE'] == '1';
final String _stage = Platform.environment['CAN2929_STAGE'] == 'before'
    ? 'before'
    : 'after';

String _path(String name, bool dark) =>
    '../../../../.playwright/can-2929/$name-$_stage-${dark ? 'dark' : 'light'}.png';

/// Two days before the run, so the row reads "Created 2d ago" on any day.
final int _createdAtMs = DateTime.now()
    .subtract(const Duration(days: 2))
    .millisecondsSinceEpoch;

CloudCoreMessage _message(
  String id, {
  required String role,
  required String text,
  String? sourceKey,
  List<Map<String, dynamic>> contentBlocks = const [],
  int offsetMs = 0,
}) => CloudCoreMessage(
  id: id,
  role: role,
  text: text,
  sourceKey: sourceKey,
  clientRequestId: role == 'USER' ? 'request-$id' : null,
  contentBlocks: contentBlocks,
  cost: const CloudCoreCost(kind: CloudCoreCostKind.zero),
  costBilledViaLlmProxy: false,
  createdAtMs: _createdAtMs + offsetMs,
  artifacts: const [],
);

CloudChatBootstrap _conversation({CloudTerminalSession? terminal}) =>
    CloudChatBootstrap(
      messages: [
        _message(
          'u1',
          role: 'USER',
          text: 'Draft the launch checklist for the mobile beta.',
        ),
        _message(
          'a1',
          role: 'ASSISTANT',
          sourceKey: 'turn-1',
          offsetMs: 1000,
          text:
              'Here is a first pass:\n\n'
              '1. Freeze the feature list and cut the release branch.\n'
              '2. Run the store review checklist for iOS and Android.\n'
              '3. Line up support macros and the status page entry.\n\n'
              'Want me to turn this into tasks in the workspace?',
        ),
      ],
      toolActivity: const [],
      terminalSession: terminal,
    );

CloudChatBootstrap _askUser() => CloudChatBootstrap(
  messages: [
    _message('u1', role: 'USER', text: 'Set up the beta rollout.'),
    _message(
      'a1',
      role: 'ASSISTANT',
      sourceKey: 'turn-1',
      offsetMs: 1000,
      text: '',
      contentBlocks: const [
        {
          'type': 'tool_call',
          'toolCallId': 'q1',
          'toolName': 'AskUserQuestion',
        },
      ],
    ),
  ],
  toolActivity: [
    CloudChatToolActivity(
      kind: CloudToolActivityKind.call,
      rawKind: 'call',
      sourceKey: 'turn-1',
      toolCallId: 'q1',
      toolName: 'AskUserQuestion',
      input: jsonEncode({
        'questions': [
          {
            'question': 'Which platform ships first?',
            'header': 'Rollout',
            'options': ['iOS', 'Android', 'Both at once'],
            'multiSelect': false,
          },
        ],
      }),
      raw: const {},
    ),
  ],
);

FakeCloudChatRepository _repository() => FakeCloudChatRepository(
  workspaces: [
    sampleWorkspace(
      id: 'ws-mobile',
      name: 'Mobile App',
      chats: [
        sampleChat(
          id: 'chat-launch',
          title: 'Launch checklist',
          createdAtMs: _createdAtMs,
        ),
        sampleChat(
          id: 'chat-crash',
          title: 'Investigate the sign-in crash on Android 14',
          createdAtMs: _createdAtMs,
        ),
      ],
    ),
    sampleWorkspace(
      id: 'ws-web',
      name: 'Website',
      chats: [
        sampleChat(id: 'chat-seo', title: null, createdAtMs: _createdAtMs),
      ],
    ),
  ],
);

void main() {
  setUpAll(() async {
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    Directory('../../.playwright/can-2929').createSync(recursive: true);
  });

  void phone(WidgetTester tester) {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  for (final dark in [false, true]) {
    final mode = dark ? ThemeMode.dark : ThemeMode.light;

    testWidgets('drawer ${dark ? 'dark' : 'light'}', (tester) async {
      phone(tester);
      AppConfig.configureEnvironmentController(
        ApiEnvironmentController(
          productionBaseUrl: '',
          stagingBaseUrl: '',
          initialEnvironment: ApiEnvironment.production,
          preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
        ),
      );
      // "before" is the pre-feature drawer: the same list the shell shows
      // when the server reports cloud agents unavailable.
      final tabs = visibleHomeTabs(
        noOrganizationHomeTabs,
        cloudAvailable: _stage == 'before' ? false : true,
      );
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ...settingsRootTestProviders(),
            ChangeNotifierProvider<AuthViewModel>(
              create: (_) => AuthViewModel(
                repository: MockAuthRepository(latency: Duration.zero),
              ),
            ),
            ...cloudChatTestProviders(repository: _repository()),
            ...buildSharedShellProviders(),
            ...buildNoOrganizationShellProviders(),
          ],
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            themeMode: mode,
            home: HomeTabControllerProvider(
              tabs: tabs,
              initialTab: noOrganizationLandingTab,
              child: HomeShell(
                refreshActivity: refreshActivityFeed,
                activityAccount: watchActivityAccount,

                membersTab: membersTabForShellMode(
                  AuthenticatedShellMode.noOrganization,
                  hasTeams: false,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('home-nav-cloud')),
        _stage == 'before' ? findsNothing : findsOneWidget,
      );
      await expectLater(
        find.byType(HomeShell),
        matchesGoldenFile(_path('drawer', dark)),
      );
      expect(tester.takeException(), isNull);
    }, skip: !_enabled);

    testWidgets('chats list ${dark ? 'dark' : 'light'}', (tester) async {
      phone(tester);
      final repository = _repository()
        ..bootstraps['chat-crash'] = const CloudChatBootstrap(
          messages: [],
          toolActivity: [],
          activeTurnId: 'turn-live',
          activeUserMessageId: 'u-live',
          activeStreamAfter: '9',
        );
      final list = CloudChatsViewModel(repository: repository);
      final streams = <StreamController<CloudSseFrame>>[];
      final session = CloudChatViewModel(
        repository: repository,
        openStream: (_, {after}) {
          final controller = StreamController<CloudSseFrame>();
          streams.add(controller);
          return controller.stream;
        },
        observeLifecycle: false,
      );
      addTearDown(() async {
        session.dispose();
        list.dispose();
        for (final stream in streams) {
          await stream.close();
        }
      });
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
            ChangeNotifierProvider<CloudChatViewModel>.value(value: session),
          ],
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            themeMode: mode,
            home: const CloudChatsScreen(),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      // One chat is mid-turn on this device: it carries the working spinner.
      session.open('chat-crash', cursorEpoch: 'session-chat-crash');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        find.byKey(const ValueKey('cloud-chat-working-chat-crash')),
        findsOneWidget,
      );
      await expectLater(
        find.byType(CloudChatsScreen),
        matchesGoldenFile(_path('chats-list', dark)),
      );
      expect(tester.takeException(), isNull);
    }, skip: !_enabled || _stage == 'before');

    testWidgets(
      'new chat draft ${dark ? 'dark' : 'light'}',
      (tester) async {
        phone(tester);
        final repository = _repository();
        final list = CloudChatsViewModel(repository: repository);
        final session = CloudChatViewModel(
          repository: repository,
          openStream: (_, {after}) => const Stream<CloudSseFrame>.empty(),
          observeLifecycle: false,
        );
        addTearDown(() {
          session.dispose();
          list.dispose();
        });
        await list.load();
        await list.ensureModels();
        await tester.pumpWidget(
          MultiProvider(
            providers: [
              ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
              ChangeNotifierProvider<CloudChatViewModel>.value(value: session),
            ],
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              themeMode: mode,
              home: const CloudChatScreen.create(),
            ),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(repository.createCalls, isEmpty);
        await expectLater(
          find.byType(CloudChatScreen),
          matchesGoldenFile(_path('new-chat-draft', dark)),
        );
        expect(tester.takeException(), isNull);
      },
      skip: !_enabled || _stage == 'before',
    );

    testWidgets(
      'queued switch blocked ${dark ? 'dark' : 'light'}',
      (tester) async {
        phone(tester);
        final repository = _repository()
          ..bootstraps['chat-launch'] = const CloudChatBootstrap(
            messages: [],
            toolActivity: [],
            activeTurnId: 'turn-live',
            activeUserMessageId: 'u-live',
            activeStreamAfter: '9',
          );
        final list = CloudChatsViewModel(repository: repository);
        final session = CloudChatViewModel(
          repository: repository,
          openStream: (_, {after}) => const Stream.empty(),
          observeLifecycle: false,
        );
        addTearDown(() {
          session.dispose();
          list.dispose();
        });
        await tester.pumpWidget(
          MultiProvider(
            providers: [
              ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
              ChangeNotifierProvider<CloudChatViewModel>.value(value: session),
            ],
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              themeMode: mode,
              home: const CloudChatsScreen(),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        session.open('chat-launch', cursorEpoch: 'session-chat-launch');
        await tester.pump();
        await tester.pump();
        session.send(
          clientRequestId: 'queued-follow-up',
          payload: const CloudSendPayload(
            text: 'Add the QA sign-off step too.',
          ),
        );
        await tester.tap(
          find.byKey(const ValueKey('cloud-chat-row-chat-crash')),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(
          find.text(
            'Wait for the queued message to send before opening another chat.',
          ),
          findsOneWidget,
        );
        await expectLater(
          find.byType(View),
          matchesGoldenFile(_path('queued-switch-blocked', dark)),
        );
        session.setForeground(false);
        expect(tester.takeException(), isNull);
      },
      skip: !_enabled || _stage == 'before',
    );

    testWidgets('chats empty ${dark ? 'dark' : 'light'}', (tester) async {
      phone(tester);
      final repository = FakeCloudChatRepository();
      final list = CloudChatsViewModel(repository: repository);
      final session = CloudChatViewModel(
        repository: repository,
        openStream: (_, {after}) => const Stream.empty(),
        observeLifecycle: false,
      );
      addTearDown(() {
        session.dispose();
        list.dispose();
      });
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
            ChangeNotifierProvider<CloudChatViewModel>.value(value: session),
          ],
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            themeMode: mode,
            home: const CloudChatsScreen(),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const ValueKey('cloud-chats-empty')), findsOneWidget);
      await expectLater(
        find.byType(CloudChatsScreen),
        matchesGoldenFile(_path('chats-empty', dark)),
      );
      expect(tester.takeException(), isNull);
    }, skip: !_enabled || _stage == 'before');

    for (final scenario in const [
      'transcript',
      'ask-user',
      'terminal',
      'send-error',
      'bootstrap-error',
      'model-selection',
    ]) {
      testWidgets(
        'chat $scenario ${dark ? 'dark' : 'light'}',
        (tester) async {
          phone(tester);
          final repository = _repository();
          repository.bootstraps['chat-launch'] = switch (scenario) {
            'ask-user' => _askUser(),
            'terminal' => _conversation(
              terminal: const CloudTerminalSession(
                status: 'completed',
                sourceAgentSessionId: 'session-chat-launch',
              ),
            ),
            'bootstrap-error' => const CloudChatBootstrap(
              messages: [],
              toolActivity: [],
              activeTurnId: 'turn-live',
              activeUserMessageId: 'u-live',
              activeStreamAfter: '9',
            ),
            _ => _conversation(),
          };
          if (scenario == 'send-error') {
            repository.postError = const CloudSendError(
              kind: CloudSendErrorKind.definitive,
              status: 402,
              message:
                  'You have run out of credits. Add credits to keep chatting.',
            );
          }
          final modelSelection = scenario == 'model-selection'
              ? Completer<void>()
              : null;
          if (modelSelection != null) {
            repository.setModelCompleters['claude-opus-5'] = modelSelection;
          }
          final list = CloudChatsViewModel(repository: repository);
          final streams = <StreamController<CloudSseFrame>>[];
          final session = CloudChatViewModel(
            repository: repository,
            openStream: (_, {after}) {
              final controller = StreamController<CloudSseFrame>();
              streams.add(controller);
              return controller.stream;
            },
            observeLifecycle: false,
          );
          addTearDown(() async {
            if (modelSelection != null && !modelSelection.isCompleted) {
              modelSelection.complete();
            }
            session.dispose();
            list.dispose();
            for (final stream in streams) {
              await stream.close();
            }
          });
          await list.load();
          await list.ensureModels();
          await tester.pumpWidget(
            MultiProvider(
              providers: [
                ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
                ChangeNotifierProvider<CloudChatViewModel>.value(
                  value: session,
                ),
              ],
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: AppTheme.light,
                darkTheme: AppTheme.dark,
                themeMode: mode,
                home: const CloudChatScreen(chatId: 'chat-launch'),
              ),
            ),
          );
          await tester.pump();
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
          if (scenario == 'send-error') {
            await tester.enterText(
              find.byKey(const ValueKey('composer-draft')),
              'Add the QA sign-off step too.',
            );
            await tester.pump();
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            await tester.pump();
            await tester.pump();
            // CAN-3556: the failure shows on its row, not in a banner.
            expect(find.text('Not sent'), findsOneWidget);
          }
          if (scenario == 'bootstrap-error') {
            repository.bootstrapErrors['chat-launch'] = const CloudApiException(
              statusCode: 500,
              message: 'Cloud request failed. Try again.',
            );
            await session.refresh();
            await tester.pump();
            expect(
              find.byKey(const ValueKey('cloud-bootstrap-error')),
              findsOneWidget,
            );
          }
          if (scenario == 'model-selection') {
            await tester.tap(find.byKey(const ValueKey('composer-model')));
            await tester.pumpAndSettle();
            await tester.tap(
              find.byKey(const ValueKey('model-option-claude-opus-5')),
            );
            await tester.pumpAndSettle();
            expect(find.text('Opus 5'), findsOneWidget);
            expect(repository.setModelCalls.single.model, 'claude-opus-5');
          }
          await tester.pump(const Duration(milliseconds: 300));
          await expectLater(
            find.byType(CloudChatScreen),
            matchesGoldenFile(_path('chat-$scenario', dark)),
          );
          if (scenario == 'bootstrap-error') session.setForeground(false);
          expect(tester.takeException(), isNull);
        },
        skip: !_enabled || _stage == 'before',
      );
    }
  }
}
