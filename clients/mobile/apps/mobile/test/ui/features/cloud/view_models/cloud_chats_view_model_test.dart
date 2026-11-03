import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';

import '../../../../support/fake_cloud_chat_repository.dart';

void main() {
  group('CloudChatsViewModel', () {
    test('load publishes workspaces and marks cloud available', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace()],
      );
      final vm = CloudChatsViewModel(repository: repository);
      expect(vm.cloudAvailable, isNull);

      final loading = vm.load();
      expect(vm.isLoading, isTrue);
      await loading;

      expect(vm.isLoading, isFalse);
      expect(vm.cloudAvailable, isTrue);
      expect(vm.workspaces.map((w) => w.externalId), ['ws-1']);
      expect(vm.chatById('chat-1')?.title, 'Plan the mobile launch');
      expect(vm.workspaceForChat('chat-1')?.name, 'Mobile App');
    });

    test('creates in flight notify on change and clear on reset', () {
      final vm = CloudChatsViewModel(repository: FakeCloudChatRepository());
      var notifications = 0;
      vm.addListener(() => notifications++);

      vm.markCreateInFlight('r1');
      vm.markCreateInFlight('r1');
      expect(vm.pendingCreatesInFlight, {'r1'});
      expect(notifications, 1);

      vm.clearCreateInFlight('r1');
      vm.clearCreateInFlight('r1');
      expect(vm.pendingCreatesInFlight, isEmpty);
      expect(notifications, 2);

      vm.markCreateInFlight('r2');
      vm.reset();
      expect(vm.pendingCreatesInFlight, isEmpty);
      vm.dispose();
    });

    test('a 404 probe hides cloud without reporting an error', () async {
      final repository = FakeCloudChatRepository()..cloudUnavailable = true;
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();
      expect(vm.cloudAvailable, isFalse);
      expect(vm.workspaces, isEmpty);
      expect(vm.error, isNull);
    });

    test(
      'a failed probe keeps availability unknown and exposes the error',
      () async {
        final repository = FakeCloudChatRepository()
          ..listError = const CloudApiException(
            statusCode: 500,
            message: 'Cloud request failed with status 500',
          );
        final vm = CloudChatsViewModel(repository: repository);
        await vm.load();
        expect(vm.cloudAvailable, isNull);
        expect(vm.error, 'Cloud request failed with status 500');
        expect(vm.isLoading, isFalse);
      },
    );

    test(
      'an untyped probe failure uses the canonical list error copy',
      () async {
        final repository = FakeCloudChatRepository()
          ..listError = StateError('offline');
        final vm = CloudChatsViewModel(repository: repository);

        await vm.load();

        expect(vm.error, "Couldn't load cloud chats");
      },
    );

    for (final status in [401, 403]) {
      test(
        'a $status probe preserves a typed authentication failure',
        () async {
          final repository = FakeCloudChatRepository()
            ..listError = CloudApiException(
              statusCode: status,
              message: 'Authentication required',
            );
          final vm = CloudChatsViewModel(repository: repository);

          await vm.load();

          expect(vm.authenticationFailure?.statusCode, status);
          expect(vm.authenticationFailureRevision, 1);
          expect(vm.error, 'Authentication required');
        },
      );
    }

    test(
      'a non-authentication probe failure stays a plain list error',
      () async {
        final repository = FakeCloudChatRepository()
          ..listError = const CloudApiException(
            statusCode: 500,
            message: 'Cloud request failed with status 500',
          );
        final vm = CloudChatsViewModel(repository: repository);

        await vm.load();

        expect(vm.authenticationFailure, isNull);
        expect(vm.authenticationFailureRevision, 0);
      },
    );

    test('load is single-flighted; refresh always re-fetches', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace()],
      );
      final vm = CloudChatsViewModel(repository: repository);
      await Future.wait([vm.load(), vm.load()]);
      expect(repository.listCalls, hasLength(1));
      await vm.load();
      expect(repository.listCalls, hasLength(1));
      await vm.refresh();
      expect(repository.listCalls, hasLength(2));
    });

    test(
      'createChat uses the given id, inserts the chat, and returns it',
      () async {
        final repository = FakeCloudChatRepository(
          workspaces: [sampleWorkspace(chats: [])],
        );
        final vm = CloudChatsViewModel(repository: repository);
        await vm.load();
        final chat = await vm.createChat('ws-1', externalId: 'new-chat');
        expect(chat, isNotNull);
        final created = chat!;
        expect(created.externalId, 'new-chat');
        expect(repository.createCalls.single.workspaceId, 'ws-1');
        expect(repository.createCalls.single.externalId, 'new-chat');
        expect(
          vm.workspaces.single.chats.single.externalId,
          created.externalId,
        );
        expect(vm.workspaceForChat(created.externalId)?.externalId, 'ws-1');
      },
    );

    test('createChat retried under one id keeps a single chat', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace(chats: [])],
      );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();
      await vm.createChat('ws-1', externalId: 'same-chat');
      await vm.createChat('ws-1', externalId: 'same-chat');
      expect(repository.createCalls, hasLength(2));
      expect(vm.workspaces.single.chats.map((c) => c.externalId), [
        'same-chat',
      ]);
    });

    test(
      'createChat seeds the catalog default model when one is known',
      () async {
        final repository = FakeCloudChatRepository(
          workspaces: [sampleWorkspace(chats: [])],
        );
        final vm = CloudChatsViewModel(repository: repository);
        await vm.load();
        await vm.ensureModels();
        await vm.createChat('ws-1', externalId: 'new-chat');
        expect(repository.createCalls.single.model, 'gpt-5.6-luna');
      },
    );

    test('createChat waits for and pins the policy fallback model', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace(chats: [])],
        catalog: CloudModelCatalog(
          models: sampleCatalog.models,
          modelHarnesses: sampleCatalog.modelHarnesses,
          defaultModelId: 'blocked-model',
          defaultModelBlocked: true,
          defaultModelFallbackId: 'claude-opus-5',
        ),
      );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();

      await vm.createChat('ws-1', externalId: 'new-chat');

      expect(repository.modelsCalls, 1);
      expect(vm.defaultModelId, 'claude-opus-5');
      expect(repository.createCalls.single.model, 'claude-opus-5');
    });

    test('createChat discards a result that crosses a scope reset', () async {
      final gate = Completer<void>();
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace(chats: [])],
      )..createCompleters['ws-1'] = gate;
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();
      await vm.ensureModels();

      final creating = vm.createChat('ws-1', externalId: 'new-chat');
      await Future<void>.delayed(Duration.zero);
      expect(repository.createCalls, hasLength(1));

      vm.reset();
      gate.complete();

      expect(await creating, isNull);
      expect(vm.workspaces, isEmpty);
    });

    test('blocked default falls back to the first allowed model', () async {
      final repository = FakeCloudChatRepository(
        catalog: CloudModelCatalog(
          models: sampleCatalog.models,
          modelHarnesses: sampleCatalog.modelHarnesses,
          defaultModelId: 'blocked-model',
          defaultModelBlocked: true,
        ),
      );
      final vm = CloudChatsViewModel(repository: repository);

      await vm.ensureModels();

      expect(vm.defaultModelId, 'gpt-5.6-luna');
    });

    test('rename updates the cached chat', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace()],
      );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();
      await vm.rename('chat-1', 'Launch plan');
      expect(vm.chatById('chat-1')?.title, 'Launch plan');
      expect(repository.renameCalls.single.title, 'Launch plan');
    });

    test('archive removes the cached chat', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace()],
      );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();
      await vm.archive('chat-1');
      expect(vm.chatById('chat-1'), isNull);
      expect(repository.archiveCalls, ['chat-1']);
    });

    test('delete removes the cached chat', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace()],
      );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();
      await vm.delete('chat-1');
      expect(vm.chatById('chat-1'), isNull);
      expect(repository.deleteCalls, ['chat-1']);
    });

    test(
      'deleting a main chat removes its child tabs but keeps other chats',
      () async {
        final repository = FakeCloudChatRepository(
          workspaces: [
            sampleWorkspace(
              chats: [
                sampleChat(),
                sampleChat(id: 'child-1', taskChatExternalId: 'chat-1'),
                sampleChat(id: 'other'),
              ],
            ),
          ],
        );
        final vm = CloudChatsViewModel(repository: repository);
        await vm.load();

        await vm.delete('chat-1');

        expect(vm.chatById('chat-1'), isNull);
        expect(vm.chatById('child-1'), isNull);
        expect(vm.chatById('other'), isNotNull);
      },
    );

    test('a failed delete keeps the cached chat and rethrows', () async {
      final repository =
          FakeCloudChatRepository(workspaces: [sampleWorkspace()])
            ..deleteError = const CloudApiException(
              statusCode: 409,
              message: 'Change the task lifecycle from its main chat.',
            );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();
      await expectLater(vm.delete('chat-1'), throwsA(isA<CloudApiException>()));
      expect(vm.chatById('chat-1'), isNotNull);
    });

    test('setModel persists and updates the cached chat', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace()],
      );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();
      await vm.setModel('chat-1', 'claude-opus-5');
      expect(vm.chatById('chat-1')?.modelDefinitionId, 'claude-opus-5');
      expect(repository.setModelCalls.single.model, 'claude-opus-5');
    });

    test('Auto and model choices persist in user order', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace()],
      );
      final first = Completer<void>();
      repository.setModelCompleters['claude-opus-5'] = first;
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();

      final model = vm.setModel('chat-1', 'claude-opus-5');
      final auto = vm.setAutoModel('chat-1');
      await Future<void>.delayed(Duration.zero);
      expect(repository.setAutoModelCalls, isEmpty);

      first.complete();
      await model;
      await auto;

      expect(repository.setAutoModelCalls, ['chat-1']);
      expect(vm.chatById('chat-1')?.modelAuto, isTrue);
      await vm.setModel('chat-1', 'gpt-5.6-luna');
      expect(vm.chatById('chat-1')?.modelAuto, isFalse);
    });

    test('setModel serializes rapid selections in user order', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace()],
      );
      final first = Completer<void>();
      final second = Completer<void>();
      repository.setModelCompleters
        ..['claude-opus-5'] = first
        ..['gpt-5.6-luna'] = second;
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();

      final firstSelection = vm.setModel('chat-1', 'claude-opus-5');
      final secondSelection = vm.setModel('chat-1', 'gpt-5.6-luna');
      await Future<void>.delayed(Duration.zero);
      expect(repository.setModelCalls.map((call) => call.model), [
        'claude-opus-5',
      ]);

      first.complete();
      await firstSelection;
      await Future<void>.delayed(Duration.zero);
      expect(repository.setModelCalls.map((call) => call.model), [
        'claude-opus-5',
        'gpt-5.6-luna',
      ]);

      second.complete();
      await secondSelection;

      expect(vm.chatById('chat-1')?.modelDefinitionId, 'gpt-5.6-luna');
    });

    test(
      'setModel keeps an earlier success when a later queued selection fails',
      () async {
        final repository = FakeCloudChatRepository(
          workspaces: [sampleWorkspace()],
        );
        final first = Completer<void>();
        repository.setModelCompleters['claude-opus-5'] = first;
        repository.setModelErrors['gpt-5.6-luna'] = const CloudApiException(
          statusCode: 500,
          message: 'The later selection failed',
        );
        final vm = CloudChatsViewModel(repository: repository);
        await vm.load();

        final firstSelection = vm.setModel('chat-1', 'claude-opus-5');
        final secondSelection = vm.setModel('chat-1', 'gpt-5.6-luna');
        first.complete();
        await firstSelection;
        await expectLater(secondSelection, throwsA(isA<CloudApiException>()));

        expect(vm.chatById('chat-1')?.modelDefinitionId, 'claude-opus-5');
      },
    );

    test(
      'models project the catalog onto the shared ModelOption shape',
      () async {
        final repository = FakeCloudChatRepository();
        final vm = CloudChatsViewModel(repository: repository);
        expect(vm.models, isEmpty);
        await vm.ensureModels();
        await vm.ensureModels();
        expect(repository.modelsCalls, 1);
        final gpt = vm.models.firstWhere((m) => m.id == 'gpt-5.6-luna');
        final opus = vm.models.firstWhere((m) => m.id == 'claude-opus-5');
        expect(gpt.isDefault, isTrue);
        expect(gpt.provider, 'codex');
        expect(gpt.vendor, 'openai');
        expect(gpt.supportsFastMode, isTrue);
        // Core's declared levels are the canonical set.
        expect(gpt.supportedThinkingLevels, ['off', 'medium', 'high', 'xhigh']);
        expect(gpt.thinkingLevels, isNull);
        expect(opus.isDefault, isFalse);
        expect(opus.provider, 'claude');
        expect(opus.description, 'Deep reasoning');
        expect(opus.supportsFastMode, isFalse);
        expect(vm.defaultModelId, 'gpt-5.6-luna');
      },
    );

    test('models drop Ultra, which Core rejects, and keep absent and '
        'empty level sets apart', () async {
      final repository = FakeCloudChatRepository(
        catalog: const CloudModelCatalog(
          models: [
            CloudModelOption(
              id: 'with-ultra',
              label: 'With Ultra',
              provider: 'openai',
              family: 'gpt',
              familyLabel: 'GPT',
              harness: 'codex',
              thinkingLevels: ['off', 'low', 'max', 'ultra'],
            ),
            CloudModelOption(
              id: 'only-ultra',
              label: 'Only Ultra',
              provider: 'openai',
              family: 'gpt',
              familyLabel: 'GPT',
              thinkingLevels: ['ultra'],
            ),
            CloudModelOption(
              id: 'undeclared',
              label: 'Undeclared',
              provider: 'openai',
              family: 'gpt',
              familyLabel: 'GPT',
            ),
          ],
          modelHarnesses: {},
          defaultModelId: null,
          defaultModelBlocked: false,
        ),
      );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.ensureModels();
      final levels = {
        for (final model in vm.models) model.id: model.supportedThinkingLevels,
      };
      expect(levels, {
        'with-ultra': ['off', 'low', 'max'],
        'only-ultra': <String>[],
        'undeclared': null,
      });
    });

    // CAN-2872: the server marks what the account's model library does not
    // cover; mobile locks those rows only when signing in is the remedy.
    for (final (access, locked) in [
      ('needs_sign_in', true),
      ('needs_sign_in_then_purchase', true),
      ('needs_purchase', false),
      ('unlocked', false),
      (null, false),
    ]) {
      test(
        'a library-locked model is locked for access $access: $locked',
        () async {
          final catalog = CloudModelCatalog.fromJson({
            'models': [
              {
                'id': 'gpt-6-luna',
                'label': 'GPT 6 Luna',
                'libraryEligibility': 'available',
              },
              {
                'id': 'claude-opus-5',
                'label': 'Opus 5',
                'libraryEligibility': 'locked',
              },
            ],
            'modelHarnesses': <String, Object?>{},
            'modelLibrary': ?access,
          });
          final vm = CloudChatsViewModel(
            repository: FakeCloudChatRepository(catalog: catalog),
          );
          await vm.ensureModels();

          final luna = vm.models.firstWhere((m) => m.id == 'gpt-6-luna');
          final opus = vm.models.firstWhere((m) => m.id == 'claude-opus-5');
          expect(luna.available, isTrue);
          expect(luna.unavailableReason, isNull);
          expect(opus.available, !locked);
          expect(opus.unavailableReason, locked ? access : null);
        },
      );
    }

    test('models keep the picker metadata of the hosted catalog', () async {
      final repository = FakeCloudChatRepository(
        catalog: const CloudModelCatalog(
          models: [
            CloudModelOption(
              id: 'haiku-3',
              label: 'Haiku 3',
              provider: 'anthropic',
              family: 'claude',
              familyLabel: 'Claude',
              harness: 'claude',
              contextWindow: 200000,
              showMoreOnly: true,
            ),
            CloudModelOption(
              id: 'older',
              label: 'Older host row',
              provider: null,
              family: null,
              familyLabel: null,
              contextWindow: 0,
            ),
          ],
          modelHarnesses: {},
          defaultModelId: null,
          defaultModelBlocked: false,
        ),
      );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.ensureModels();
      final haiku = vm.models.first;
      expect(haiku.contextWindow, 200000);
      expect(haiku.showMoreOnly, isTrue);
      expect(haiku.family, 'claude');
      expect(haiku.familyLabel, 'Claude');
      final older = vm.models.last;
      expect(older.contextWindow, isNull);
      expect(older.showMoreOnly, isFalse);
      expect(older.provider, 'other');
    });

    test('models are AI Credits rows on their resolved harness', () async {
      final repository = FakeCloudChatRepository(
        catalog: const CloudModelCatalog(
          models: [
            CloudModelOption(
              id: 'declared',
              label: 'Declared',
              provider: 'anthropic',
              family: null,
              familyLabel: null,
              harness: 'claude',
            ),
            CloudModelOption(
              id: 'mapped',
              label: 'Mapped',
              provider: 'deepseek',
              family: null,
              familyLabel: null,
            ),
            CloudModelOption(
              id: 'unresolved',
              label: 'Unresolved',
              provider: null,
              family: null,
              familyLabel: null,
            ),
          ],
          modelHarnesses: {'mapped': 'codex'},
          defaultModelId: null,
          defaultModelBlocked: false,
        ),
      );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.ensureModels();
      expect(vm.models.map((m) => m.source), everyElement('ai-gateway'));
      expect(vm.models.map((m) => m.harness), ['claude', 'codex', null]);
      expect(vm.models.map((m) => m.provider), ['claude', 'codex', 'other']);
    });

    test('reset forgets workspaces, availability, and models', () async {
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace()],
      );
      final vm = CloudChatsViewModel(repository: repository);
      await vm.load();
      await vm.ensureModels();
      vm.reset();
      expect(vm.workspaces, isEmpty);
      expect(vm.cloudAvailable, isNull);
      expect(vm.models, isEmpty);
      await vm.load();
      expect(repository.listCalls, hasLength(2));
    });

    test('reset rejects stale workspace and catalog responses', () async {
      final oldWorkspace = sampleWorkspace(id: 'old', name: 'Old account');
      final newWorkspace = sampleWorkspace(id: 'new', name: 'New account');
      final oldCatalog = Completer<CloudModelCatalog>();
      final oldWorkspaces = Completer<List<CloudWorkspaceSummary>>();
      final repository = FakeCloudChatRepository(workspaces: [oldWorkspace])
        ..listCompleter = oldWorkspaces
        ..modelsCompleter = oldCatalog;
      final vm = CloudChatsViewModel(repository: repository);

      final staleLoad = vm.load();
      final staleModels = vm.ensureModels();
      vm.reset();
      repository
        ..workspaces = [newWorkspace]
        ..listCompleter = null
        ..modelsCompleter = null;

      await Future.wait([vm.load(), vm.ensureModels()]);
      expect(vm.workspaces.single.externalId, 'new');
      expect(vm.defaultModelId, 'gpt-5.6-luna');

      oldWorkspaces.complete([oldWorkspace]);
      oldCatalog.complete(
        const CloudModelCatalog(
          models: [],
          modelHarnesses: {},
          defaultModelId: 'stale-model',
          defaultModelBlocked: false,
        ),
      );
      await Future.wait([staleLoad, staleModels]);

      expect(vm.workspaces.single.externalId, 'new');
      expect(vm.defaultModelId, 'gpt-5.6-luna');
      expect(repository.listCalls, hasLength(2));
      expect(repository.modelsCalls, 2);
    });
  });

  group('CloudChatsViewModel first project', () {
    late FakeCloudChatRepository repository;
    late List<Duration> delays;
    late CloudChatsViewModel vm;

    setUp(() {
      repository = FakeCloudChatRepository();
      delays = [];
      vm = CloudChatsViewModel(
        repository: repository,
        delay: (duration) async => delays.add(duration),
      );
    });

    tearDown(() => vm.dispose());

    const provisioning503 = CloudApiException(
      statusCode: 503,
      message: 'Cloud account is still being set up. Try again in a moment.',
      code: 'CLOUD_ACCOUNT_PROVISIONING',
      retryAfter: Duration(seconds: 2),
    );

    test('an empty first list provisions My project', () async {
      await vm.load();

      await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

      expect(repository.provisionCalls, ['My project']);
      expect(vm.workspaces.map((w) => w.name), ['My project']);
      expect(vm.error, isNull);
      expect(vm.isProvisioningFirstProject, isFalse);
    });

    test('nothing is decided before the first list answers', () async {
      await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);
      expect(repository.provisionCalls, isEmpty);

      await vm.load();
      await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);
      expect(repository.provisionCalls, hasLength(1));
    });

    test('a paired desktop is never provisioned for, even later', () async {
      await vm.load();

      await vm.provisionFirstProjectIfNeeded(pairedDesktop: true);
      await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

      expect(repository.provisionCalls, isEmpty);
      expect(vm.workspaces, isEmpty);
    });

    test('a first list with projects latches off provisioning', () async {
      repository.workspaces = [sampleWorkspace()];
      await vm.load();
      await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

      // The user archives their last project on the web and refreshes here:
      // that is not a first run, so nothing is re-created.
      repository.workspaces = [];
      await vm.refresh();
      await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

      expect(repository.provisionCalls, isEmpty);
    });

    test('cloud unavailable never provisions', () async {
      repository.cloudUnavailable = true;
      await vm.load();

      await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

      expect(repository.provisionCalls, isEmpty);
    });

    test(
      'a declined provision stays empty, quiet, and is not retried',
      () async {
        repository.provisionResults.add(null);
        await vm.load();

        await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);
        await vm.refresh();
        await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

        expect(repository.provisionCalls, hasLength(1));
        expect(vm.workspaces, isEmpty);
        expect(vm.error, isNull);
      },
    );

    test('a tenancy still provisioning is retried after Retry-After', () async {
      repository.provisionResults.addAll([provisioning503, provisioning503]);
      await vm.load();

      await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

      expect(repository.provisionCalls, hasLength(3));
      expect(delays, [const Duration(seconds: 2), const Duration(seconds: 2)]);
      expect(vm.workspaces.map((w) => w.name), ['My project']);
      expect(vm.error, isNull);
    });

    test(
      'an exhausted retry budget surfaces an error a refresh retries',
      () async {
        repository.provisionResults.addAll([
          provisioning503,
          provisioning503,
          provisioning503,
        ]);
        await vm.load();

        await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

        expect(repository.provisionCalls, hasLength(3));
        expect(vm.workspaces, isEmpty);
        expect(vm.error, provisioning503.message);
        expect(vm.isProvisioningFirstProject, isFalse);

        // Only a new list answer re-arms it, so a stray rebuild cannot loop.
        await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);
        expect(repository.provisionCalls, hasLength(3));

        await vm.refresh();
        await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);
        expect(repository.provisionCalls, hasLength(4));
        expect(vm.workspaces.map((w) => w.name), ['My project']);
        expect(vm.error, isNull);
      },
    );

    test('other failures are not retried', () async {
      repository.provisionResults.add(
        const CloudApiException(statusCode: 500, message: 'Server error'),
      );
      await vm.load();

      await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

      expect(repository.provisionCalls, hasLength(1));
      expect(delays, isEmpty);
      expect(vm.error, 'Server error');
    });

    test('concurrent calls share one request and report progress', () async {
      final gate = Completer<void>();
      repository.provisionCompleter = gate;
      await vm.load();

      final first = vm.provisionFirstProjectIfNeeded(pairedDesktop: false);
      final second = vm.provisionFirstProjectIfNeeded(pairedDesktop: false);
      expect(vm.isProvisioningFirstProject, isTrue);

      gate.complete();
      await Future.wait([first, second]);

      expect(repository.provisionCalls, hasLength(1));
      expect(vm.isProvisioningFirstProject, isFalse);
    });

    test('an account change drops the old result and re-arms', () async {
      final gate = Completer<void>();
      repository.provisionCompleter = gate;
      await vm.load();
      final stale = vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

      vm.reset();
      expect(vm.isProvisioningFirstProject, isFalse);
      gate.complete();
      await stale;
      expect(vm.workspaces, isEmpty);

      repository
        ..provisionCompleter = null
        ..workspaces = [];
      await vm.load();
      await vm.provisionFirstProjectIfNeeded(pairedDesktop: false);

      expect(repository.provisionCalls, hasLength(2));
      expect(vm.workspaces.map((w) => w.name), ['My project']);
    });
  });
}
