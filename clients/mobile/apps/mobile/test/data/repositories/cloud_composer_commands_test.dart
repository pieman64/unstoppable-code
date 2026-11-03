import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_invocables.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/repositories/cloud_composer_commands.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/cloud_api_service.dart';

import '../../support/fake_cloud_chat_repository.dart';

const _skillRef = {'sourceId': 'src', 'skillName': 'notes'};
const _pluginRef = {'marketplaceId': 'mk', 'pluginName': 'deploy'};

CloudChatSummary _chat({
  Map<String, dynamic>? selections,
  Map<String, dynamic>? bundles,
}) => CloudChatSummary(
  externalId: 'chat-1',
  title: 'Chat',
  taskChatExternalId: null,
  modelDefinitionId: 'gpt-5.6-luna',
  thinkingLevel: null,
  coreAgentSessionId: 'session-1',
  createdAtMs: 1,
  capabilitySelections: selections,
  capabilityBundles: bundles,
);

void main() {
  late FakeCloudChatRepository repository;
  late CloudComposerCommands commands;

  setUp(() {
    repository = FakeCloudChatRepository(
      workspaces: [
        sampleWorkspace(chats: [_chat()]),
      ],
    );
    repository.invocableRows = const [ComposerCommand(name: 'review')];
    commands = CloudComposerCommands(repository);
  });

  test('caches a chat inventory per model until enablement', () async {
    await commands.chatCommands('chat-1', modelDefinitionId: 'a');
    await commands.chatCommands('chat-1', modelDefinitionId: 'a');
    expect(repository.invocableCalls, hasLength(1));
    await commands.chatCommands('chat-1', modelDefinitionId: 'b');
    expect(repository.invocableCalls.map((call) => call.model), ['a', 'b']);
    await commands.enableForChat('chat-1', _skillRef);
    await commands.chatCommands('chat-1', modelDefinitionId: 'a');
    expect(repository.invocableCalls, hasLength(3));
  });

  test('a failed inventory is not cached', () async {
    repository.invocablesError = StateError('offline');
    await expectLater(commands.chatCommands('chat-1'), throwsStateError);
    repository.invocablesError = null;
    expect(await commands.chatCommands('chat-1'), hasLength(1));
    expect(repository.invocableCalls, hasLength(2));
  });

  test('enabling adds the ref to the effective selection', () async {
    repository.workspaces = [
      sampleWorkspace(
        chats: [
          _chat(
            selections: {
              'collectionIds': ['c1'],
              'skillRefs': <Object>[],
              'pluginRefs': [_pluginRef],
            },
            bundles: {'activeBundle': <String, Object>{}},
          ),
        ],
      ),
    ];
    await commands.enableForChat('chat-1', _skillRef);
    expect(repository.capabilityCalls.single.selections, {
      'collectionIds': ['c1'],
      'skillRefs': [_skillRef],
      'pluginRefs': [_pluginRef],
    });
  });

  test('a chat with no bundle starts from an empty selection', () async {
    await commands.enableForChat('chat-1', _pluginRef);
    expect(repository.capabilityCalls.single.selections, {
      'collectionIds': <Object?>[],
      'skillRefs': <Object?>[],
      'pluginRefs': [_pluginRef],
    });
  });

  test('an unknown selection fails without a write', () async {
    repository.workspaces = [
      sampleWorkspace(
        chats: [
          _chat(bundles: {'activeBundle': <String, Object>{}}),
        ],
      ),
    ];
    await expectLater(
      commands.enableForChat('chat-1', _skillRef),
      throwsStateError,
    );
    expect(repository.capabilityCalls, isEmpty);
  });

  test('a failed write rethrows and keeps the inventory cached', () async {
    await commands.chatCommands('chat-1');
    repository.capabilitiesError = StateError('denied');
    await expectLater(
      commands.enableForChat('chat-1', _skillRef),
      throwsStateError,
    );
    await commands.chatCommands('chat-1');
    expect(repository.invocableCalls, hasLength(1));
  });

  test('writes for one chat run in order', () async {
    final gate = Completer<void>();
    repository.capabilitiesGate = gate;
    final first = commands.enableForChat('chat-1', _skillRef);
    final second = commands.enableForChat('chat-1', _pluginRef);
    await pumpEventQueue();
    expect(repository.capabilityCalls, hasLength(1));
    gate.complete();
    await Future.wait([first, second]);
    expect(repository.capabilityCalls, hasLength(2));
  });

  test('a failed write does not block the next write for the chat', () async {
    repository.capabilitiesError = StateError('denied');
    await expectLater(
      commands.enableForChat('chat-1', _skillRef),
      throwsStateError,
    );
    repository.capabilitiesError = null;
    expect(await commands.enableForChat('chat-1', _skillRef), isTrue);
    expect(repository.capabilityCalls, hasLength(2));
  });

  test('a write queued behind a failing write still runs', () async {
    final gate = Completer<void>();
    repository
      ..capabilitiesGate = gate
      ..capabilitiesError = StateError('denied');
    final first = commands.enableForChat('chat-1', _skillRef);
    final second = commands.enableForChat('chat-1', _pluginRef);
    final results = Future.wait([
      expectLater(first, throwsStateError),
      expectLater(second, throwsStateError),
    ]);
    await pumpEventQueue();
    gate.complete();
    await results;
    expect(repository.capabilityCalls, hasLength(2));
  });

  test('a reset during the selection read drops the stale write', () async {
    final read = Completer<List<CloudWorkspaceSummary>>();
    repository.listCompleter = read;
    final stale = commands.enableForChat('chat-1', _skillRef);
    await pumpEventQueue();
    expect(repository.listCalls, hasLength(1));

    commands.clear();
    repository.listCompleter = null;
    expect(await commands.enableForChat('chat-1', _pluginRef), isTrue);
    read.complete([
      sampleWorkspace(chats: [_chat()]),
    ]);
    expect(await stale, isFalse);

    expect(repository.capabilityCalls.single.selections['pluginRefs'], [
      _pluginRef,
    ]);
  });

  test('a draft enables from the project defaults, then its own', () async {
    repository.defaultPluginSelections = {
      'collectionIds': ['c1'],
      'skillRefs': <Object>[],
      'pluginRefs': <Object>[],
    };
    await commands.draftCommands('ws-1', modelDefinitionId: 'm');
    expect(repository.invocableCalls.single.pluginSelections, isNull);
    final selections = commands.draftSelectionsWith('ws-1', null, _skillRef);
    expect(selections, {
      'collectionIds': ['c1'],
      'skillRefs': [_skillRef],
      'pluginRefs': <Object?>[],
    });
    await commands.draftCommands(
      'ws-1',
      modelDefinitionId: 'm',
      pluginSelections: selections,
    );
    expect(repository.invocableCalls.last.pluginSelections, selections);
    expect(commands.draftSelectionsWith('ws-1', selections, _pluginRef), {
      'collectionIds': ['c1'],
      'skillRefs': [_skillRef],
      'pluginRefs': [_pluginRef],
    });
    // Another project's draft does not inherit these defaults.
    expect(commands.draftSelectionsWith('ws-2', null, _skillRef), {
      'collectionIds': <Object?>[],
      'skillRefs': [_skillRef],
      'pluginRefs': <Object?>[],
    });
  });

  test('clear forgets project defaults and cached inventories', () async {
    repository.defaultPluginSelections = {
      'collectionIds': ['c1'],
    };
    await commands.chatCommands('chat-1');
    await commands.draftCommands('ws-1');
    commands.clear();
    expect(
      commands.draftSelectionsWith('ws-1', null, _skillRef)['collectionIds'],
      isEmpty,
    );
    await commands.chatCommands('chat-1');
    expect(repository.invocableCalls, hasLength(3));
  });

  group('the capability write answer', () {
    const skillRef = {
      'kind': 'skill',
      'sourceId': 'src',
      'skillName': 'notes',
      'via': {'kind': 'direct'},
    };
    const enabled = {
      'collectionIds': <Object>[],
      'skillRefs': [_skillRef],
      'pluginRefs': <Object>[],
    };

    /// A real HTTP repository whose capability PUT answers 200 with [answer].
    CloudComposerCommands overHttp(Map<String, Object?> answer) =>
        CloudComposerCommands(
          HttpCloudChatRepository(
            service: CloudApiService(
              apiClient: ApiClient(
                baseUrl: 'https://example.test',
                tokenProvider: () => 'mobile-session',
                httpClient: MockClient((request) async {
                  if (request.method == 'GET' &&
                      request.url.path == '/api/cloud/workspaces') {
                    return http.Response(
                      jsonEncode({
                        'workspaces': [
                          {
                            'retainedChatCount': 1,
                            'deletionRetentionDays': 30,
                            'externalId': 'ws-1',
                            'name': 'Mobile',
                            'createdAtMs': 1,
                            'chats': [
                              {
                                'externalId': 'chat-1',
                                'coreAgentSessionId': 'session-1',
                                'createdAtMs': 1,
                              },
                            ],
                          },
                        ],
                      }),
                      200,
                    );
                  }
                  expect(request.method, 'PUT');
                  expect(
                    request.url.path,
                    '/api/cloud/chats/chat-1/capabilities',
                  );
                  return http.Response(
                    jsonEncode({
                      'capabilityBundles': {
                        'pendingBundle': {'version': 1, 'digest': 'd'},
                      },
                      'capabilityBundleStateVersion': 2,
                      'outcome': 'staged',
                      'warnings': <String>[],
                      ...answer,
                    }),
                    200,
                  );
                }),
              ),
            ),
          ),
        );

    test('a ref the server pruned fails the enablement', () async {
      final commands = overHttp({
        'capabilitySelections': {
          'collectionIds': <Object>[],
          'skillRefs': <Object>[],
          'pluginRefs': <Object>[],
        },
        'capabilityPruned': [
          {'kind': 'skill', 'displayName': 'notes', 'ref': skillRef},
        ],
      });
      await expectLater(
        commands.enableForChat('chat-1', _skillRef),
        throwsStateError,
      );
    });

    test('a ref the bundle cannot carry fails the enablement', () async {
      final commands = overHttp({
        'capabilitySelections': enabled,
        'capabilityUnavailable': [
          {
            'ref': skillRef,
            'reason': 'desktop_only',
            'disposition': 'unsupported',
          },
        ],
      });
      await expectLater(
        commands.enableForChat('chat-1', _skillRef),
        throwsStateError,
      );
    });

    test('an answer that names no selection fails the enablement', () async {
      final commands = overHttp({});
      await expectLater(
        commands.enableForChat('chat-1', _skillRef),
        throwsStateError,
      );
    });

    // The route answers a chat without a bundle that ends up with nothing
    // selected (the last inherited default turned off) with no bundle and no
    // `capabilitySelections`: the chat holds the empty selection.
    test('CAN-3922 an unchanged answer without a bundle saves the empty '
        'selection', () async {
      final commands = overHttp({
        'capabilityBundles': <String, Object?>{},
        'capabilityBundleStateVersion': 0,
        'outcome': 'unchanged',
      });
      const empty = <String, Object?>{
        'collectionIds': <Object?>[],
        'skillRefs': <Object?>[],
        'pluginRefs': <Object?>[],
        'mcpServerRefs': <Object?>[],
      };
      expect(await commands.saveChatSelections('chat-1', empty), isEmpty);
      expect(commands.knownChatSelections('chat-1'), isEmpty);
    });

    for (final (name, answer) in [
      (
        'names a bundle',
        <String, Object?>{
          'capabilityBundles': {
            'activeBundle': {'version': 1, 'digest': 'd'},
          },
          'outcome': 'unchanged',
        },
      ),
      (
        'is staged',
        <String, Object?>{
          'capabilityBundles': <String, Object?>{},
          'outcome': 'staged',
        },
      ),
      (
        'has no bundle state',
        <String, Object?>{'capabilityBundles': null, 'outcome': 'unchanged'},
      ),
    ]) {
      test('CAN-3922 an answer without a selection that $name is '
          'unknown', () async {
        final commands = overHttp(answer);
        await expectLater(
          commands.saveChatSelections('chat-1', const {
            'pluginRefs': <Object?>[],
          }),
          throwsStateError,
        );
      });
    }

    test('a carried or degraded ref enables', () async {
      final commands = overHttp({
        'capabilitySelections': enabled,
        'capabilityUnavailable': [
          {'ref': skillRef, 'reason': 'partial', 'disposition': 'degraded'},
          // An unknown reason reads as degraded (protocol rule).
          {
            'ref': skillRef,
            'reason': 'from_a_newer_producer',
            'disposition': 'unavailable',
          },
        ],
      });
      await commands.enableForChat('chat-1', _skillRef);
    });

    group('CAN-3922 an added MCP server', () {
      const mcpRef = {'serverId': 'linear', 'configId': 'default'};
      const withMcp = {
        'collectionIds': <Object>[],
        'skillRefs': <Object>[],
        'pluginRefs': <Object>[],
        'mcpServerRefs': [mcpRef],
      };
      const unavailableMcp = {
        'kind': 'mcpServer',
        ...mcpRef,
        'via': {'kind': 'direct'},
      };
      Map<String, Object?> heldBack(String reason) => {
        'capabilitySelections': withMcp,
        'capabilityUnavailable': [
          {
            'ref': unavailableMcp,
            'reason': reason,
            'disposition': 'unavailable',
          },
        ],
      };

      for (final (name, answer) in [
        ('needs reconnecting', heldBack('needs_reconnect')),
        ('was never connected', heldBack('not_connected')),
        (
          'was dropped',
          {
            'capabilitySelections': {...withMcp, 'mcpServerRefs': <Object>[]},
          },
        ),
      ]) {
        test('fails the write when it $name', () async {
          await expectLater(
            overHttp(answer).saveChatSelections('chat-1', withMcp),
            throwsStateError,
          );
        });
      }

      test('is saved when the bundle carries it', () async {
        expect(
          await overHttp({
            'capabilitySelections': withMcp,
            'capabilityUnavailable': [
              {
                'ref': unavailableMcp,
                'reason': 'partial',
                'disposition': 'degraded',
              },
            ],
          }).saveChatSelections('chat-1', withMcp),
          withMcp,
        );
      });
    });
  });

  group('CAN-3922 plugin selections', () {
    const kept = <String, Object?>{
      'collectionIds': ['kit'],
      'skillRefs': [_skillRef],
      'pluginRefs': <Object?>[],
      'mcpHttpAuthPreferences': [
        {'handler': 'oauth'},
      ],
    };

    void useSelections(Map<String, dynamic>? selections) {
      repository = FakeCloudChatRepository(
        workspaces: [
          sampleWorkspace(chats: [_chat(selections: selections)]),
        ],
      );
      commands = CloudComposerCommands(repository);
    }

    test('reads the chat selection, saves complete writes, and reloads the '
        'chat inventory', () async {
      useSelections(kept);
      expect(await commands.chatSelections('chat-1'), kept);
      expect(commands.knownChatSelections('chat-1'), kept);
      await commands.chatCommands('chat-1');
      final revision = commands.chatRevision('chat-1');

      final next = {
        ...kept,
        'pluginRefs': [_pluginRef],
      };
      expect(await commands.saveChatSelections('chat-1', next), next);
      expect(repository.capabilityCalls.single.selections, next);
      expect(commands.knownChatSelections('chat-1'), next);
      expect(commands.chatRevision('chat-1'), revision + 1);
      await commands.chatCommands('chat-1');
      expect(repository.invocableCalls, hasLength(2));
    });

    test('an unknown chat selection cannot be read for a write', () async {
      repository = FakeCloudChatRepository(
        workspaces: [
          sampleWorkspace(
            chats: [
              _chat(bundles: {'digest': 'd'}),
            ],
          ),
        ],
      );
      commands = CloudComposerCommands(repository);
      await expectLater(commands.chatSelections('chat-1'), throwsStateError);
    });

    test('a write that the server prunes or holds back fails', () async {
      useSelections(const {});
      await commands.chatSelections('chat-1');
      repository.capabilitiesAnswer = (_) =>
          const CloudCapabilityWriteResult(selections: {'pluginRefs': []});
      await expectLater(
        commands.saveChatSelections('chat-1', {
          'pluginRefs': [_pluginRef],
        }),
        throwsStateError,
      );
      // The answer is still the chat's selection now.
      expect(commands.knownChatSelections('chat-1'), {'pluginRefs': []});

      repository.capabilitiesAnswer = (selections) =>
          CloudCapabilityWriteResult(
            selections: selections,
            unusableRefs: [_pluginRef],
          );
      await expectLater(
        commands.saveChatSelections('chat-1', {
          'pluginRefs': [_pluginRef],
        }),
        throwsStateError,
      );
    });

    test('CAN-3922 an MCP server selected earlier does not fail the next '
        'write when it is still unusable', () async {
      const mcpRef = {'serverId': 'linear', 'configId': 'default'};
      useSelections(const {
        'pluginRefs': <Object?>[],
        'mcpServerRefs': [mcpRef],
      });
      await commands.chatSelections('chat-1');
      repository.capabilitiesAnswer = (selections) =>
          CloudCapabilityWriteResult(
            selections: selections,
            unusableRefs: const [mcpRef],
          );
      final next = {
        'pluginRefs': [_pluginRef],
        'mcpServerRefs': [mcpRef],
      };
      expect(await commands.saveChatSelections('chat-1', next), next);
    });

    group('CAN-3922 a ref the chat keeps but cannot use', () {
      const empty = <String, Object?>{
        'skillRefs': <Object?>[],
        'pluginRefs': <Object?>[],
        'mcpServerRefs': <Object?>[],
      };
      for (final (kind, ref) in [
        (ComposerPluginKind.skill, _skillRef),
        (ComposerPluginKind.plugin, _pluginRef),
        (
          ComposerPluginKind.mcpServer,
          const {'serverId': 'linear', 'configId': 'default'},
        ),
      ]) {
        group(kind.name, () {
          final withRef = {
            ...empty,
            kind.selectionKey: [ref],
          };
          var usable = false;

          setUp(() async {
            useSelections(empty);
            await commands.chatSelections('chat-1');
            usable = false;
            // Saved, but held back: the chat keeps the ref it cannot use.
            repository.capabilitiesAnswer = (selections) =>
                CloudCapabilityWriteResult(
                  selections: selections,
                  unusableRefs: usable ? const [] : [ref],
                );
            await expectLater(
              commands.saveChatSelections('chat-1', withRef),
              throwsStateError,
            );
          });

          test('fails each attempt to turn the ${kind.name} on, until the chat '
              'can use it', () async {
            await expectLater(
              commands.saveChatSelections('chat-1', withRef),
              throwsStateError,
            );
            expect(repository.capabilityCalls, hasLength(2));
            usable = true;
            expect(
              await commands.saveChatSelections('chat-1', withRef),
              withRef,
            );
          });

          test('a failed write in between still checks the ${kind.name} '
              'again', () async {
            repository.capabilitiesError = const CloudApiException(
              statusCode: 409,
              message: 'conflict',
            );
            await expectLater(
              commands.saveChatSelections('chat-1', withRef),
              throwsA(isA<CloudApiException>()),
            );
            repository.capabilitiesError = null;
            await expectLater(
              commands.saveChatSelections('chat-1', withRef),
              throwsStateError,
            );
          });

          test('does not fail the next write once a read reports the '
              '${kind.name} as selected', () async {
            repository.workspaces = [
              sampleWorkspace(chats: [_chat(selections: withRef)]),
            ];
            expect(await commands.chatSelections('chat-1'), withRef);
            final next = {
              ...withRef,
              'collectionIds': ['kit'],
            };
            expect(await commands.saveChatSelections('chat-1', next), next);
          });
        });
      }
    });

    test(
      'writes for one chat run in order and a reset drops queued ones',
      () async {
        useSelections(const {});
        final gate = Completer<void>();
        repository.capabilitiesGate = gate;
        final first = commands.saveChatSelections('chat-1', const {
          'collectionIds': ['a'],
        });
        final second = commands.saveChatSelections('chat-1', const {
          'collectionIds': ['b'],
        });
        await Future<void>.delayed(Duration.zero);
        expect(repository.capabilityCalls, hasLength(1));
        commands.clear();
        gate.complete();
        await expectLater(first, throwsStateError);
        await expectLater(second, throwsStateError);
        expect(repository.capabilityCalls, hasLength(1));
        expect(commands.knownChatSelections('chat-1'), isNull);
      },
    );

    group('a reopened sheet reads after the pending write', () {
      const empty = <String, Object?>{
        'collectionIds': <Object?>[],
        'skillRefs': <Object?>[],
        'pluginRefs': <Object?>[],
      };

      /// The server keeps each accepted write as the chat's selection.
      void persistWrites() {
        repository.capabilitiesAnswer = (selections) {
          repository.workspaces = [
            sampleWorkspace(chats: [_chat(selections: selections)]),
          ];
          return CloudCapabilityWriteResult(selections: selections);
        };
      }

      List<Object?> refs(Map<String, Object?> selections, String key) =>
          selections[key]! as List<Object?>;

      // Invariant: a read never returns a selection without a write that
      // the server accepted before it, so the next complete write keeps it.
      // The pending success while reopened is the failing sequence.
      for (final succeeds in [true, false]) {
        for (final reopenWhilePending in [true, false]) {
          test('CAN-3922 a ${succeeds ? 'successful' : 'failed'} write, '
              '${reopenWhilePending ? 'reopened while pending' : 'reopened after it settles'}'
              ', keeps every accepted ref', () async {
            useSelections(empty);
            persistWrites();
            final gate = Completer<void>();
            repository.capabilitiesGate = gate;
            if (!succeeds) repository.capabilitiesError = StateError('denied');
            final first = commands.saveChatSelections(
              'chat-1',
              withCapabilityEnableRef(empty, _pluginRef),
            );
            final firstSettled = expectLater(
              first,
              succeeds ? completion(anything) : throwsStateError,
            );
            await pumpEventQueue();

            Future<Map<String, Object?>>? reopened;
            var read = false;
            if (reopenWhilePending) {
              reopened = commands.chatSelections('chat-1')
                ..then((_) => read = true, onError: (Object _) {});
              await pumpEventQueue();
              expect(read, isFalse, reason: 'the read waits for the write');
            }
            gate.complete();
            await firstSettled;
            repository.capabilitiesError = null;
            final current =
                await (reopened ?? commands.chatSelections('chat-1'));

            expect(refs(current, 'pluginRefs'), succeeds ? [_pluginRef] : []);
            await commands.saveChatSelections(
              'chat-1',
              withCapabilityEnableRef(current, _skillRef),
            );
            final saved = repository.capabilityCalls.last.selections;
            expect(refs(saved, 'skillRefs'), [_skillRef]);
            expect(refs(saved, 'pluginRefs'), succeeds ? [_pluginRef] : []);
          });
        }
      }

      test('CAN-3922 a reset while the read waits drops the read', () async {
        useSelections(empty);
        final gate = Completer<void>();
        repository.capabilitiesGate = gate;
        final first = commands.saveChatSelections(
          'chat-1',
          withCapabilityEnableRef(empty, _pluginRef),
        );
        await pumpEventQueue();
        final reopened = commands.chatSelections('chat-1');
        await pumpEventQueue();
        final reads = repository.listCalls.length;

        commands.clear();
        gate.complete();
        await expectLater(first, throwsStateError);
        await expectLater(reopened, throwsStateError);
        expect(repository.listCalls, hasLength(reads));
        expect(commands.knownChatSelections('chat-1'), isNull);
      });

      test("CAN-3922 another chat's read does not wait", () async {
        repository = FakeCloudChatRepository(
          workspaces: [
            sampleWorkspace(
              chats: [
                _chat(selections: empty),
                CloudChatSummary(
                  externalId: 'chat-2',
                  title: 'Other',
                  taskChatExternalId: null,
                  modelDefinitionId: null,
                  thinkingLevel: null,
                  coreAgentSessionId: 'session-2',
                  createdAtMs: 2,
                  capabilitySelections: {
                    ...empty,
                    'skillRefs': [_skillRef],
                  },
                ),
              ],
            ),
          ],
        );
        commands = CloudComposerCommands(repository);
        final gate = Completer<void>();
        repository.capabilitiesGate = gate;
        final first = commands.saveChatSelections(
          'chat-1',
          withCapabilityEnableRef(empty, _pluginRef),
        );
        await pumpEventQueue();

        final other = await commands.chatSelections('chat-2');
        expect(refs(other, 'skillRefs'), [_skillRef]);
        gate.complete();
        await first;
      });
    });

    test(
      'caches the catalog per workspace until the account changes',
      () async {
        await commands.catalog('ws-1');
        await commands.catalog('ws-1');
        expect(repository.capabilityCatalogCalls, ['ws-1']);
        commands.clear();
        await commands.catalog('ws-1');
        expect(repository.capabilityCatalogCalls, ['ws-1', 'ws-1']);

        repository.capabilityCatalogError = StateError('offline');
        await expectLater(commands.catalog('ws-2'), throwsStateError);
        repository.capabilityCatalogError = null;
        await commands.catalog('ws-2');
        expect(repository.capabilityCatalogCalls.last, 'ws-2');
      },
    );

    test('loads draft defaults once; none means an empty selection', () async {
      repository.defaultPluginSelections = kept;
      expect(commands.knownDraftDefaults('ws-1'), isNull);
      expect(await commands.draftDefaults('ws-1'), kept);
      expect(await commands.draftDefaults('ws-1'), kept);
      expect(repository.invocableCalls, hasLength(1));
      expect(commands.knownDraftDefaults('ws-1'), kept);

      repository.defaultPluginSelections = null;
      expect(await commands.draftDefaults('ws-2'), isEmpty);

      repository.invocablesError = StateError('offline');
      await expectLater(commands.draftDefaults('ws-3'), throwsStateError);
      expect(commands.knownDraftDefaults('ws-3'), isNull);
    });
  });
}
