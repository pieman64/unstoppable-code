import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';

void main() {
  test('continuation marker is optional and requires a boolean true', () {
    for (final value in [true, false, null, 'true', 1]) {
      expect(
        RemoteChatMessage.fromWireJson({'continuesTurn': value}).continuesTurn,
        value == true,
      );
      expect(
        RemoteChatMessage.fromViewJson({'continuesTurn': value}).continuesTurn,
        value == true,
      );
    }
    expect(RemoteChatMessage.fromWireJson({}).continuesTurn, isFalse);
    expect(RemoteChatMessage.fromViewJson({}).continuesTurn, isFalse);
  });

  test(
    'summary preserves explicit turn state and older-host unknown state',
    () {
      for (final value in [true, false, null]) {
        final summary = RemoteChatSummary.fromJson({
          'chatId': 'chat-a',
          'title': 'Chat',
          'turnActive': value,
        });
        expect(summary.turnActive, value);
        final inherited = summary.inheritPendingQuestions(
          const RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            title: 'Chat',
            pendingQuestions: [],
          ),
        );
        expect(inherited.turnActive, value);
      }
      expect(RemoteChatSummary.fromJson({'chatId': 'old'}).turnActive, isNull);
    },
  );

  test('summary parses a finite non-negative active-turn duration', () {
    final summary = RemoteChatSummary.fromJson({
      'chatId': 'chat-a',
      'turnElapsedMs': 550000,
    });
    expect(summary.turnElapsedMs, 550000);
    expect(
      summary
          .inheritPendingQuestions(
            const RemoteChatSummary(
              chatId: 'chat-a',
              scope: RemoteChatScope.worktree,
              title: 'Chat',
              pendingQuestions: [],
            ),
          )
          .turnElapsedMs,
      550000,
    );

    for (final invalid in [-1, double.nan, double.infinity, '550000']) {
      expect(
        RemoteChatSummary.fromJson({
          'chatId': 'chat-a',
          'turnElapsedMs': invalid,
        }).turnElapsedMs,
        isNull,
      );
    }
  });

  group('RemoteChatSummary background counts (CAN-5253)', () {
    test('an older desktop sends none, so they stay null', () {
      final summary = RemoteChatSummary.fromJson({'chatId': 'chat-a'});

      expect(summary.backgroundTasks, isNull);
      expect(summary.backgroundDelegations, isNull);
      expect(summary.turnPhase, isNull);
    });

    test('parses the counts and turn phase, zero included', () {
      final summary = RemoteChatSummary.fromJson({
        'chatId': 'chat-a',
        'turnPhase': 'background',
        'backgroundTasks': 3,
        'backgroundDelegations': 1,
      });

      expect(summary.turnPhase, RemoteChatTurnPhase.background);
      expect(summary.backgroundTasks, 3);
      expect(summary.backgroundDelegations, 1);

      final cleared = RemoteChatSummary.fromJson({
        'chatId': 'chat-a',
        'turnPhase': 'idle',
        'backgroundTasks': 0,
        'backgroundDelegations': 0,
      });
      expect(cleared.turnPhase, RemoteChatTurnPhase.idle);
      expect(cleared.backgroundTasks, 0);
      expect(cleared.backgroundDelegations, 0);
      expect(
        RemoteChatSummary.fromJson({
          'chatId': 'chat-a',
          'turnPhase': 'foreground',
        }).turnPhase,
        RemoteChatTurnPhase.foreground,
      );
    });

    test('malformed counts and unknown phases read as not sent', () {
      for (final invalid in [-1, double.nan, double.infinity, '2', true]) {
        final summary = RemoteChatSummary.fromJson({
          'chatId': 'chat-a',
          'backgroundTasks': invalid,
          'backgroundDelegations': invalid,
        });
        expect(summary.backgroundTasks, isNull, reason: '$invalid');
        expect(summary.backgroundDelegations, isNull, reason: '$invalid');
      }
      expect(
        RemoteChatSummary.fromJson({
          'chatId': 'chat-a',
          'turnPhase': 'paused',
        }).turnPhase,
        isNull,
      );
    });

    test('the copies keep them', () {
      final summary = RemoteChatSummary.fromJson({
        'chatId': 'chat-a',
        'turnPhase': 'background',
        'backgroundTasks': 2,
        'backgroundDelegations': 1,
      });
      final copies = [
        summary.withUnread(true),
        summary.inheritPendingQuestions(
          const RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            title: 'Chat',
            pendingQuestions: [],
          ),
        ),
      ];

      for (final copy in copies) {
        expect(copy.turnPhase, RemoteChatTurnPhase.background);
        expect(copy.backgroundTasks, 2);
        expect(copy.backgroundDelegations, 1);
      }
    });
  });

  group('RemoteChatMessage.fromWireJson', () {
    test('parses a live PortalChatMessage payload', () {
      final message = RemoteChatMessage.fromWireJson({
        'messageId': 'msg-1',
        'chatId': 'chat-1',
        'role': 'assistant',
        'status': 'streaming',
        'text': 'Working on it…',
        'parts': [
          {
            'kind': 'tool_use',
            'toolFamily': 'bash',
            'data': {'name': 'Bash'},
          },
          {'kind': 'thinking'},
        ],
        'createdAtMs': 1752600000000,
        'updatedAtMs': 1752600001000,
      });

      expect(
        message.updatedAt,
        DateTime.fromMillisecondsSinceEpoch(1752600001000),
      );
      expect(message.withAttachments(const []).updatedAt, message.updatedAt);
      expect(message.messageId, 'msg-1');
      expect(message.chatId, 'chat-1');
      expect(message.role, ChatRole.assistant);
      expect(message.status, ChatMessageStatus.streaming);
      expect(message.isStreaming, isTrue);
      expect(message.text, 'Working on it…');
      expect(message.parts, hasLength(2));
      expect(message.parts.first.kind, 'tool_use');
      expect(message.parts.first.toolFamily, 'bash');
      expect(message.parts.first.displayLabel, 'Bash');
      expect(message.parts.last.displayLabel, 'thinking');
      expect(
        message.occurredAt,
        DateTime.fromMillisecondsSinceEpoch(1752600000000),
      );
    });

    test('tolerates missing/unknown fields', () {
      final message = RemoteChatMessage.fromWireJson({
        'messageId': 'msg-2',
        'chatId': 'chat-1',
        'role': 'narrator',
        'status': 'brand-new-status',
      });

      expect(message.role, isNull);
      expect(message.status, isNull);
      expect(message.isStreaming, isFalse);
      expect(message.text, '');
      expect(message.parts, isEmpty);
      expect(message.occurredAt, isNull);
    });

    test('zero update time falls back to the creation timestamp', () {
      final message = RemoteChatMessage.fromWireJson({
        'createdAtMs': 1000,
        'updatedAtMs': 0,
      });
      expect(message.updatedAt, isNull);
      expect(message.occurredAt, DateTime.fromMillisecondsSinceEpoch(1000));
    });

    test('tolerates out-of-range and non-finite timestamps', () {
      for (final createdAtMs in [8640000000000001, double.infinity]) {
        final message = RemoteChatMessage.fromWireJson({
          'messageId': 'msg-invalid-time',
          'chatId': 'chat-1',
          'createdAtMs': createdAtMs,
        });

        expect(message.occurredAt, isNull);
      }
    });
  });

  group('RemoteChatMessage watcher marker', () {
    const notice =
        'Canopy watcher fired.\nWorktree pipeline completion: Deploy';
    const marker = {'kind': 'Pipeline completion (Deploy)'};
    Map<String, dynamic> promptSource(Object? watcherFired) => {
      'kind': 'prompt_source',
      'data': {'source': 'automated', 'watcherFired': watcherFired},
    };

    test('a live row reads the top-level marker before its part', () {
      final message = RemoteChatMessage.fromWireJson({
        'messageId': 'w-1',
        'chatId': 'chat-1',
        'role': 'user',
        'status': 'complete',
        'text': notice,
        'watcherFired': marker,
        'parts': [
          promptSource({'kind': 'Stale part kind'}),
        ],
      });
      expect(message.watcherFired?.kind, 'Pipeline completion (Deploy)');
      expect(message.text, notice);
    });

    test('a malformed top-level marker falls back to the part', () {
      final message = RemoteChatMessage.fromWireJson({
        'messageId': 'w-2',
        'chatId': 'chat-1',
        'role': 'user',
        'text': notice,
        'watcherFired': {'kind': 7},
        'parts': [promptSource(marker)],
      });
      expect(message.watcherFired?.kind, 'Pipeline completion (Deploy)');
    });

    test('a state row reads the marker cached history keeps in its part', () {
      final message = RemoteChatMessage.fromViewJson({
        'localChatId': 'chat-1',
        'localMessageId': 'w-3',
        'role': 'user',
        'status': 'complete',
        'content': notice,
        'parts': [
          promptSource({
            'kind': 'Multiple watchers fired (2)',
            'combinedWatchers': [
              {'kind': 'Deploy', 'text': 'one'},
              {'kind': 'Notes', 'text': 'two'},
            ],
          }),
        ],
      });
      expect(message.watcherFired?.kind, 'Multiple watchers fired (2)');
      expect(message.watcherFired?.combinedWatchers, hasLength(2));
    });

    test('an older desktop without the marker keeps a plain row', () {
      // CAN-4431 added the marker; text alone never attributes a watcher.
      final live = RemoteChatMessage.fromWireJson({
        'messageId': 'old-1',
        'chatId': 'chat-1',
        'role': 'user',
        'text': notice,
        'promptSource': 'automated',
      });
      final view = RemoteChatMessage.fromViewJson({
        'localChatId': 'chat-1',
        'localMessageId': 'old-2',
        'role': 'user',
        'content': notice,
        'parts': [
          {
            'kind': 'prompt_source',
            'data': {'source': 'automated'},
          },
        ],
      });
      expect(live.watcherFired, isNull);
      expect(view.watcherFired, isNull);
    });

    test('copy helpers keep the marker', () {
      final message = RemoteChatMessage.fromWireJson({
        'messageId': 'w-4',
        'chatId': 'chat-1',
        'role': 'user',
        'text': notice,
        'watcherFired': marker,
        'createdAtMs': 1000,
      });
      final copies = [
        message.withAttachments(const []),
        message.withOrderingAt(DateTime(2026)),
        message.withUpdatedAt(DateTime(2026)),
        message.withOrderingAt(DateTime(2026)).withUpdatedAt(null),
      ];
      for (final copy in copies) {
        expect(copy.watcherFired, same(message.watcherFired));
      }
    });
  });
  group('RemoteChatMessage.fromViewJson', () {
    test('parses a PortalChatMessageView state row', () {
      final message = RemoteChatMessage.fromViewJson({
        'scope': 'worktree',
        'localChatId': 'chat-1',
        'localMessageId': 'msg-3',
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
        'role': 'user',
        'status': 'complete',
        'content': 'Please fix the flaky test',
        'occurredAt': '2026-07-16T10:00:00.000Z',
      });

      expect(message.updatedAt, isNull);
      expect(message.messageId, 'msg-3');
      expect(message.chatId, 'chat-1');
      expect(message.role, ChatRole.user);
      expect(message.status, ChatMessageStatus.complete);
      expect(message.text, 'Please fix the flaky test');
      expect(message.occurredAt, DateTime.parse('2026-07-16T10:00:00.000Z'));
    });

    test('tolerates a malformed occurredAt', () {
      final message = RemoteChatMessage.fromViewJson({
        'localChatId': 'chat-1',
        'localMessageId': 'msg-4',
        'role': 'assistant',
        'status': 'complete',
        'content': 'Done.',
        'occurredAt': 'not-a-date',
      });

      expect(message.occurredAt, isNull);
    });
  });

  group('RemoteChatSummary.fromJson', () {
    test('parses a worktree chat summary entity', () {
      final summary = RemoteChatSummary.fromJson({
        'localId': 'chat-1',
        'chatId': 'chat-1',
        'scope': 'worktree',
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
        'title': 'Fix flaky test',
        'order': 2,
        'createdAt': '2026-07-15T09:00:00Z',
        'lastMessageAt': '2026-07-16T10:00:00Z',
        'modelLabel': 'Claude Sonnet 4.5',
        'providerType': 'claude',
        'active': true,
      });

      expect(summary.chatId, 'chat-1');
      expect(summary.scope, RemoteChatScope.worktree);
      expect(summary.workspaceLocalId, 'ws-1');
      expect(summary.worktreeLocalId, 'wt-1');
      expect(summary.title, 'Fix flaky test');
      expect(summary.order, 2);
      expect(summary.providerType, 'claude');
      expect(summary.active, isTrue);
    });

    test('display title matches desktop null fallback semantics', () {
      for (final description in [null, '', 'Desktop label']) {
        final summary = RemoteChatSummary.fromJson({
          'chatId': 'chat-1',
          'title': 'Original title',
          'description': description,
        });
        expect(summary.title, 'Original title');
        expect(summary.description, description);
        expect(summary.displayTitle, description ?? 'Original title');
        final previous = RemoteChatSummary.fromJson({
          'chatId': 'chat-1',
          'pendingQuestions': [],
        });
        expect(
          summary.inheritPendingQuestions(previous).description,
          description,
        );
      }
    });

    test('retains per-chat turn state while inheriting pending questions', () {
      final previous = RemoteChatSummary.fromJson({
        'chatId': 'chat-1',
        'pendingQuestions': [],
      });
      for (final value in [true, false, null]) {
        final summary = RemoteChatSummary.fromJson({
          'chatId': 'chat-1',
          'turnActive': ?value,
        });
        expect(summary.turnActive, value);
        expect(summary.inheritPendingQuestions(previous).turnActive, value);
      }
    });

    test('falls back to a default title', () {
      final summary = RemoteChatSummary.fromJson({'chatId': 'chat-2'});
      expect(summary.title, 'Untitled chat');
      expect(summary.scope, isNull);
      expect(summary.order, isNull);
    });

    test('parses the projected composer state and model catalog', () {
      final summary = RemoteChatSummary.fromJson({
        'chatId': 'chat-1',
        'title': 'Fix flaky test',
        'providerType': 'codex',
        'model': 'gpt-5-codex',
        'planMode': true,
        'thinkingLevel': 'high',
        'fastMode': true,
        'providerAvailability': {'claude': true, 'codex': false},
        'availableModels': [
          {
            'id': 'claude-sonnet',
            'label': 'Claude Sonnet 4.5',
            'provider': 'claude',
            'kind': 'model',
            'available': true,
          },
          {
            'id': 'gpt-5-codex',
            'label': 'GPT-5 Codex',
            'provider': 'codex',
            'kind': 'model',
            'available': true,
          },
        ],
      });

      expect(summary.model, 'gpt-5-codex');
      expect(summary.planMode, isTrue);
      expect(summary.thinkingLevel, 'high');
      expect(summary.fastMode, isTrue);
      // Present keys reflect the last observed native login…
      expect(summary.providerAvailability?.isAvailable('codex'), isFalse);
      // …an omitted key is "unknown" and treated optimistically.
      expect(summary.providerAvailability?.isAvailable('ollama'), isTrue);
      // Cursor is the one exception: unlike the native-auth providers above,
      // an omitted/unknown `cursor` key fails closed — the managed runtime
      // must be explicitly confirmed before a remote send can succeed.
      expect(summary.providerAvailability?.isAvailable('cursor'), isFalse);
      expect(summary.availableModels.map((m) => m.id), [
        'claude-sonnet',
        'gpt-5-codex',
      ]);
      expect(summary.availableModels.first.provider, 'claude');
      expect(summary.availableModels.first.available, isTrue);
      expect(summary.modelCatalogProjected, isTrue);
    });

    test('distinguishes an omitted model catalog from an empty one', () {
      // The desktop omits `availableModels` entirely when no portal client is
      // active, so "absent" must not be read as "no models are permitted" —
      // only an explicitly projected array is authoritative.
      final omitted = RemoteChatSummary.fromJson({
        'chatId': 'chat-1',
        'scope': 'worktree',
        'title': 'No catalog on the wire',
      });
      expect(omitted.availableModels, isEmpty);
      expect(omitted.modelCatalogProjected, isFalse);

      final projectedEmpty = RemoteChatSummary.fromJson({
        'chatId': 'chat-1',
        'scope': 'worktree',
        'title': 'Every model blocked',
        'availableModels': <Object?>[],
      });
      expect(projectedEmpty.availableModels, isEmpty);
      expect(projectedEmpty.modelCatalogProjected, isTrue);
    });

    test(
      'ProviderAvailability fails closed for Cursor but stays optimistic for native-auth providers',
      () {
        // Regression coverage (CAN-3624): before this PR, no Cursor rows
        // were ever projected to mobile, so `isAvailable('cursor')` falling
        // through the generic `_ => true` default was unreachable. This PR
        // makes mobile the second first-party consumer of the wire contract,
        // so an unknown/omitted `cursor` key must fail closed — unlike
        // claude/codex/ollama, which keep their optimistic default.
        const emptyAvailability = ProviderAvailability();
        expect(emptyAvailability.isAvailable('cursor'), isFalse);
        expect(emptyAvailability.isAvailable('claude'), isTrue);
        expect(emptyAvailability.isAvailable('codex'), isTrue);
        expect(emptyAvailability.isAvailable('ollama'), isTrue);

        final connected = ProviderAvailability.fromJson({'cursor': true});
        expect(connected.isAvailable('cursor'), isTrue);

        final disconnected = ProviderAvailability.fromJson({'cursor': false});
        expect(disconnected.isAvailable('cursor'), isFalse);
      },
    );

    test('model options preserve extra-charge warnings', () {
      final option = ModelOption.fromJson({
        'id': 'premium-model',
        'label': 'Premium Model',
        'provider': 'claude',
        'extraChargeOnly': true,
        'extraChargeMessage': 'Uses AI Credits.',
      });

      expect(option.extraChargeOnly, isTrue);
      expect(option.extraChargeMessage, 'Uses AI Credits.');
    });

    test('model options carry the catalog description when the host sends '
        'one, and null when it does not', () {
      final described = ModelOption.fromJson({
        'id': 'claude-sonnet',
        'label': 'Claude Sonnet 4.5',
        'provider': 'claude',
        'description': 'Balanced speed and capability.',
      });
      expect(described.description, 'Balanced speed and capability.');

      // An older desktop that predates the projection's `description` field
      // must keep parsing unchanged.
      final plain = ModelOption.fromJson({
        'id': 'claude-sonnet',
        'label': 'Claude Sonnet 4.5',
        'provider': 'claude',
      });
      expect(plain.description, isNull);
    });

    test('model options parse projected thinking levels, dropping unknown '
        'entries, and stay null when the host omits them', () {
      final projected = ModelOption.fromJson({
        'id': 'claude-sonnet',
        'label': 'Claude Sonnet 4.5',
        'provider': 'claude',
        'thinkingLevels': ['off', 'medium', 'turbo', 'ultra', 42],
      });
      expect(projected.thinkingLevels, ['off', 'medium', 'ultra']);

      // An older desktop that predates CAN-2441 must keep parsing unchanged;
      // null means "fall back to the provider-level cycle".
      final legacy = ModelOption.fromJson({
        'id': 'claude-sonnet',
        'label': 'Claude Sonnet 4.5',
        'provider': 'claude',
      });
      expect(legacy.thinkingLevels, isNull);
      expect(legacy.isDefault, isFalse);
    });

    test('model options carry the default-model flag', () {
      final option = ModelOption.fromJson({
        'id': 'claude-fable-5',
        'label': 'Fable 5',
        'provider': 'claude',
        'isDefault': true,
      });
      expect(option.isDefault, isTrue);
    });

    test('parses the exact speed and keeps it through reconstruction', () {
      for (final (value, expected) in const [
        ('ultrafast', 'ultrafast'),
        ('fast', 'fast'),
        ('standard', 'standard'),
        ('warp', null),
        (7, null),
      ]) {
        final summary = RemoteChatSummary.fromJson({
          'chatId': 'chat-1',
          'speed': value,
          'fastMode': false,
          'queuedMessages': <Object>[],
        });
        expect(summary.speed, expected, reason: '$value');
        expect(summary.withUnread(true).speed, expected);
        expect(
          RemoteChatSummary.fromJson({
            'chatId': 'chat-1',
          }).inheritPendingQuestions(summary).speed,
          isNull,
          reason: 'a newer projection without speed is an older host',
        );
        expect(
          summary
              .inheritPendingQuestions(
                RemoteChatSummary.fromJson({
                  'chatId': 'chat-1',
                  'pendingQuestions': <Object>[],
                }),
              )
              .speed,
          expected,
        );
      }
    });

    test('composer state is absent by default', () {
      final summary = RemoteChatSummary.fromJson({'chatId': 'chat-3'});
      expect(summary.model, isNull);
      expect(summary.planMode, isNull);
      expect(summary.thinkingLevel, isNull);
      expect(summary.fastMode, isNull);
      expect(summary.speed, isNull);
      expect(summary.providerAvailability, isNull);
      expect(summary.availableModels, isEmpty);
      expect(summary.modelCatalogProjected, isFalse);
    });
  });

  group('RemoteChatSendResult.fromJson', () {
    test('parses a submit response with an echoed chatId', () {
      final result = RemoteChatSendResult.fromJson({
        'commandId': 'cmd-1',
        'queuedWhileReconnecting': true,
        'chatId': 'chat-9',
      });

      expect(result.commandId, 'cmd-1');
      expect(result.chatId, 'chat-9');
      expect(result.queuedWhileReconnecting, isTrue);
    });

    test('defaults queuedWhileReconnecting to false', () {
      final result = RemoteChatSendResult.fromJson({'commandId': 'cmd-2'});
      expect(result.chatId, isNull);
      expect(result.queuedWhileReconnecting, isFalse);
    });
  });

  group('RemoteChatSummary pendingQuestions', () {
    RemoteChatSummary summary(Map<String, dynamic> extra) =>
        RemoteChatSummary.fromJson({
          'chatId': 'chat-1',
          'scope': 'worktree',
          'title': 'Chat',
          ...extra,
        });

    test('parses pendingQuestions when present', () {
      final parsed = summary({
        'pendingQuestions': [
          {
            'requestId': 'req-1',
            'answered': false,
            'questions': [
              {
                'question': 'Pick one',
                'options': ['A'],
              },
            ],
          },
        ],
      });
      expect(parsed.pendingQuestions, hasLength(1));
      expect(parsed.pendingQuestions?.single.requestId, 'req-1');
    });

    test('absent pendingQuestions parses to null, [] parses to empty', () {
      expect(summary(const {}).pendingQuestions, isNull);
      expect(summary({'pendingQuestions': const []}).pendingQuestions, isEmpty);
    });

    test('inheritPendingQuestions preserves cached state on omission only', () {
      final cached = summary({
        'pendingQuestions': [
          {'requestId': 'req-1', 'answered': false, 'questions': const []},
        ],
      });
      final omitted = summary(const {});
      final cleared = summary({'pendingQuestions': const []});
      expect(
        omitted.inheritPendingQuestions(cached).pendingQuestions,
        hasLength(1),
      );
      expect(cleared.inheritPendingQuestions(cached).pendingQuestions, isEmpty);
      expect(omitted.inheritPendingQuestions(null).pendingQuestions, isNull);
    });
  });

  group('RemoteChatSummary queuedMessages', () {
    RemoteChatSummary summary(Map<String, dynamic> extra) =>
        RemoteChatSummary.fromJson({
          'chatId': 'chat-1',
          'scope': 'worktree',
          'title': 'Chat',
          ...extra,
        });

    test('parses the host queue in FIFO order', () {
      final parsed = summary({
        'queuedMessages': [
          {
            'id': 'queue-1',
            'text': 'First',
            'origin': 'portal',
            'enqueuedAtMs': 10,
          },
          {
            'id': 'queue-2',
            'text': 'Second',
            'origin': 'desktop',
            'enqueuedAtMs': 20,
          },
        ],
      });

      expect(parsed.queuedMessages?.map((message) => message.id), [
        'queue-1',
        'queue-2',
      ]);
      expect(parsed.queuedMessages?.first.text, 'First');
      expect(parsed.queuedMessages?.last.origin, 'desktop');
    });

    test('preserves a cached queue on omission and clears it with []', () {
      final cached = summary({
        'queuedMessages': [
          {
            'id': 'queue-1',
            'text': 'Queued',
            'origin': 'portal',
            'enqueuedAtMs': 10,
          },
        ],
      });
      final omitted = summary(const {});
      final cleared = summary({'queuedMessages': const []});

      expect(
        omitted.inheritPendingQuestions(cached).queuedMessages,
        hasLength(1),
      );
      expect(cleared.inheritPendingQuestions(cached).queuedMessages, isEmpty);
      expect(omitted.inheritPendingQuestions(null).queuedMessages, isNull);
    });
  });

  group('attachments', () {
    test('ChatAttachmentRef round-trips the wire shape', () {
      final json = {
        'attachmentId': '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3',
        'filename': 'photo.png',
        'mediaType': 'image/png',
        'size': 2048,
        'contentSha256': 'a' * 64,
        'storageKind': 'blob',
        'source': '/api/v1/portal/sessions/s/attachments/a/content',
      };
      final ref = ChatAttachmentRef.fromJson(json);
      expect(ref.attachmentId, '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3');
      expect(ref.size, 2048);
      expect(ref.toJson(), json);
    });

    test('RemoteChatMessage parses attachments from wire and view shapes', () {
      final wire = RemoteChatMessage.fromWireJson({
        'messageId': 'm',
        'chatId': 'c',
        'role': 'user',
        'status': 'complete',
        'text': 'hi',
        'attachments': [
          {
            'attachmentId': 'path-1',
            'filename': 'notes.md',
            'mediaType': 'text/markdown',
          },
          {'attachmentId': 'bad'},
        ],
      });
      expect(wire.attachments.map((a) => a.filename), ['notes.md']);
      expect(wire.attachments.single.size, isNull);
      final view = RemoteChatMessage.fromViewJson({
        'localMessageId': 'm',
        'localChatId': 'c',
        'role': 'user',
        'status': 'complete',
        'content': 'hi',
        'attachments': [
          {
            'attachmentId': 'a',
            'filename': 'p.png',
            'mediaType': 'image/png',
            'size': 3,
          },
        ],
      });
      expect(view.attachments.single.size, 3);
      expect(
        RemoteChatMessage.fromWireJson({
          'messageId': 'm',
          'chatId': 'c',
        }).attachments,
        isEmpty,
      );
    });

    test('withAttachments copies every other field', () {
      const message = RemoteChatMessage(
        messageId: 'm',
        chatId: 'c',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'hi',
      );
      final patched = message.withAttachments(const [
        ChatMessageAttachment(
          attachmentId: 'a',
          filename: 'f',
          mediaType: 'text/plain',
        ),
      ]);
      expect(patched.text, 'hi');
      expect(patched.attachments.single.attachmentId, 'a');
    });

    test('copy helpers keep the delivery state of a local row', () {
      const message = RemoteChatMessage(
        messageId: 'm',
        chatId: 'c',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'hi',
        delivery: ChatDelivery.notSent,
        deliveryNote: 'Your desktop is offline.',
      );
      final copies = [
        message.withAttachments(const []),
        message.withOrderingAt(DateTime(2026)),
        message.withUpdatedAt(DateTime(2026)),
      ];
      for (final copy in copies) {
        expect(copy.delivery, ChatDelivery.notSent);
        expect(copy.deliveryNote, 'Your desktop is offline.');
      }
    });

    test(
      'RemoteChatSendOptions carries attachments and is non-empty with them',
      () {
        const options = RemoteChatSendOptions(
          attachments: [
            ChatAttachmentRef(
              attachmentId: 'a',
              filename: 'f',
              mediaType: 'text/plain',
              size: 1,
              contentSha256: 'x',
              storageKind: 'blob',
              source: '/s',
            ),
          ],
        );
        expect(options.isEmpty, isFalse);
        expect(options.copyWith(inputMode: 'voice').attachments, hasLength(1));
      },
    );

    test('media type helper mirrors the protocol allowlist', () {
      expect(chatAttachmentMediaTypeForFilename('IMG_1.HEIC'), isNull);
      expect(chatAttachmentMediaTypeForFilename('scan.jpg'), 'image/jpeg');
      expect(
        chatAttachmentMediaTypeForFilename('report.docx'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      expect(kChatAttachmentMediaTypes, contains('application/pdf'));
      expect(kChatAttachmentsMaxPerMessage, 8);
    });
  });

  test('a summary keeps the captured execution harness across copies', () {
    final summary = RemoteChatSummary.fromJson({
      'chatId': 'chat-1',
      'executionHarness': 'claude',
    });
    expect(summary.executionHarness, 'claude');
    expect(summary.withUnread(true).executionHarness, 'claude');
    expect(summary.inheritPendingQuestions(null).executionHarness, 'claude');
    expect(
      RemoteChatSummary.fromJson({'chatId': 'old'}).executionHarness,
      isNull,
    );
  });

  test('a summary keeps Auto routing facts; older hosts read manual', () {
    final summary = RemoteChatSummary.fromJson({
      'chatId': 'chat-1',
      'modelSelectionMode': 'auto',
      'modelRoutingSupported': true,
    });
    for (final copy in [
      summary,
      summary.withUnread(true),
      summary.inheritPendingQuestions(null),
    ]) {
      expect(copy.modelAuto, isTrue);
      expect(copy.modelRoutingSupported, isTrue);
    }
    final old = RemoteChatSummary.fromJson({'chatId': 'old'});
    expect(old.modelAuto, isFalse);
    expect(old.modelRoutingSupported, isFalse);
  });

  test('CAN-3922 keeps the plugin selection detail through copies', () {
    final summary = RemoteChatSummary.fromJson({
      'chatId': 'c1',
      'title': 'Chat',
      'pluginSelectionsDetail': {
        'collectionIds': ['kit'],
        'skillRefs': <Object?>[],
        'pluginRefs': <Object?>[],
      },
    });
    expect(summary.pluginSelectionsDetail?['collectionIds'], ['kit']);
    expect(
      summary.withUnread(true).pluginSelectionsDetail,
      summary.pluginSelectionsDetail,
    );
    final partial = RemoteChatSummary.fromJson({
      'chatId': 'c1',
      'title': 'Chat',
      'pluginSelectionsDetail': {'collectionIds': <Object?>[]},
    });
    expect(
      partial
          .inheritPendingQuestions(summary.withUnread(false))
          .pluginSelectionsDetail,
      {'collectionIds': <Object?>[]},
    );
    expect(
      RemoteChatSummary.fromJson({
        'chatId': 'c1',
        'title': 'Chat',
        'pluginSelectionsDetail': 'bad',
      }).pluginSelectionsDetail,
      isNull,
    );
  });
}
