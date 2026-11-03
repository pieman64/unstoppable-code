import 'dart:async';
import 'dart:convert';
import 'package:fake_async/fake_async.dart';
import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';

const idle = CloudChatBootstrap(messages: [], toolActivity: []);
CloudCoreMessage message(
  String id, {
  String? requestId,
  String role = 'USER',
  String text = 'hello',
  int createdAtMs = 100,
}) => CloudCoreMessage(
  id: id,
  clientRequestId: requestId,
  role: role,
  text: text,
  cost: const CloudCoreCost(kind: CloudCoreCostKind.pending),
  costBilledViaLlmProxy: false,
  createdAtMs: createdAtMs,
  artifacts: const [],
);
CloudChatBootstrap live({
  String? cursor = '10',
  String? turn = 'turn',
  String? user = 'user',
}) => CloudChatBootstrap(
  messages: [],
  toolActivity: [],
  activeTurnId: turn,
  activeUserMessageId: user,
  activeStreamAfter: cursor,
);
PostTurnResult accepted(
  String id, {
  String? cursor = '10',
  bool replayed = false,
  String? version,
}) => PostTurnResult(
  message: message('user-$id', requestId: id),
  replayed: replayed,
  streamAfter: cursor,
  capabilityBundleStateVersion: version,
);

class FakeRepository implements CloudChatRepository {
  @override
  Future<ConversationDiscoveryMetadata> discoverConversation(
    String chatId,
  ) async => const ConversationDiscoveryMetadata(
    sessionId: 'old-epoch',
    protocolVersion: 1,
  );
  final bootstraps = <Completer<CloudChatBootstrap>>[];
  final posts =
      <
        ({
          String id,
          String text,
          bool replay,
          List<ChatAttachmentRef> attachments,
          Completer<PostTurnResult> result,
        })
      >[];
  final continuations = <String>[];
  final interrupts = <String>[];
  String epoch = 'new-epoch';
  Object? continueError;
  Object? interruptError;
  AgentTurnInterruptResult interruptResult = const AgentTurnInterruptResult(
    outcome: AgentTurnInterruptOutcome.interruptRequested,
    rawOutcome: 'interrupt_requested',
    turnId: 'turn',
  );
  @override
  Future<CloudChatBootstrap> getMessages(String id) {
    final result = Completer<CloudChatBootstrap>();
    bootstraps.add(result);
    return result.future;
  }

  @override
  Future<PostTurnResult> postMessage(
    String chatId, {
    required String text,
    required String clientRequestId,
    String? modelDefinitionId,
    String? thinkingLevel,
    bool resetThinkingLevel = false,
    bool? fastMode,
    bool replayHint = false,
    List<ChatAttachmentRef> cloudAttachments = const [],
  }) {
    final result = Completer<PostTurnResult>();
    posts.add((
      id: clientRequestId,
      text: text,
      replay: replayHint,
      attachments: cloudAttachments,
      result: result,
    ));
    return result.future;
  }

  @override
  Future<CloudChatStatus> getMessageStatus(String chatId) async =>
      const CloudChatStatus(sourceAgentSessionId: 'old-epoch');
  @override
  Future<CloudChatSummary> continueChat(
    String chatId, {
    required String sourceAgentSessionId,
    bool? fastMode,
  }) async {
    continuations.add(sourceAgentSessionId);
    if (continueError != null) throw continueError!;
    return CloudChatSummary(
      externalId: chatId,
      title: null,
      taskChatExternalId: null,
      modelDefinitionId: null,
      thinkingLevel: null,
      fastMode: fastMode,
      coreAgentSessionId: epoch,
      createdAtMs: 0,
    );
  }

  @override
  Future<AgentTurnInterruptResult> interruptTurn(
    String chatId,
    String turnId,
  ) async {
    interrupts.add(turnId);
    if (interruptError != null) throw interruptError!;
    return interruptResult;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class Harness {
  Harness(this.async, {void Function(String turnKey)? onSuccessfulTurn}) {
    vm = CloudChatViewModel(
      onSuccessfulTurn: onSuccessfulTurn,
      repository: repository,
      now: () => DateTime(2026).add(async.elapsed),
      observeLifecycle: false,
      openStream: (id, {after}) {
        cursors.add(after);
        final controller = StreamController<CloudSseFrame>(
          sync: true,
          onCancel: () {
            cancellations++;
          },
        );
        streams.add(controller);
        return controller.stream;
      },
    );
    vm.open('chat', cursorEpoch: 'old-epoch');
    async.flushMicrotasks();
  }
  final FakeAsync async;
  final repository = FakeRepository();
  late final CloudChatViewModel vm;
  final streams = <StreamController<CloudSseFrame>>[];
  final cursors = <String?>[];
  int cancellations = 0;
  void bootstrap([CloudChatBootstrap result = idle]) {
    repository.bootstraps.last.complete(result);
    async.flushMicrotasks();
  }

  void send(String id) => vm.send(
    clientRequestId: id,
    payload: CloudSendPayload(text: id),
  );
  void accept({String? cursor = '10', bool replayed = false}) {
    final post = repository.posts.last;
    post.result.complete(accepted(post.id, cursor: cursor, replayed: replayed));
    async.flushMicrotasks();
  }

  void emit(String event, Map<String, Object?> data, {String? id}) => streams
      .last
      .add(CloudSseFrame(event: event, data: jsonEncode(data), id: id));
  void dispose() {
    vm.dispose();
    for (final s in streams) {
      unawaited(s.close());
    }
    async.flushMicrotasks();
  }
}

/// [idle] with one canonical user row carrying [requestId].
CloudChatBootstrap bootstrapWithUserRow(String requestId) => CloudChatBootstrap(
  messages: [message('user-$requestId', requestId: requestId)],
  toolActivity: const [],
);
