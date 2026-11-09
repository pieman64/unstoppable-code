import 'dart:async';
import 'package:mobile/data/models/chat_message.dart';
import '../chats/questions.dart';
import '../chats/dto.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';

/// One computer's live Orchestrator renderer requests. Unknown presentation
/// requests receive a typed refusal immediately, rather than timing out.
final class OrchestratorQuestions implements DeviceChatQuestions {
  OrchestratorQuestions(this.ipc, {DesktopIpc? main}) {
    _subscription = ipc.events.listen((event) => _receive(event, ipc));
    _mainSubscription = main?.events
        .where((event) {
          final payload = event['payload'];
          return payload is Map && payload['surface'] == 'main';
        })
        .listen((event) => _receive(event, main));
  }
  final DesktopIpc ipc;
  StreamSubscription<Map<String, dynamic>>? _mainSubscription;
  late final StreamSubscription<Map<String, dynamic>> _subscription;
  final _updates = StreamController<void>.broadcast();
  final _pending = <(String, String), AskUserQuestionState>{};
  int _generation = 0;
  bool _disposed = false;
  @override
  Stream<void> get updates => _updates.stream;
  @override
  List<AskUserQuestionState> pendingFor(String chatId) => [
    for (final entry in _pending.entries)
      if (entry.key.$1 == chatId) entry.value,
  ];

  void invalidate() {
    _generation++;
    _pending.clear();
    if (!_disposed) _updates.add(null);
  }

  void _receive(Map<String, dynamic> event, DesktopIpc sender) {
    if (_disposed) return;
    if (event['kind'] == 'closed') {
      invalidate();
      return;
    }
    final push = event['payload'];
    if (event['name'] != 'ipc.push' ||
        push is! Map ||
        push['args'] is! List ||
        (push['args'] as List).isEmpty) {
      return;
    }
    final raw = deviceChatDto((push['args'] as List).first);
    if (raw is! Map<String, dynamic> || raw['requestId'] is! String) return;
    final requestId = raw['requestId'] as String;
    if (push['channel'] == 'app-advisor:tool-request-cancelled') {
      final chat = raw['originChatId'];
      _pending.remove((chat, requestId));
      _updates.add(null);
      return;
    }
    if (push['channel'] != 'app-advisor:tool-request') return;
    if (raw['kind'] == 'ask_user_question' &&
        raw['chatId'] is String &&
        raw['question'] is Map<String, dynamic>) {
      _pending.putIfAbsent(
        (raw['chatId'] as String, requestId),
        () => AskUserQuestionState(
          requestId: requestId,
          questions: [
            AskUserQuestion.fromJson(deviceLinkObject(raw['question'])),
          ],
        ),
      );
      _updates.add(null);
    } else {
      final payload = raw['payload'];
      final payloadOrigin = payload is Map ? payload['origin'] : null;
      final origin =
          raw['originChatTabId'] ??
          (payloadOrigin is Map ? payloadOrigin['chatTabId'] : null);
      unawaited(
        sender
            .invoke('app-advisor:tool-response', [
              {
                'requestId': requestId,
                if (origin is String) 'originChatId': origin,
                'ok': false,
                'error': {
                  'code': 'unsupported_action',
                  'message':
                      'This view is unavailable on mobile. Open it on your computer.',
                },
              },
            ])
            .then<void>((_) {}, onError: (Object _) {}),
      );
    }
  }

  Future<void> _respond(
    String chatId,
    String requestId,
    Map<String, dynamic> response,
  ) async {
    final key = (chatId, requestId);
    final question = _pending[key];
    if (question == null) {
      throw const DeviceLinkException(
        'This question is no longer waiting for an answer.',
      );
    }
    final generation = _generation;
    await ipc.invoke('app-advisor:tool-response', [
      {'requestId': requestId, 'originChatId': chatId, ...response},
    ]);
    if (!_disposed &&
        generation == _generation &&
        identical(_pending[key], question)) {
      _pending.remove(key);
      _updates.add(null);
    }
  }

  @override
  Future<void> answer(
    String chatId,
    String requestId,
    List<AskUserQuestionAnswer> answers,
  ) async {
    final question = _pending[(chatId, requestId)]?.questions.single;
    if (question == null || answers.length != 1) {
      throw const DeviceLinkException('Answer the question before continuing.');
    }
    final answer = answers.single;
    await _respond(chatId, requestId, {
      'ok': true,
      'answer': {
        if (question.id != null) 'questionId': question.id,
        'question': question.question,
        'selectedOptions': answer.selectedOptions,
        if (answer.freeformText != null) 'freeformText': answer.freeformText,
      },
    });
  }

  @override
  Future<void> dismiss(String chatId, String requestId) => _respond(
    chatId,
    requestId,
    {
      'ok': false,
      'error': {'code': 'cancelled', 'message': 'User dismissed the question.'},
    },
  );

  Future<void> dispose() async {
    _disposed = true;
    _generation++;
    await _subscription.cancel();
    await _mainSubscription?.cancel();
    _pending.clear();
    await _updates.close();
  }
}
