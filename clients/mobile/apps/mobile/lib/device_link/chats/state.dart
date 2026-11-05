import 'title.dart';
import '../protocol.dart';
import 'models.dart';
import 'scope_state.dart';

/// A projection of one desktop scope and selected chat. Revisions remain
/// desktop-owned; a gap requests a fresh snapshot instead of guessing.
final class DeviceChatState {
  DeviceChatState(this.ref);
  final DeviceChatRef ref;
  int revision = 0, transcriptRevision = 0;
  Map<String, dynamic> tab = {}, runtime = {};
  final messages = <DeviceChatMessage>[];
  int? before;
  int totalMessages = 0;
  bool closed = false;
  final scope = DeviceChatScopeState();
  bool get hasPendingDecision => scope.needsInput(ref.id);
  String get title => deviceChatTitle(tab, fallback: ref.title);
  bool get running => [
    'queued',
    'starting',
    'streaming',
    'awaiting_input',
    'completing',
  ].contains(runtime['status']);
  bool get awaitingInput =>
      runtime['status'] == 'awaiting_input' || hasPendingDecision;
  String? get runtimeError => runtime['error'] is Map
      ? (runtime['error'] as Map)['message'] as String?
      : null;
  void hydrate(Map<String, dynamic> snapshot, Map<String, dynamic> page) {
    revision = snapshot['revision'] as int;
    final tabsFile = deviceLinkObject(snapshot['tabsFile']);
    final tabs = (tabsFile['tabs'] as List).whereType<Map<String, dynamic>>();
    tab = tabs.where((t) => t['id'] == ref.id).firstOrNull ?? {};
    closed = tab.isEmpty || tab['kind'] == 'file' || tab['archivedAt'] != null;
    runtime =
        deviceLinkObject(snapshot['runtimeByChatId'])[ref.id]
            is Map<String, dynamic>
        ? deviceLinkObject(
            deviceLinkObject(snapshot['runtimeByChatId'])[ref.id],
          )
        : {};
    scope.hydrate(snapshot);
    transcriptRevision = (page['transcriptRevision'] as num).toInt();
    before = (page['before'] as num?)?.toInt();
    totalMessages = (page['totalMessages'] as num?)?.toInt() ?? 0;
    messages
      ..clear()
      ..addAll(
        (page['messages'] as List).map(
          (v) => DeviceChatMessage(deviceLinkObject(v)),
        ),
      );
  }

  bool apply(Map<String, dynamic> event) {
    if (!ref.matchesScope(event)) return true;
    final next = event['revision'];
    if (next is! int || event['baseRevision'] is! int) return false;
    if (next <= revision) return true;
    if (event['baseRevision'] != revision) return false;
    final changes = (event['changes'] as List).map(deviceLinkObject).toList();
    final descriptor = changes
        .where(
          (c) => c['type'] == 'transcript.updated' && c['chatId'] == ref.id,
        )
        .lastOrNull;
    final nextTranscript = descriptor?['transcript'] is Map
        ? (descriptor!['transcript'] as Map)['transcriptRevision'] as int?
        : null;
    final applyBodies =
        nextTranscript == null || nextTranscript > transcriptRevision;
    if (changes.any(
      (c) =>
          c['chatId'] == ref.id &&
          (c['type'] == 'messages.omitted' ||
              (applyBodies &&
                  c['type'] == 'transcript.updated' &&
                  c['reset'] == true)),
    )) {
      return false;
    }
    for (final change in changes) {
      if (change['type'] == 'tab.removed' && change['tabId'] == ref.id) {
        closed = true;
      }
      if (change['type'] == 'tab.upserted' &&
          change['tab'] is Map &&
          (change['tab'] as Map)['id'] == ref.id) {
        tab = deviceLinkObject(change['tab']);
      }
      if (change['type'] == 'tab.metadata_patched' &&
          change['tabId'] == ref.id) {
        tab = {...tab, ...deviceLinkObject(change['patch'])};
      }
      scope.apply(change);
      tab = scope.tab(ref.id);
      if (change['chatId'] != ref.id) continue;
      if (change['type'] == 'runtime.patched') {
        runtime = deviceLinkObject(change['runtime']);
      }
      if (!applyBodies) continue;
      switch (change['type']) {
        case 'message.upserted':
          final message = DeviceChatMessage(
            deviceLinkObject(change['message']),
          );
          final index = messages.indexWhere((m) => m.id == message.id);
          if (index >= 0) {
            messages[index] = message;
          } else {
            final after = messages.indexWhere(
              (m) => m.id == change['afterMessageId'],
            );
            if (change['afterMessageId'] != null && after < 0) return false;
            messages.insert(after < 0 ? messages.length : after + 1, message);
            totalMessages++;
          }
        case 'message.removed':
          messages.removeWhere((m) => m.id == change['messageId']);
        case 'messages.replaced':
          messages
            ..clear()
            ..addAll(
              (change['messages'] as List).map(
                (m) => DeviceChatMessage(deviceLinkObject(m)),
              ),
            );
        default:
          break;
      }
    }
    if (nextTranscript != null && nextTranscript > transcriptRevision) {
      transcriptRevision = nextTranscript;
    }
    closed = tab.isEmpty || tab['kind'] == 'file' || tab['archivedAt'] != null;
    revision = next;
    return true;
  }

  bool containsUserMessage(String id) =>
      messages.any((m) => m.id == id && m.role == 'user') ||
      tab['lastAcceptedUserMessageId'] == id ||
      (runtime['queuedMessageIds'] is List &&
          (runtime['queuedMessageIds'] as List).contains(id));
}
