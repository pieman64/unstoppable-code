import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';

void main() {
  group('ChatMessage', () {
    test('is streaming only while status is streaming', () {
      const streaming = ChatMessage(
        messageId: 'm1',
        chatId: 'c1',
        role: ChatRole.assistant,
        status: ChatMessageStatus.streaming,
        text: 'partial',
      );
      const done = ChatMessage(
        messageId: 'm2',
        chatId: 'c1',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: 'done',
      );
      expect(streaming.isStreaming, isTrue);
      expect(done.isStreaming, isFalse);
      expect(done.parts, isEmpty);
    });
  });

  group('ChatWatcherFiredInfo', () {
    const merged = {
      'kind': 'Multiple watchers fired (2)',
      'combinedWatchers': [
        {'kind': 'Pipeline completion (Deploy)', 'text': 'Deploy finished.'},
        {'kind': 'Chat completion: Notes', 'text': 'Notes finished.'},
      ],
    };

    test('parses a single and a merged marker', () {
      final single = ChatWatcherFiredInfo.fromJsonOrNull({
        'kind': 'Pipeline completion (Deploy)',
      });
      expect(single?.kind, 'Pipeline completion (Deploy)');
      expect(single?.combinedWatchers, isNull);
      expect(single?.isMerged, isFalse);

      final parsed = ChatWatcherFiredInfo.fromJsonOrNull(merged);
      expect(parsed?.kind, 'Multiple watchers fired (2)');
      expect(parsed?.isMerged, isTrue);
      expect(
        [
          for (final entry in parsed!.combinedWatchers!)
            (entry.kind, entry.text),
        ],
        [
          ('Pipeline completion (Deploy)', 'Deploy finished.'),
          ('Chat completion: Notes', 'Notes finished.'),
        ],
      );
    });

    test('an empty merged list is not merged', () {
      final parsed = ChatWatcherFiredInfo.fromJsonOrNull({
        'kind': 'Pipeline completion (Deploy)',
        'combinedWatchers': <Object>[],
      });
      expect(parsed?.combinedWatchers, isEmpty);
      expect(parsed?.isMerged, isFalse);
    });

    test('rejects malformed markers whole, as the protocol parser does', () {
      for (final value in <Object?>[
        null,
        'Pipeline completion',
        <String, dynamic>{},
        {'kind': 42},
        {'kind': 'Deploy', 'combinedWatchers': null},
        {'kind': 'Deploy', 'combinedWatchers': 'one'},
        {
          'kind': 'Multiple watchers fired (2)',
          'combinedWatchers': [
            {'kind': 'Deploy', 'text': 'ok'},
            {'kind': 'Notes'},
          ],
        },
        {
          'kind': 'Multiple watchers fired (1)',
          'combinedWatchers': ['Deploy'],
        },
      ]) {
        expect(
          ChatWatcherFiredInfo.fromJsonOrNull(value),
          isNull,
          reason: '$value',
        );
      }
    });

    test(
      'read prefers a valid top-level marker over the prompt_source part',
      () {
        final parts = [
          const ChatPart(
            kind: 'prompt_source',
            data: {
              'source': 'automated',
              'watcherFired': {'kind': 'From part'},
            },
          ),
        ];
        expect(
          ChatWatcherFiredInfo.read({'kind': 'From top level'}, parts)?.kind,
          'From top level',
        );
        // A malformed top-level marker falls back to the cached part.
        expect(
          ChatWatcherFiredInfo.read({'kind': 1}, parts)?.kind,
          'From part',
        );
        expect(ChatWatcherFiredInfo.read(null, parts)?.kind, 'From part');
      },
    );

    test('read finds nothing without a valid marker', () {
      expect(ChatWatcherFiredInfo.read(null, const []), isNull);
      expect(
        ChatWatcherFiredInfo.read(null, const [
          ChatPart(kind: 'prompt_source', data: {'source': 'automated'}),
          ChatPart(
            kind: 'tool_use',
            data: {
              'watcherFired': {'kind': 'Not a prompt_source part'},
            },
          ),
          ChatPart(
            kind: 'prompt_source',
            data: {
              'watcherFired': {'kind': 3},
            },
          ),
        ]),
        isNull,
      );
    });

    test('toJson round-trips through fromJsonOrNull', () {
      for (final json in [
        {'kind': 'Pipeline completion (Deploy)'},
        merged,
      ]) {
        final parsed = ChatWatcherFiredInfo.fromJsonOrNull(json)!;
        expect(parsed.toJson(), json);
      }
    });
  });
  group('ChatPart', () {
    test('exposes tool metadata from data', () {
      final part = ChatPart.fromJson({
        'kind': 'tool_use',
        'toolFamily': 'bash',
        'data': {'toolUseId': 't1', 'name': 'Bash', 'input': 'ls'},
      });
      expect(part.kind, 'tool_use');
      expect(part.toolUseId, 't1');
      expect(part.toolName, 'Bash');
      expect(part.toolInput, 'ls');
      expect(part.displayLabel, 'Bash');
    });

    test('degrades unknown kinds without dropping them', () {
      final part = ChatPart.fromJson({'kind': 'mystery'});
      expect(part.kind, 'mystery');
      expect(part.displayLabel, 'mystery');
    });
  });

  group('ModelOption', () {
    test('parses picker catalog fields and tolerates older hosts', () {
      final current = ModelOption.fromJson({
        'id': 'deepseek',
        'label': 'DeepSeek',
        'provider': 'codex',
        'source': 'ai-gateway',
        'harness': 'codex',
        'vendor': 'deepseek',
        'family': 'deepseek',
        'familyLabel': 'DeepSeek',
        'contextWindow': 128000,
        'sortOrder': 40,
        'showMoreOnly': true,
        'unavailableReason': 'base_model_unavailable',
      });
      expect(current.source, 'ai-gateway');
      expect(current.harness, 'codex');
      expect(current.family, 'deepseek');
      expect(current.familyLabel, 'DeepSeek');
      expect(current.contextWindow, 128000);
      expect(current.sortOrder, 40);
      expect(current.showMoreOnly, isTrue);
      expect(current.unavailableReason, 'base_model_unavailable');

      final older = ModelOption.fromJson({
        'id': 'claude-sonnet',
        'provider': 'claude',
        'contextWindow': -1,
        'sortOrder': 'first',
      });
      expect(older.showMoreOnly, isFalse);
      expect(older.source, isNull);
      expect(older.contextWindow, isNull);
      expect(older.sortOrder, isNull);
    });

    test('parses supportsFastMode and leaves it null when absent', () {
      final fast = ModelOption.fromJson({
        'id': 'm-fast',
        'label': 'Fast',
        'provider': 'claude',
        'supportsFastMode': true,
      });
      final legacy = ModelOption.fromJson({
        'id': 'm-legacy',
        'label': 'Legacy',
        'provider': 'claude',
      });
      expect(fast.supportsFastMode, isTrue);
      expect(legacy.supportsFastMode, isNull);
    });
  });

  group('ProviderAvailability', () {
    test('fails closed only for cursor', () {
      const unknown = ProviderAvailability();
      expect(unknown.isAvailable('claude'), isTrue);
      expect(unknown.isAvailable('cursor'), isFalse);
    });

    test('parses the optional Copilot connection', () {
      bool copilot(Map<String, dynamic> json) =>
          ProviderAvailability.fromJson(json).isAvailable('copilot');
      expect(copilot(const {}), isFalse);
      expect(copilot(const {'copilot': true}), isTrue);
      expect(copilot(const {'copilot': false}), isFalse);
    });
  });

  group('AskUserQuestionState', () {
    test('parses questions, answers, and redaction-safe fields', () {
      final state = AskUserQuestionState.fromJson(const {
        'requestId': 'req-1',
        'toolUseId': 'tool-1',
        'answered': true,
        'questions': [
          {
            'id': 'q-1',
            'header': 'Deploy',
            'question': 'Ship to prod?',
            'options': ['Yes', 'No'],
            'multiSelect': true,
            'optionDescriptions': ['Ship it', 'Hold off'],
            'allowOther': true,
            'secret': true,
          },
        ],
        'answers': [
          {
            'questionId': 'q-1',
            'question': 'Ship to prod?',
            'selectedOptions': ['Yes'],
            'freeformText': '[hidden]',
          },
        ],
      });
      expect(state.requestId, 'req-1');
      expect(state.toolUseId, 'tool-1');
      expect(state.answered, isTrue);
      final question = state.questions.single;
      expect(question.id, 'q-1');
      expect(question.header, 'Deploy');
      expect(question.question, 'Ship to prod?');
      expect(question.options, ['Yes', 'No']);
      expect(question.multiSelect, isTrue);
      expect(question.optionDescriptions, ['Ship it', 'Hold off']);
      expect(question.allowOther, isTrue);
      expect(question.secret, isTrue);
      final answer = state.answers.single;
      expect(answer.questionId, 'q-1');
      expect(answer.selectedOptions, ['Yes']);
      expect(answer.freeformText, '[hidden]');
    });

    test('allows Other when allowOther is omitted unless explicitly false', () {
      final omitted = AskUserQuestion.fromJson(const {
        'question': 'Pick one',
        'options': ['A'],
      });
      final disabled = AskUserQuestion.fromJson(const {
        'question': 'Pick one',
        'options': ['A'],
        'allowOther': false,
      });

      expect(omitted.allowOther, isTrue);
      expect(disabled.allowOther, isFalse);
    });

    test('answer toJson omits null questionId and freeformText', () {
      const answer = AskUserQuestionAnswer(
        question: 'Ship to prod?',
        selectedOptions: ['Yes'],
      );
      expect(answer.toJson(), {
        'question': 'Ship to prod?',
        'selectedOptions': ['Yes'],
      });
    });

    test('listOrNullFromJson distinguishes absent from empty', () {
      expect(AskUserQuestionState.listOrNullFromJson(null), isNull);
      expect(AskUserQuestionState.listOrNullFromJson(const []), isEmpty);
    });
  });
}
