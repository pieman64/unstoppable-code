part of 'cloud_chat_view_model.dart';

/// V2 orchestration shares delivery/UI state with the v1 host while keeping
/// canonical state versions and execution identity in its own reducer.
extension CloudConversationOperations on CloudChatViewModel {
  void _projectConversation({
    bool detached = false,
    bool canonicalChanged = true,
  }) {
    final c = _conversation!, s = _state!;
    if (!_executionMatches()) {
      _execution = null;
      _provisionalMapper = null;
    }
    if (canonicalChanged) _agentTasks.conversationMessages(c.messages);
    if (_executionMatches()) {
      _agentTasks.fold.turnIdentity(_execution!.turnId, _execution!.sourceKey);
    }
    final rows = canonicalChanged
        ? _mapper.hydrate(
            conversationBootstrap(c, activityByTurn: _conversationActivity),
            preserveSequenceOrder: true,
          )
        : _mapper.messages;
    final accepted = c.acceptedIds;
    if (s.outbox.any((entry) => accepted.contains(entry.clientRequestId))) {
      _provisionalMapper?.clearPendingQuestions();
    }
    final turn = c.running;
    // A stop is safe only after a transient frame names the execution source.
    final live = c.terminal || turn == null
        ? null
        : CloudLiveTurn(
            turnId: _executionMatches() ? _execution!.sourceKey : null,
            userMessageId: turn.userMessageId,
            startedAt:
                DateTime.tryParse(turn.startedAt ?? '') ??
                (s.liveTurn?.userMessageId == turn.userMessageId
                    ? s.liveTurn!.startedAt
                    : _now()),
            interrupting:
                s.liveTurn?.userMessageId == turn.userMessageId &&
                (s.liveTurn?.interrupting ?? false),
          );
    _set(
      s.copyWith(
        transcript: [
          ...rows,
          ...?_provisionalMapper?.messages,
          ...s.transcript.where(
            (m) =>
                m.messageId.startsWith('optimistic:') &&
                !accepted.contains(m.clientRequestId),
          ),
        ],
        outbox: s.outbox
            .where((e) => !accepted.contains(e.clientRequestId))
            .toList(),
        optimistic: {...s.optimistic}
          ..removeWhere((id, _) => accepted.contains(id)),
        liveTurn: live,
        sessionStatus: c.terminal
            ? CloudSessionStatus.terminal
            : c.recovering
            ? CloudSessionStatus.unknown
            : CloudSessionStatus.live,
        cursor: detached ? c.streamResume : s.cursor ?? c.streamResume,
        attachment: c.recovering
            ? CloudAttachmentStatus.stale
            : detached
            ? CloudAttachmentStatus.detached
            : s.attachment,
        bootstrapError: null,
        terminalReason: c.terminal ? c.status : null,
      ),
    );
  }

  bool _executionMatches() {
    final execution = _execution, c = _conversation;
    if (execution == null || c == null || !execution.belongsTo(c.running)) {
      return false;
    }
    return !c.messages.any(
      (m) =>
          m.role == 'ASSISTANT' &&
          m.turnId == execution.turnId &&
          m.id == c.running?.assistantMessageId,
    );
  }

  void _recoverConversation() {
    if (_conversation == null) return;
    _conversation = _conversation!.requireRecovery();
    _markStale();
    _effects();
  }

  void _conversationError(ConversationCoreError error) {
    if (error.code == 'AGENT_CONVERSATION_PROTOCOL_MISMATCH') {
      // Rediscover from the server. Preserve the outbox; never guess v1 from a
      // failed v2 call or blindly submit the same request to another session.
      _binding = null;
      _execution = null;
      _provisionalMapper = null;
      _recoverConversation();
      return;
    }
    if (error.sessionId != _conversation?.sessionId) return;
    if (error.code == 'CONVERSATION_VERSION_CONFLICT' ||
        error.code == 'TURN_NOT_QUEUED') {
      _recoverConversation();
    }
  }

  void _conversationFrame(CloudSseFrame raw) {
    Object? data;
    try {
      data = jsonDecode(raw.data);
    } on FormatException {
      _recoverConversation();
      return;
    }
    final frame = parseConversationWireFrame(raw.event ?? '', data);
    switch (frame) {
      case ConversationMalformedFrame():
        _recoverConversation();
        return;
      case ConversationRecoveryFrame(:final value):
        if (value.sessionId == _conversation!.sessionId) _recoverConversation();
        return;
      case ConversationErrorFrame(:final value):
        _conversationError(value);
        return;
      case ConversationChangedFrame(:final value):
        if (value.sessionId != _conversation!.sessionId) return;
        final next = _conversation!.changed(value);
        if (next.recovering) {
          _recoverConversation();
          return;
        }
        _conversation = next;
        _agentTasks.conversationTasks(value.tasks);
        _projectConversation();
      case ConversationOtherFrame():
        if (_conversation!.recovering) return;
        final event = raw.event;
        if (parseCloudWireFrame(event ?? '', data) case CloudWireIgnored(
          :final taskId,
          event: final ignored,
        ) when taskId != null || ignored == 'task.upsert') {
          _agentTasks.frame(event ?? '', data, eventId: raw.id);
          _projectConversation(canonicalChanged: false);
          return;
        }
        var link = ConversationExecution.parse(data);
        final sideEffect = const {
          'tool.call',
          'tool.result',
          'artifact.created',
          'harness.event',
          'harness.warning',
          'error',
        }.contains(event);
        if (link == null &&
            sideEffect &&
            data is Map<String, dynamic> &&
            _executionMatches() &&
            data['sourceKey'] == _execution!.sourceKey) {
          link = _execution;
        }
        if (link == null || !link.belongsTo(_conversation!.running)) return;
        if (_execution != null && !_execution!.matches(link)) {
          if (event != 'message.start' ||
              link.generation <= _execution!.generation) {
            return;
          }
          _execution = null;
          _provisionalMapper = null;
        }
        if (_execution == null) {
          _execution = link;
          _provisionalMapper = CloudTranscriptMapper(
            chatId: _state!.chatId,
            now: _now,
          );
        }
        final payload = data as Map<String, dynamic>;
        final projection = parseCloudWireFrame(event ?? '', payload);
        if (projection is CloudToolFrame) {
          final activity = projection.activity;
          final id = activity.toolCallId;
          if (id != null) {
            (_conversationActivity[link.turnId] ??=
                    {})['${activity.rawKind}:$id'] =
                activity;
          }
        }
        if (event == 'message.delta' || event == 'message.reasoning') {
          final index = payload['streamIndex'];
          if (index is! int || index < _execution!.nextStreamIndex) return;
          _execution!.nextStreamIndex = index + 1;
        }
        // A finish is presentation evidence, never authority to release a turn.
        // The following changed event owns completion/liveness.
        final mapped = event == 'message.finish'
            ? {...payload, 'finalMessage': payload['message']}
            : payload;
        _provisionalMapper!.apply(
          parseCloudWireFrame(event ?? '', mapped),
          eventId: raw.id,
        );
        _projectConversation(canonicalChanged: false);
    }
    // These tokens are deliberately opaque; no v1 numeric cursor comparison.
    _set(
      _state!.copyWith(cursor: raw.id ?? _state!.cursor, lastFrameAt: _now()),
    );
    _effects();
  }

  Future<void> loadOlder() async {
    final c = _conversation, s = _state;
    if (c == null ||
        s == null ||
        _loadingOlder ||
        !c.hasMoreHistory ||
        c.historyCursor == null ||
        c.recovering ||
        !_foreground) {
      return;
    }
    final generation = _generation,
        binding = _binding,
        cursor = c.historyCursor!;
    _loadingOlder = true;
    notifyListenersSafe();
    try {
      final page = await repository
          .getConversationHistory(s.chatId, cursor)
          .timeout(requestTimeout);
      if (!_active(generation) ||
          !identical(binding, _binding) ||
          _conversation?.historyCursor != cursor) {
        return;
      }
      _conversation = _conversation!.history(page);
      _agentTasks.conversationTasks(page.tasks, page.toolActivity);
      _olderHistoryError = null;
      _projectConversation();
    } catch (error) {
      if (_active(generation) && identical(binding, _binding)) {
        authenticationFailures.report(error);
        _olderHistoryError = "Couldn't load older messages. Try again.";
        notifyListenersSafe();
      }
    } finally {
      if (_active(generation)) {
        _loadingOlder = false;
        notifyListenersSafe();
      }
    }
  }

  Future<void> commandTurn(
    String turnId,
    ConversationTurnOperation operation, {
    String? content,
  }) async {
    final c = _conversation, s = _state;
    if (c == null || s == null || c.recovering || !c.ready) return;
    final generation = _generation, binding = _binding;
    final key = jsonEncode([turnId, operation.name, content]);
    if (!_postingCommands.add(key)) return;
    final input = _pendingCommands.putIfAbsent(
      key,
      () => ConversationCommandInput(
        commandId: randomUuidV4(),
        expectedStateVersion: c.version,
        content: content,
      ),
    );
    try {
      final receipt = await repository
          .conversationCommand(s.chatId, turnId, operation, input)
          .timeout(requestTimeout);
      if (!_active(generation) || !identical(binding, _binding)) return;
      if (receipt.commandId != input.commandId) {
        throw const FormatException('Command receipt identity mismatch');
      }
      _pendingCommands.remove(key);
      _conversation = _conversation!.receipt(receipt);
      if (_conversation!.recovering) _recoverConversation();
    } catch (error) {
      if (_active(generation) && identical(binding, _binding)) {
        authenticationFailures.report(error);
        if (error is CloudSendError && error.coreError != null) {
          _pendingCommands.remove(key);
          _conversationError(error.coreError!);
        }
        _set(
          _state!.copyWith(
            bootstrapError: "Couldn't update the queued message. Try again.",
          ),
        );
        _recoverConversation();
      }
    } finally {
      if (_active(generation) && identical(binding, _binding)) {
        _postingCommands.remove(key);
      }
    }
  }

  Future<void> _interruptConversation() async {
    if (!_executionMatches() || !(_state?.canInterrupt ?? false)) return;
    final execution = _execution!, generation = _generation, binding = _binding;
    try {
      final result = await repository
          .interruptTurn(_state!.chatId, execution.sourceKey)
          .timeout(requestTimeout);
      if (!_active(generation) ||
          !identical(binding, _binding) ||
          _execution == null ||
          !_execution!.matches(execution)) {
        return;
      }
      if (result.outcome == AgentTurnInterruptOutcome.interruptRequested &&
          result.turnId == execution.sourceKey) {
        final turn = _state!.liveTurn!;
        _set(
          _state!.copyWith(
            liveTurn: CloudLiveTurn(
              turnId: turn.turnId,
              userMessageId: turn.userMessageId,
              startedAt: turn.startedAt,
              interrupting: true,
            ),
          ),
        );
      } else {
        _recoverConversation();
      }
    } catch (error) {
      if (_active(generation) && identical(binding, _binding)) {
        authenticationFailures.report(error);
        _set(_state!.copyWith(bootstrapError: _chatInterruptError));
      }
    }
  }
}
