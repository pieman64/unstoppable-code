import 'dart:async';
import 'dart:convert';
import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'cloud_conversation_session.dart';
import 'client_ids.dart';
import 'package:mobile/data/models/cloud_wire_frame.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';
import 'package:mobile/data/models/turn_outcome.dart';
import 'package:mobile/ui/features/cloud/view_models/agent_tasks/cloud_agent_task_tracker.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_authentication_failures.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_session.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_transcript_mapper.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_unsent_records.dart';

export 'cloud_chat_session.dart';

part 'cloud_chat_view_model_v2.dart';

typedef CloudStreamOpener =
    Stream<CloudSseFrame> Function(String chatId, {String? after});

const String _chatHistoryError = "Couldn't load chat history.";
const String _chatContinuationError = "Couldn't continue this chat. Try again.";
const String _chatInterruptError = "Couldn't stop this turn. Try again.";

String? _durableHarnessEventId(String? eventId) {
  final match = RegExp(r'^stream:(\d+):').firstMatch(eventId ?? '');
  return match?.group(1) ?? eventId;
}

/// The selection mode and model the server saved with an accepted turn.
typedef CloudAcceptedModelSelection = ({
  int revision,
  String chatId,
  String? modelSelectionMode,
  String? modelDefinitionId,
});

/// One selected cloud conversation. Core owns liveness; transcript projections
/// never release the outbox. Closing only detaches, never cancels a Core turn.
class CloudChatViewModel extends ChangeNotifier
    with DisposeSafeNotifier, WidgetsBindingObserver {
  CloudChatViewModel({
    required this.repository,
    required this.openStream,
    DateTime Function()? now,
    this.retryDelay = const Duration(seconds: 2),
    this.staleAfter = const Duration(seconds: 60),
    this.requestTimeout = const Duration(seconds: 30),
    this.observeLifecycle = true,
    this.onSuccessfulTurn,
  }) : _now = now ?? DateTime.now {
    if (observeLifecycle) WidgetsBinding.instance.addObserver(this);
  }
  final CloudChatRepository repository;
  final CloudStreamOpener openStream;
  final DateTime Function() _now;
  final Duration retryDelay, staleAfter, requestTimeout;
  final bool observeLifecycle;

  /// Called once per observed live turn that finished cleanly
  /// (`cloud:<chatId>:<userMessageId>`). A plain callback so this view model
  /// never depends on the satisfaction prompt.
  final void Function(String turnKey)? onSuccessfulTurn;
  final CloudAuthenticationFailures authenticationFailures =
      CloudAuthenticationFailures();
  CloudChatSessionState? _state;
  CloudChatSessionState? get state => _state;

  /// The selection mode and model the server saved with the latest accepted
  /// turn. [revision] grows with each one, so a reader applies it once.
  CloudAcceptedModelSelection? get acceptedModelSelection =>
      _acceptedModelSelection;
  CloudAcceptedModelSelection? _acceptedModelSelection;
  List<CloudTranscriptMessage> get messages {
    final s = _state;
    if (s == null) return const [];
    if (_conversation == null) return _agentTasks.project(s.visibleTranscript);
    final accepted = _conversation!.acceptedIds;
    return _agentTasks.project(
      List.unmodifiable([
        ...s.transcript,
        ...s.optimistic.entries
            .where((e) => !accepted.contains(e.key))
            .map((e) => e.value),
      ]),
    );
  }

  List<AskUserQuestionState> get pendingQuestions => _state == null
      ? const []
      : List.unmodifiable(
          {
            for (final question in [
              ..._mapper.pendingQuestions,
              ...?_provisionalMapper?.pendingQuestions,
            ])
              question.requestId: question,
          }.values,
        );
  bool get turnInProgress => _state?.liveTurn != null;

  /// When the user last wrote in the bound chat, including a send that is
  /// still in the outbox, or null when no user message is known.
  DateTime? get latestUserMessageAt {
    DateTime? latest;
    for (final message in messages) {
      final at = message.occurredAt;
      if (message.role != ChatRole.user || at == null) continue;
      if (latest == null || at.isAfter(latest)) latest = at;
    }
    return latest;
  }

  int get turnElapsedMs {
    final started = _state?.liveTurn?.startedAt;
    if (started == null) return 0;
    final elapsed = _now().difference(started).inMilliseconds;
    return elapsed < 0 ? 0 : elapsed;
  }

  String? get bootstrapError => _state?.bootstrapError;
  CloudSendError? get sendError => _failed.values.lastOrNull?.lastError;
  bool get hasFailedContinuation =>
      _state?.bootstrapError == _chatContinuationError && _failed.isNotEmpty;

  late CloudTranscriptMapper _mapper;
  final _agentTasks = CloudAgentTaskTracker();
  ConversationDiscoveryMetadata? _binding;
  CloudConversationSession? _conversation;
  ConversationExecution? _execution;
  CloudTranscriptMapper? _provisionalMapper;
  final Map<String, Map<String, CloudChatToolActivity>> _conversationActivity =
      {};
  final Map<String, ConversationCommandInput> _pendingCommands = {};
  final Set<String> _postingCommands = {};
  bool _loadingOlder = false;
  String? _olderHistoryError;
  bool get loadingOlder => _loadingOlder;
  String? get olderHistoryError => _olderHistoryError;
  bool get hasMoreHistory => _conversation?.hasMoreHistory ?? false;
  int? get protocolVersion => _binding?.protocolVersion;
  List<ConversationTurn> get queuedTurns =>
      _conversation?.turns.where((t) => t.status == 'QUEUED').toList() ??
      const [];

  StreamSubscription<CloudSseFrame>? _subscription;
  Timer? _bootstrapTimer, _retryTimer;
  String? _acceptedAfter;
  int _generation = 0, _streamGeneration = 0;
  bool _foreground = true,
      _bootstrapping = false,
      _posting = false,
      _continuing = false;
  bool _bootstrapInvalidated = false;

  /// Set when a continuation adopts a new epoch whose history Core copied.
  bool _replaceHistory = false;
  Object? _recoveryError;
  Object? get recoveryError => _recoveryError;
  final Map<String, CloudOutboxEntry> _failed = {};
  Map<String, CloudOutboxEntry> get failedSends => Map.unmodifiable(_failed);

  ChatDraftStore? _draftStore;

  /// The chat whose last sync left no stored records. While it has nothing
  /// to mirror, [_syncUnsent] skips the store scan: streaming calls [_set]
  /// for every frame.
  String? _unsentClearChatId;

  /// Set by `ChatDraftStoreScope` once the account's store is open. The bound
  /// chat's outbox and failed sends are mirrored into it on every transition.
  void attachDraftStore(ChatDraftStore? store) {
    _draftStore = store;
    _unsentClearChatId = null;
  }

  /// Clears the store only when [store] is still the attached one, so an
  /// older scope disposing late cannot detach a newer scope's store.
  void detachDraftStore(ChatDraftStore store) {
    if (identical(_draftStore, store)) _draftStore = null;
    _unsentClearChatId = null;
  }

  bool _active(int generation) =>
      !isDisposed && generation == _generation && _state != null;
  void _set(CloudChatSessionState next, {bool clearComposerDraft = false}) {
    assertCloudSessionInvariants(next, _conversation == null ? _state : null);
    final previous = _state;
    _state = next;
    _syncUnsent(next, clearComposerDraft: clearComposerDraft);
    _reportSuccessfulTurn(previous, next);
    notifyListenersSafe();
  }

  /// Writes the bound chat's outbox and failed sends to the draft store and
  /// removes records that left both (accepted, cancelled, or discarded).
  /// `close()` never calls this, so closing keeps every record.
  void _syncUnsent(CloudChatSessionState s, {bool clearComposerDraft = false}) {
    final store = _draftStore;
    if (store == null) return;
    if (s.outbox.isEmpty && _failed.isEmpty && _unsentClearChatId == s.chatId) {
      return;
    }
    final live = <String, CloudUnsentRecord>{
      for (final entry in s.outbox)
        entry.clientRequestId: CloudUnsentRecord.fromEntry(
          entry,
          chatId: s.chatId,
          status: UnsentStatus.sending,
        ),
      for (final entry in _failed.values)
        entry.clientRequestId: CloudUnsentRecord.fromEntry(
          entry,
          chatId: s.chatId,
          status: entry.lastError?.uncertain == true
              ? UnsentStatus.uncertain
              : UnsentStatus.notSent,
        ),
    };
    final stored = {
      for (final record in cloudRecordsForChat(store, s.chatId))
        record.clientRequestId: record,
    };
    for (final id in stored.keys) {
      if (!live.containsKey(id)) store.removeUnsent(cloudUnsentRecordId(id));
    }
    for (final MapEntry(key: id, value: record) in live.entries) {
      final previous = stored[id];
      if (previous != null && previous.sameAs(record)) continue;
      store.putUnsent(
        record.toUnsentRecord(),
        clearDraft: previous == null && clearComposerDraft
            ? CloudChatDraftTarget(s.chatId)
            : null,
      );
    }
    _unsentClearChatId = live.isEmpty ? s.chatId : null;
  }

  /// A live turn this view model was tracking has ended. v2 conversations
  /// carry an authoritative per-turn status; v1 falls back to the transcript
  /// tail of ends observed on the live stream. Re-bootstraps (epoch change, unknown liveness) never count.
  void _reportSuccessfulTurn(
    CloudChatSessionState? previous,
    CloudChatSessionState next,
  ) {
    final callback = onSuccessfulTurn;
    final ended = previous?.liveTurn;
    if (callback == null || previous == null || ended == null) return;
    if (previous.chatId != next.chatId) return;
    if (previous.cursorEpoch != next.cursorEpoch) return;
    if (next.liveTurn?.userMessageId == ended.userMessageId) return;
    // A placeholder turn (`unknown:<source>`) never had its identity named,
    // and a later bootstrap renaming the same turn is not an end.
    if (ended.userMessageId.startsWith('unknown:')) return;
    if (ended.turnId != null && next.liveTurn?.turnId == ended.turnId) return;
    if (ended.interrupting || _failed.isNotEmpty) return;
    if (next.bootstrapError != null) return;
    final conversation = _conversation;
    if (conversation != null) {
      final turn = conversation.turns
          .where((t) => t.userMessageId == ended.userMessageId)
          .lastOrNull;
      if (turn?.status != 'COMPLETED') return;
    } else {
      // Only an end seen on the live stream is trustworthy: a bootstrap row
      // carries no outcome, so a turn stopped or failed while backgrounded
      // would otherwise look clean. Bootstrap transitions never leave the
      // stream attached.
      if (previous.attachment != CloudAttachmentStatus.attached ||
          next.attachment != CloudAttachmentStatus.attached) {
        return;
      }
      if (next.sessionStatus != CloudSessionStatus.live) return;
      if (!latestTurnSucceeded(next.transcript)) return;
      final tail = next.transcript.reversed.takeWhile(
        (m) => m.role != ChatRole.user,
      );
      if (tail.any((m) => m.errorCode != null)) return;
    }
    callback('cloud:${next.chatId}:${ended.userMessageId}');
  }

  /// [cursorEpoch] is the Core session id from the chat summary, never a local
  /// clock or bootstrap counter. A changed epoch invalidates pending callbacks.
  void open(String chatId, {required String cursorEpoch}) {
    if (isDisposed) return;
    if (_state?.chatId == chatId && _state?.cursorEpoch == cursorEpoch) {
      setForeground(true);
      return;
    }
    close();
    _unsentClearChatId = null;
    _mapper = CloudTranscriptMapper(chatId: chatId, now: _now);
    _agentTasks.clear();
    _state = CloudChatSessionState(chatId: chatId, cursorEpoch: cursorEpoch);
    _restoreUnsent(chatId);
    notifyListenersSafe();
    if (_foreground) unawaited(_bootstrap());
  }

  /// Shows the chat's stored records as failed sends. Nothing is posted until
  /// the user taps Resend, so a process restart never sends automatically.
  void _restoreUnsent(String chatId) {
    final store = _draftStore;
    final s = _state;
    if (store == null || s == null) return;
    for (final record in store.unsentFor(kCloudUnsentSurface)) {
      if (CloudUnsentRecord.fromRecord(record) case final pending?
          when pending.isPendingCreate && pending.externalId == chatId) {
        store.putUnsent(
          pending
              .copyWith(chatId: chatId, status: UnsentStatus.uncertain)
              .toUnsentRecord(),
        );
      }
    }
    final restored = [
      for (final record in cloudRecordsForChat(store, chatId))
        record.toFailedEntry(),
    ];
    if (restored.isEmpty) return;
    for (final entry in restored) {
      _failed[entry.clientRequestId] = entry;
    }
    _state = s.copyWith(
      transcript: mergeCloudMessages(s.transcript, [
        for (final entry in restored)
          _bubble(
            entry,
            error: entry.lastError?.message ?? '',
            uncertain: entry.lastError?.uncertain ?? false,
          ),
      ]),
    );
  }

  /// Brings a recovered first send into an already-open chat before later
  /// state transitions can reconcile its stored record away.
  void adoptRecoveredUnsent(CloudUnsentRecord record) {
    final s = _state;
    if (s == null || s.chatId != record.chatId || isDisposed) return;
    if (s.transcript.any(
      (message) =>
          message.role == ChatRole.user &&
          message.clientRequestId == record.clientRequestId &&
          !message.messageId.startsWith('optimistic:'),
    )) {
      _draftStore?.removeUnsent(cloudUnsentRecordId(record.clientRequestId));
      return;
    }
    final entry = record.toFailedEntry();
    _failed[entry.clientRequestId] = entry;
    _set(
      s.copyWith(
        transcript: mergeCloudMessages(s.transcript, [
          _bubble(
            entry,
            error: entry.lastError?.message ?? '',
            uncertain: entry.lastError?.uncertain ?? false,
          ),
        ]),
      ),
    );
  }

  void close() {
    _generation++;
    _detach();
    _acceptedAfter = null;
    _binding = null;
    _conversation = null;
    _execution = null;
    _provisionalMapper = null;
    _loadingOlder = false;
    _olderHistoryError = null;
    _conversationActivity.clear();
    _pendingCommands.clear();
    _postingCommands.clear();
    _bootstrapTimer?.cancel();
    _bootstrapTimer = null;
    _retryTimer?.cancel();
    _retryTimer = null;
    _bootstrapping = _posting = _continuing = false;
    _bootstrapInvalidated = false;
    _replaceHistory = false;
    _recoveryError = null;
    _failed.clear();
    _state = null;
    notifyListenersSafe();
  }

  /// [previous] is the failed entry being resent: its attempts and last error
  /// carry over so the retry replays under the same idempotency key.
  void send({
    required String clientRequestId,
    required CloudSendPayload payload,
    CloudOutboxEntry? previous,
    bool clearComposerDraft = false,
  }) {
    final s = _state;
    if (s == null || isDisposed) return;
    if (s.outbox.any((e) => e.clientRequestId == clientRequestId) ||
        s.transcript.any(
          (m) =>
              m.role == ChatRole.user &&
              m.clientRequestId == clientRequestId &&
              !m.messageId.startsWith('optimistic:'),
        )) {
      return;
    }
    final entry = CloudOutboxEntry(
      clientRequestId: clientRequestId,
      payload: payload,
      enqueuedAt: _now(),
      attempts: previous?.attempts ?? 0,
      lastError: previous?.lastError,
    );
    _failed.remove(clientRequestId);
    _set(
      s.copyWith(
        outbox: [...s.outbox, entry],
        transcript: s.transcript
            .where((m) => m.messageId != 'optimistic:$clientRequestId')
            .toList(),
        optimistic: {...s.optimistic, clientRequestId: _bubble(entry)},
      ),
      clearComposerDraft: clearComposerDraft,
    );
    _effects();
  }

  CloudTranscriptMessage _bubble(
    CloudOutboxEntry e, {
    String? error,
    bool uncertain = false,
  }) => CloudTranscriptMessage(
    messageId: 'optimistic:${e.clientRequestId}',
    clientRequestId: e.clientRequestId,
    chatId: _state!.chatId,
    role: ChatRole.user,
    status: error == null
        ? ChatMessageStatus.complete
        : ChatMessageStatus.failed,
    text: e.payload.text,
    occurredAt: e.enqueuedAt,
    attachments: [
      for (final ref in e.payload.attachments) ref.toMessageAttachment(),
    ],
    errorMessage: error,
    delivery: error == null
        ? null
        : (uncertain ? ChatDelivery.uncertain : ChatDelivery.notSent),
    deliveryNote: error == null || error.isEmpty ? null : error,
  );

  /// The oldest send the server may still hold: queued, posting, or failed
  /// without a definitive refusal. A resend replays it unchanged under its
  /// own id, so the chat keeps its selection until it settles or is
  /// discarded.
  CloudOutboxEntry? get retainedSend {
    final s = _state;
    if (s == null) return null;
    return s.outbox
            .where((e) => e.status != CloudOutboxStatus.accepted)
            .firstOrNull ??
        _failed.values.where((e) => !_refused(e)).firstOrNull;
  }

  /// The server holds nothing under [entry]'s id: it was never posted, or
  /// its last post was refused outright.
  static bool _refused(CloudOutboxEntry entry) => switch (entry.lastError) {
    null => true,
    final error =>
      error.kind == CloudSendErrorKind.definitive && !error.uncertain,
  };

  /// Resends a failed send. A send the server may hold replays its own
  /// payload under its own id. A refused send goes out as a new send whose
  /// payload [fresh] builds from its text, so it uses the selection the chat
  /// shows now, and keeps its attachments. Without [fresh], every failed
  /// send replays.
  void retrySend(
    String clientRequestId, {
    CloudSendPayload Function(String text)? fresh,
  }) {
    final entry = _failed[clientRequestId];
    final s = _state;
    if (entry == null || s == null) return;
    if (fresh == null || !_refused(entry)) {
      send(
        clientRequestId: clientRequestId,
        payload: entry.payload,
        previous: entry,
      );
      return;
    }
    _failed.remove(clientRequestId);
    _state = s.copyWith(
      transcript: s.transcript
          .where((m) => m.messageId != '$_optimisticPrefix$clientRequestId')
          .toList(),
    );
    send(
      clientRequestId: randomUuidV4(),
      payload: fresh(
        entry.payload.text,
      ).withAttachments(entry.payload.attachments),
    );
  }

  void discardFailed(String clientRequestId) {
    final s = _state;
    if (s == null || _failed.remove(clientRequestId) == null) return;
    _set(
      s.copyWith(
        transcript: s.transcript
            .where((m) => m.messageId != 'optimistic:$clientRequestId')
            .toList(),
      ),
    );
  }

  static const _optimisticPrefix = 'optimistic:';

  /// Row actions from `ChatFeed`, which passes the bubble's message id.
  void resendMessage(
    String messageId, {
    CloudSendPayload Function(String text)? fresh,
  }) {
    if (!messageId.startsWith(_optimisticPrefix)) return;
    retrySend(messageId.substring(_optimisticPrefix.length), fresh: fresh);
  }

  void discardMessage(String messageId) {
    if (!messageId.startsWith(_optimisticPrefix)) return;
    discardFailed(messageId.substring(_optimisticPrefix.length));
  }

  /// Drops failed sends whose canonical user row an authoritative load shows,
  /// such as a restored send that landed before the process stopped.
  void _pruneLandedFailed() {
    final s = _state;
    if (s == null || _failed.isEmpty) return;
    final landed =
        _conversation?.acceptedIds ??
        {
          for (final m in s.transcript)
            if (m.role == ChatRole.user &&
                !m.messageId.startsWith(_optimisticPrefix))
              ?m.clientRequestId,
        };
    final ids = _failed.keys.where(landed.contains).toList();
    if (ids.isEmpty) return;
    ids.forEach(_failed.remove);
    _set(
      s.copyWith(
        transcript: s.transcript
            .where(
              (m) => !ids.any((id) => m.messageId == '$_optimisticPrefix$id'),
            )
            .toList(),
      ),
    );
  }

  void cancelQueued(String clientRequestId) {
    final s = _state;
    if (_conversation != null &&
        !(_state?.outbox.any((e) => e.clientRequestId == clientRequestId) ??
            false)) {
      final turn = queuedTurns
          .where((t) => t.clientRequestId == clientRequestId)
          .firstOrNull;
      if (turn != null) {
        unawaited(commandTurn(turn.turnId, ConversationTurnOperation.cancel));
      }
      return;
    }
    if (s == null ||
        !s.outbox.any(
          (e) =>
              e.clientRequestId == clientRequestId &&
              e.status == CloudOutboxStatus.queued &&
              (_conversation == null || e.attempts == 0),
        )) {
      return;
    }
    _set(
      s.copyWith(
        outbox: s.outbox
            .where((e) => e.clientRequestId != clientRequestId)
            .toList(),
        optimistic: {...s.optimistic}..remove(clientRequestId),
      ),
    );
    _effects();
  }

  void editQueued(String clientRequestId, String text) {
    final s = _state;
    if (s == null) return;
    if (_conversation != null &&
        !s.outbox.any((e) => e.clientRequestId == clientRequestId)) {
      final turn = queuedTurns
          .where((t) => t.clientRequestId == clientRequestId)
          .firstOrNull;
      if (turn != null) {
        unawaited(
          commandTurn(
            turn.turnId,
            ConversationTurnOperation.edit,
            content: text,
          ),
        );
      }
      return;
    }
    final entry = s.outbox
        .where(
          (e) =>
              e.clientRequestId == clientRequestId &&
              e.status == CloudOutboxStatus.queued,
        )
        .firstOrNull;
    // A retryable send may already be accepted remotely. Its idempotency key
    // must keep the original payload, even before the acknowledgement arrives.
    if (entry == null || entry.attempts > 0) return;
    final edited = entry.copyWith(payload: entry.payload.withText(text));
    _set(
      s.copyWith(
        outbox: [
          for (final e in s.outbox)
            if (e == entry) edited else e,
        ],
        optimistic: {...s.optimistic, clientRequestId: _bubble(edited)},
      ),
    );
  }

  void _effects() {
    final s = _state;
    if (s == null ||
        !_foreground ||
        isDisposed ||
        _continuing ||
        _recoveryError != null) {
      return;
    }
    if (s.sessionStatus == CloudSessionStatus.terminal &&
        s.outbox.isNotEmpty &&
        !_bootstrapping &&
        !_posting) {
      unawaited(continueChat());
      return;
    }
    final effects = _conversation == null
        ? deriveCloudEffects(s, _now())
        : deriveConversationEffects(s, _conversation!, _now());
    for (final effect in effects) {
      switch (effect) {
        case CloudSessionEffect.bootstrap:
          _scheduleBootstrap();
        case CloudSessionEffect.post:
          if (!_posting && !_bootstrapping && _binding != null) {
            unawaited(_post());
          }
        case CloudSessionEffect.attach:
          if (!_bootstrapping) _attach();
      }
    }
    _retryTimer?.cancel();
    _retryTimer = null;
    final deadline = _state?.outbox.firstOrNull?.nextAttemptAt;
    if (deadline != null && deadline.isAfter(_now())) {
      _retryTimer = Timer(deadline.difference(_now()), _effects);
    }
  }

  void _scheduleBootstrap() {
    if (_bootstrapping || _bootstrapTimer != null) return;
    _bootstrapTimer = Timer(retryDelay, () {
      _bootstrapTimer = null;
      if (_foreground) unawaited(_bootstrap());
    });
  }

  Future<void> refresh() async {
    if (_state == null || isDisposed) return;
    _recoveryError = null;
    if (_bootstrapping || _posting) _bootstrapInvalidated = true;
    _markStale();
    if (!_bootstrapping && !_posting && !_continuing && _foreground) {
      await _bootstrap();
    }
  }

  Future<void> _bootstrap() async {
    final s = _state;
    if (s == null ||
        _bootstrapping ||
        _posting ||
        _continuing ||
        !_foreground ||
        _recoveryError != null) {
      return;
    }
    final generation = _generation;
    _bootstrapping = true;
    _bootstrapTimer?.cancel();
    _bootstrapTimer = null;
    _detach();
    try {
      if (_binding == null) {
        final binding = await repository
            .discoverConversation(s.chatId)
            .timeout(requestTimeout);
        if (!_active(generation)) return;
        _binding = binding;
        if (binding.protocolVersion == 1) _conversation = null;
        if (binding.protocolVersion == 2) {
          _conversation = CloudConversationSession(
            sessionId: binding.sessionId,
          );
          _set(_state!.copyWith(cursorEpoch: binding.sessionId, cursor: null));
        }
      }
      if (_binding!.protocolVersion == 2) {
        final result = await repository
            .getConversation(s.chatId)
            .timeout(requestTimeout);
        if (!_active(generation)) return;
        if (result.sessionId != _conversation!.sessionId) {
          _binding = null;
          throw const FormatException(
            'Conversation session changed; rediscovery required',
          );
        }
        _conversation = _conversation!.snapshot(result);
        _agentTasks.conversationTasks(result.tasks, result.toolActivity);
        _projectConversation(detached: true);
        _pruneLandedFailed();
        _replaceHistory = false;
        return;
      }
      final result = await repository
          .getMessages(s.chatId)
          .timeout(requestTimeout);
      if (!_active(generation)) return;
      _agentTasks.legacyBootstrap(result);
      _set(
        reduceCloudBootstrap(
          _state!,
          result,
          _mapper.hydrate(result),
          _now(),
          replaceHistory: _replaceHistory,
        ),
      );
      _pruneLandedFailed();
      _replaceHistory = false;
    } catch (error) {
      if (_active(generation)) {
        authenticationFailures.report(error);
        if (_conversation != null &&
            error is CloudSendError &&
            error.coreError != null) {
          _conversationError(error.coreError!);
        }
        if (error is CloudApiException &&
                const {401, 403, 404}.contains(error.statusCode) ||
            error is CloudSendError &&
                const {401, 403, 404}.contains(error.status)) {
          _recoveryError = error;
        }
        _set(
          _state!.copyWith(
            bootstrapError: _chatHistoryError,
            attachment: CloudAttachmentStatus.stale,
          ),
        );
      }
    } finally {
      if (_active(generation)) {
        _bootstrapping = false;
        if (_bootstrapInvalidated) {
          _bootstrapInvalidated = false;
          _markStale();
        }
        _effects();
      }
    }
  }

  void _acceptModelSelection(
    String chatId,
    String? modelSelectionMode,
    String? modelDefinitionId,
  ) {
    if (modelSelectionMode == null && modelDefinitionId == null) return;
    _acceptedModelSelection = (
      revision: (_acceptedModelSelection?.revision ?? 0) + 1,
      chatId: chatId,
      modelSelectionMode: modelSelectionMode,
      modelDefinitionId: modelDefinitionId,
    );
  }

  Future<void> _post() async {
    final s = _state!;
    final entry = s.outbox.first;
    final generation = _generation;
    _posting = true;
    _set(
      s.copyWith(
        outbox: [
          entry.copyWith(status: CloudOutboxStatus.posting),
          ...s.outbox.skip(1),
        ],
      ),
    );
    try {
      final p = entry.payload;
      if (_conversation != null) {
        final result = await repository
            .postConversationTurn(
              s.chatId,
              ConversationSendInput(
                clientRequestId: entry.clientRequestId,
                content: p.text,
                retryUncertain: entry.lastError?.uncertain ?? false,
                modelDefinitionId: p.modelDefinitionId,
                thinkingEffort: p.thinkingLevel,
                resetThinkingEffort: p.resetThinkingLevel,
                fastMode: p.fastMode,
                cloudAttachments: p.attachments,
              ),
            )
            .timeout(requestTimeout);
        if (!_active(generation)) return;
        _acceptModelSelection(
          s.chatId,
          result.modelSelectionMode,
          result.modelDefinitionId,
        );
        // A changed event may have already retired this delivery. A late HTTP
        // response must not roll its completed canonical turn back to queued.
        if (!_state!.outbox.any(
          (e) => e.clientRequestId == entry.clientRequestId,
        )) {
          notifyListenersSafe();
          return;
        }
        _conversation = _conversation!.accepted(result, entry.clientRequestId);
        _mapper.clearPendingQuestions();
        _provisionalMapper?.clearPendingQuestions();
        _set(
          _state!.copyWith(
            outbox: _state!.outbox
                .where((e) => e.clientRequestId != entry.clientRequestId)
                .toList(),
            optimistic: {..._state!.optimistic}..remove(entry.clientRequestId),
          ),
        );
        _projectConversation();
        return;
      }
      final result = await repository
          .postMessage(
            s.chatId,
            text: p.text,
            clientRequestId: entry.clientRequestId,
            modelDefinitionId: p.modelDefinitionId,
            thinkingLevel: p.thinkingLevel,
            resetThinkingLevel: p.resetThinkingLevel,
            fastMode: p.fastMode,
            replayHint: entry.attempts > 0,
            cloudAttachments: p.attachments,
          )
          .timeout(requestTimeout);
      if (!_active(generation)) return;
      final rows = CloudTranscriptMapper(chatId: s.chatId, now: _now).hydrate(
        CloudChatBootstrap(messages: [result.message], toolActivity: const []),
      );
      final next = reduceCloudAccepted(
        _state!,
        entry.clientRequestId,
        result,
        rows,
        _now(),
      );
      _acceptedAfter = result.streamAfter;
      _mapper.clearPendingQuestions();
      _detach();
      _acceptModelSelection(
        s.chatId,
        result.modelSelectionMode,
        result.modelDefinitionId,
      );
      _set(next);
    } catch (error) {
      if (!_active(generation)) return;
      authenticationFailures.report(error);
      var failure = error is CloudSendError
          ? error
          : CloudSendError(
              kind: CloudSendErrorKind.retryable,
              status: 0,
              message: error.toString(),
              retryAfter: retryDelay,
              uncertain: _conversation != null,
            );
      if (_conversation != null && failure.coreError != null) {
        _conversationError(failure.coreError!);
        if (failure.coreError!.code !=
            'AGENT_SESSION_QUEUE_CAPACITY_EXCEEDED') {
          failure = CloudSendError(
            kind: CloudSendErrorKind.retryable,
            status: failure.status,
            message: failure.message,
            code: failure.code,
            retryAfter: retryDelay,
            uncertain: true,
          );
        }
      }
      final current = _state!;
      if (!current.outbox.any(
        (e) => e.clientRequestId == entry.clientRequestId,
      )) {
        return;
      }
      if (failure.kind == CloudSendErrorKind.definitive) {
        _failed[entry.clientRequestId] = entry.copyWith(lastError: failure);
        _set(
          current.copyWith(
            outbox: current.outbox
                .where((e) => e.clientRequestId != entry.clientRequestId)
                .toList(),
            optimistic: {...current.optimistic}..remove(entry.clientRequestId),
            transcript: mergeCloudMessages(current.transcript, [
              _bubble(
                entry,
                error: failure.message,
                uncertain: failure.uncertain,
              ),
            ]),
          ),
        );
      } else {
        _set(
          current.copyWith(
            outbox: [
              for (final e in current.outbox)
                if (e.clientRequestId == entry.clientRequestId)
                  e.copyWith(
                    status: CloudOutboxStatus.queued,
                    attempts: e.attempts + 1,
                    lastError: failure,
                    nextAttemptAt: _now().add(failure.retryAfter ?? retryDelay),
                  )
                else
                  e,
            ],
            sessionStatus: failure.kind == CloudSendErrorKind.terminalSession
                ? CloudSessionStatus.terminal
                : current.sessionStatus,
            liveTurn: failure.kind == CloudSendErrorKind.terminalSession
                ? null
                : current.liveTurn,
            terminalReason: failure.kind == CloudSendErrorKind.terminalSession
                ? failure.message
                : current.terminalReason,
          ),
        );
      }
    } finally {
      if (_active(generation)) {
        _posting = false;
        if (_bootstrapInvalidated) {
          _bootstrapInvalidated = false;
          _markStale();
          if (_foreground) unawaited(_bootstrap());
        } else {
          _effects();
        }
      }
    }
  }

  /// Explicit continuation also works for a terminal chat with no queued send.
  Future<void> continueChat() async {
    if (_state == null ||
        isDisposed ||
        _continuing ||
        _bootstrapping ||
        _posting ||
        _state!.sessionStatus != CloudSessionStatus.terminal) {
      return;
    }
    final generation = _generation;
    final s = _state!;
    _continuing = true;
    _detach();
    try {
      String? source = _conversation?.sessionId;
      if (source == null) {
        final status = await repository
            .getMessageStatus(s.chatId)
            .timeout(requestTimeout);
        if (!_active(generation)) return;
        source =
            status.terminalSession?.sourceAgentSessionId ??
            status.sourceAgentSessionId;
      }
      if (source == null || source.isEmpty) {
        throw StateError('Missing source session for continuation');
      }
      final chat = await repository
          .continueChat(
            s.chatId,
            sourceAgentSessionId: source,
            fastMode: s.outbox.firstOrNull?.payload.fastMode,
          )
          .timeout(requestTimeout);
      if (!_active(generation)) return;
      final epoch = chat.coreAgentSessionId;
      if (epoch.isEmpty || epoch == s.cursorEpoch) {
        throw StateError('Continuation did not return a new session');
      }
      _acceptedAfter = null;
      _binding = null;
      _conversation = null;
      _conversationActivity.clear();
      _pendingCommands.clear();
      _postingCommands.clear();
      _execution = null;
      _provisionalMapper = null;
      _mapper = CloudTranscriptMapper(chatId: s.chatId, now: _now);
      _agentTasks.clear();
      _replaceHistory = true;
      _set(
        _state!.copyWith(
          cursorEpoch: epoch,
          cursor: null,
          capabilityState: null,
          liveTurn: null,
          sessionStatus: CloudSessionStatus.unknown,
          attachment: CloudAttachmentStatus.detached,
          terminalReason: null,
          bootstrapError: null,
          lastFrameAt: null,
        ),
      );
    } catch (error) {
      if (_active(generation)) {
        authenticationFailures.report(error);
        final current = _state!;
        final failures = [
          for (final e in current.outbox)
            _bubble(
              e,
              error: _chatContinuationError,
              uncertain: e.lastError?.uncertain ?? false,
            ),
        ];
        _failed.addEntries(
          current.outbox.map((e) => MapEntry(e.clientRequestId, e)),
        );
        _set(
          current.copyWith(
            outbox: [],
            optimistic: {},
            transcript: mergeCloudMessages(current.transcript, failures),
            bootstrapError: _chatContinuationError,
          ),
        );
      }
    } finally {
      if (_active(generation)) {
        _continuing = false;
        if (_state!.sessionStatus == CloudSessionStatus.unknown &&
            _foreground) {
          unawaited(_bootstrap());
        }
      }
    }
  }

  void _attach() {
    final s = _state!;
    if (_subscription != null || s.cursor == null || !_foreground) return;
    final generation = _generation, streamGeneration = ++_streamGeneration;
    bool active() =>
        _active(generation) && streamGeneration == _streamGeneration;
    _set(s.copyWith(attachment: CloudAttachmentStatus.attaching));
    try {
      _subscription = openStream(s.chatId, after: s.cursor).listen(
        (frame) {
          if (active()) _frame(frame);
        },
        onError: (Object error) {
          if (active()) {
            authenticationFailures.report(error);
            if (error is CloudEventStreamException) _recoveryError = error;
            _markStale();
            _set(_state!.copyWith(bootstrapError: _chatHistoryError));
            _effects();
          }
        },
        onDone: () {
          if (active()) {
            _markStale();
            _effects();
          }
        },
      );
      _set(_state!.copyWith(attachment: CloudAttachmentStatus.attached));
    } catch (error) {
      if (active()) {
        authenticationFailures.report(error);
        _markStale();
        _set(_state!.copyWith(bootstrapError: _chatHistoryError));
        _effects();
      }
    }
  }

  void _frame(CloudSseFrame raw) {
    if (_conversation != null) {
      _conversationFrame(raw);
      return;
    }
    if (isCloudReplayCursor(_acceptedAfter, raw.id)) return;
    var s = _state!;
    if (raw.id != null && s.cursor != null) {
      final order = compareCloudCursors(raw.id!, s.cursor!);
      if (order != null && order <= 0) return;
    }
    Object? data;
    try {
      data = jsonDecode(raw.data);
    } on FormatException {
      data = null;
    }
    _agentTasks.frame(raw.event ?? '', data, eventId: raw.id);
    final frame = parseCloudWireFrame(raw.event ?? '', data);
    final taskScoped = frame is CloudWireIgnored && frame.taskId != null;
    final terminal = raw.event == 'message.finish' && !taskScoped;
    final eventId = frame is CloudHarnessWarning || frame is CloudHarnessEvent
        ? _durableHarnessEventId(raw.id)
        : raw.id;
    final rows = _mapper.apply(frame, eventId: eventId);
    s = reduceCloudFrame(
      s,
      frame,
      rows,
      terminal: terminal,
      cursor: raw.id,
      now: _now(),
    );
    _set(s);
    if (s.attachment == CloudAttachmentStatus.stale) _detach();
    // Keep the settled stream until the next post, refresh, or background so
    // trailing error details can update the failed assistant row.
    _effects();
  }

  void _detach() {
    _streamGeneration++;
    final subscription = _subscription;
    _subscription = null;
    if (subscription != null) unawaited(subscription.cancel());
  }

  void _markStale() {
    _detach();
    final s = _state;
    if (s != null) {
      _set(
        s.copyWith(
          attachment: CloudAttachmentStatus.stale,
          sessionStatus: s.sessionStatus == CloudSessionStatus.terminal
              ? CloudSessionStatus.terminal
              : CloudSessionStatus.unknown,
        ),
      );
    }
  }

  Future<void> interrupt() async {
    if (_conversation != null) {
      await _interruptConversation();
      return;
    }
    final s = _state;
    if (s == null || !s.canInterrupt) return;
    final generation = _generation;
    late final AgentTurnInterruptResult result;
    try {
      result = await repository
          .interruptTurn(s.chatId, s.liveTurn!.turnId!)
          .timeout(requestTimeout);
    } catch (error) {
      if (_active(generation)) {
        authenticationFailures.report(error);
        _set(_state!.copyWith(bootstrapError: _chatInterruptError));
        _markStale();
        _effects();
      }
      return;
    }
    if (!_active(generation) || _state!.liveTurn?.turnId != result.turnId) {
      return;
    }
    final current = _state!, turn = _state!.liveTurn!;
    switch (result.outcome) {
      case AgentTurnInterruptOutcome.interruptRequested:
        _set(
          current.copyWith(
            liveTurn: CloudLiveTurn(
              turnId: turn.turnId,
              userMessageId: turn.userMessageId,
              startedAt: turn.startedAt,
              interrupting: true,
            ),
          ),
        );
      case AgentTurnInterruptOutcome.alreadyTerminal:
        _set(current.copyWith(liveTurn: null));
      case AgentTurnInterruptOutcome.superseded:
      case AgentTurnInterruptOutcome.unknown:
        if (result.activeTurnId == turn.turnId) {
          _set(
            current.copyWith(
              liveTurn: CloudLiveTurn(
                turnId: turn.turnId,
                userMessageId: turn.userMessageId,
                startedAt: turn.startedAt,
              ),
            ),
          );
          break;
        }
        _set(
          current.copyWith(
            liveTurn: result.activeTurnId == null
                ? null
                : CloudLiveTurn(
                    turnId: result.activeTurnId,
                    userMessageId: 'unknown:${result.activeTurnId}',
                    startedAt: _now(),
                  ),
          ),
        );
        _markStale();
    }
    _effects();
  }

  void setForeground(bool foreground) {
    _foreground = foreground;
    final s = _state;
    if (s == null || isDisposed) return;
    if (!foreground) {
      _detach();
      _bootstrapTimer?.cancel();
      _bootstrapTimer = null;
      _retryTimer?.cancel();
      _retryTimer = null;
      _set(
        s.copyWith(
          attachment: s.attachment == CloudAttachmentStatus.stale
              ? s.attachment
              : CloudAttachmentStatus.detached,
        ),
      );
      return;
    }
    final turn = s.liveTurn;
    if (turn != null &&
        _now().difference(s.lastFrameAt ?? turn.startedAt) > staleAfter) {
      _markStale();
    }
    if (_state!.sessionStatus == CloudSessionStatus.unknown ||
        _state!.attachment == CloudAttachmentStatus.stale ||
        (_state!.attachment == CloudAttachmentStatus.detached &&
            _state!.liveTurn == null)) {
      unawaited(_bootstrap());
    } else {
      _effects();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) setForeground(true);
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      setForeground(false);
    }
  }

  @override
  void dispose() {
    if (observeLifecycle) WidgetsBinding.instance.removeObserver(this);
    close();
    super.dispose();
  }
}
