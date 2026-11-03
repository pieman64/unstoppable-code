import 'dart:async';

import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

enum RemoteWatcherDeleteFailure {
  notFoundOrFiring,
  forbidden,
  unsupported,
  failed,
  unconfirmed,
}

final class RemoteWatcherDeleteException extends RemoteControlException {
  const RemoteWatcherDeleteException(this.failure, super.message);

  final RemoteWatcherDeleteFailure failure;
}

typedef RemoteWatcherCommandSubmit =
    Future<RemotePortalCommandResult> Function(
      String sessionId, {
      required String type,
      required Map<String, dynamic> payload,
    });

/// Watcher commands use the existing paired-session transport. A queued
/// command is not a successful delete: its completion arrives in the event
/// stream. Subscribe before sending, since completion may beat the HTTP reply.
final class RemoteWatcherCommands {
  RemoteWatcherCommands({
    required this._hasCapability,
    required this._submit,
    required this._events,
    this.completionTimeout = const Duration(seconds: 30),
  });

  final bool Function(String capability) _hasCapability;
  final RemoteWatcherCommandSubmit _submit;
  final Stream<RemotePortalEventBatch> _events;
  final Duration completionTimeout;
  final _pending = <Completer<RemotePortalEvent>>{};
  int _sessionGeneration = 0;

  /// The repository calls this before clearing or replacing its pairing.
  void invalidateSession() {
    _sessionGeneration++;
    _finishPending(const RemoteSessionEndedEvent());
  }

  /// The repository keeps its broadcast stream open across transport outages.
  void deliveryStopped() => _finishPending(
    const RemoteUnknownPortalEvent('watcher.delivery_stopped'),
  );

  void _finishPending(RemotePortalEvent event) {
    for (final completion in _pending) {
      if (!completion.isCompleted) completion.complete(event);
    }
  }

  bool get supportsChatWatchers => _hasCapability('chat_watchers');

  Future<void> deleteWatcher(
    String sessionId,
    String watcherId, {
    required bool notifySubscriber,
  }) async {
    if (!supportsChatWatchers) {
      throw const RemoteWatcherDeleteException(
        RemoteWatcherDeleteFailure.unsupported,
        'Update the desktop app to manage chat watchers.',
      );
    }
    final sessionGeneration = _sessionGeneration;
    final completion = Completer<RemotePortalEvent>();
    _pending.add(completion);
    final early = <RemotePortalEvent>[];
    String? commandId;
    void observe(RemotePortalEvent event) {
      final id = switch (event) {
        RemoteCommandCompletedEvent(:final commandId) => commandId,
        RemoteCommandFailedEvent(:final commandId) => commandId,
        _ => null,
      };
      if (event is RemoteSessionEndedEvent ||
          (commandId != null && id == commandId)) {
        if (!completion.isCompleted) completion.complete(event);
      } else if (commandId == null && id != null) {
        early.add(event);
      }
    }

    void deliveryStopped() {
      if (!completion.isCompleted) {
        completion.complete(
          const RemoteUnknownPortalEvent('watcher.delivery_stopped'),
        );
      }
    }

    final subscription = _events.listen(
      (batch) {
        if (batch.connectionStatus == RemotePortalConnectionStatus.ended) {
          observe(const RemoteSessionEndedEvent());
          return;
        }
        for (final event in batch.events) {
          observe(event);
        }
      },
      onDone: deliveryStopped,
      onError: (Object _) => deliveryStopped(),
    );
    try {
      // Session termination or delivery loss can precede the HTTP reply.
      // Future.any also handles a late reply/error after the caller returns.
      final event = await Future.any<RemotePortalEvent>([
        completion.future,
        (() async {
          final response = await _submit(
            sessionId,
            type: 'portal.watcher.delete',
            payload: {
              'watcherId': watcherId,
              'notifySubscriber': notifySubscriber,
            },
          );
          commandId = response.commandId;
          if (response.error case final error?) {
            throw RemoteWatcherDeleteException(
              RemoteWatcherDeleteFailure.failed,
              error,
            );
          }
          if (response.result?['ok'] == true) {
            return RemoteCommandCompletedEvent(
              commandId: response.commandId,
              result: response.result,
            );
          }
          for (final event in List.of(early)) {
            observe(event);
          }
          early.clear();
          return completion.future;
        })(),
      ]).timeout(completionTimeout);
      // An inline reply may already be scheduled when the pairing changes.
      // It still belongs to the discarded pairing, even if its ID is reused.
      switch (sessionGeneration == _sessionGeneration
          ? event
          : const RemoteSessionEndedEvent()) {
        case RemoteCommandCompletedEvent(:final result)
            when result?['ok'] == true:
          return;
        case RemoteCommandFailedEvent(:final code, :final message):
          throw RemoteWatcherDeleteException(_failure(code), message);
        case RemoteSessionEndedEvent():
          throw const RemoteWatcherDeleteException(
            RemoteWatcherDeleteFailure.forbidden,
            'This paired session has ended.',
          );
        default:
          throw const RemoteWatcherDeleteException(
            RemoteWatcherDeleteFailure.failed,
            'Could not delete the watcher. Try again.',
          );
      }
    } on TimeoutException {
      throw const RemoteWatcherDeleteException(
        RemoteWatcherDeleteFailure.unconfirmed,
        'The desktop has not confirmed deletion. Check the watcher before trying again.',
      );
    } on ApiException catch (error) {
      throw RemoteWatcherDeleteException(switch (error.statusCode) {
        401 || 403 => RemoteWatcherDeleteFailure.forbidden,
        422 => RemoteWatcherDeleteFailure.unsupported,
        _ => RemoteWatcherDeleteFailure.failed,
      }, apiErrorMessage(error) ?? 'Could not delete the watcher. Try again.');
    } finally {
      _pending.remove(completion);
      deliveryStopped();
      early.clear();
      await subscription.cancel();
    }
  }
}

RemoteWatcherDeleteFailure _failure(String? code) => switch (code) {
  'not_found_or_firing' => RemoteWatcherDeleteFailure.notFoundOrFiring,
  'forbidden' => RemoteWatcherDeleteFailure.forbidden,
  'unsupported_type' ||
  'unsupported' ||
  'unsupported_command' => RemoteWatcherDeleteFailure.unsupported,
  _ => RemoteWatcherDeleteFailure.failed,
};
