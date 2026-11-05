import 'package:mobile/data/models/chat_message.dart';
import '../protocol.dart';

/// The tab list and decisions for one subscribed desktop scope.
final class DeviceChatScopeState {
  final tabs = <Map<String, dynamic>>[];
  final runtime = <String, Map<String, dynamic>>{};
  final questions = <Map<String, dynamic>>[];
  final approvals = <Map<String, dynamic>>[];

  void hydrate(Map<String, dynamic> snapshot) {
    final file = deviceLinkObject(snapshot['tabsFile']);
    tabs
      ..clear()
      ..addAll((file['tabs'] as List).map(deviceLinkObject));
    questions
      ..clear()
      ..addAll((file['pendingQuestions'] as List? ?? []).map(deviceLinkObject));
    approvals
      ..clear()
      ..addAll((file['pendingApprovals'] as List? ?? []).map(deviceLinkObject));
    runtime
      ..clear()
      ..addAll({
        for (final entry in deviceLinkObject(
          snapshot['runtimeByChatId'],
        ).entries)
          if (entry.value is Map<String, dynamic>)
            entry.key: deviceLinkObject(entry.value),
      });
  }

  Map<String, dynamic> tab(String id) =>
      tabs.where((t) => t['id'] == id).firstOrNull ?? {};
  List<AskUserQuestionState> pendingQuestions(String id) => [
    for (final question in questions)
      if (question['chatId'] == id &&
          question['answeredAt'] == null &&
          question['dismissedAt'] == null)
        AskUserQuestionState.fromJson(question),
  ];
  bool needsInput(String id) =>
      pendingQuestions(id).isNotEmpty ||
      approvals.any((a) => a['chatId'] == id) ||
      tab(id)['pendingPlanExit'] != null;
  bool running(String id) => const [
    'queued',
    'starting',
    'streaming',
    'awaiting_input',
    'completing',
  ].contains(runtime[id]?['status']);

  void apply(Map<String, dynamic> change) {
    switch (change['type']) {
      case 'tab.created':
      case 'tab.upserted':
        final next = deviceLinkObject(change['tab']);
        final index = tabs.indexWhere((t) => t['id'] == next['id']);
        if (index < 0) {
          tabs.add(next);
        } else {
          tabs[index] = next;
        }
      case 'tab.metadata_patched':
        final index = tabs.indexWhere((t) => t['id'] == change['tabId']);
        if (index >= 0) {
          tabs[index] = {...tabs[index], ...deviceLinkObject(change['patch'])};
        }
      case 'tab.order_changed':
        final ordered = <Map<String, dynamic>>[
          for (final id in (change['tabIds'] as List))
            ...tabs.where((tab) => tab['id'] == id),
          for (final tab in tabs)
            if (!(change['tabIds'] as List).contains(tab['id'])) tab,
        ];
        tabs
          ..clear()
          ..addAll(ordered);
      case 'tab.removed':
        tabs.removeWhere((t) => t['id'] == change['tabId']);
      case 'runtime.patched':
        runtime[deviceLinkString(change, 'chatId')] = deviceLinkObject(
          change['runtime'],
        );
      case 'transcript.updated':
        final index = tabs.indexWhere((tab) => tab['id'] == change['chatId']);
        if (index >= 0) {
          tabs[index] = {
            ...tabs[index],
            'transcript': deviceLinkObject(change['transcript']),
          };
        }
      case 'pending_question.upserted':
        final next = deviceLinkObject(change['question']);
        questions.removeWhere((q) => q['requestId'] == next['requestId']);
        questions.add(next);
      case 'pending_question.removed':
        questions.removeWhere(
          (q) =>
              q['requestId'] == change['requestId'] &&
              q['chatId'] == change['chatId'],
        );
      default:
        break;
    }
  }
}
