import 'dart:async';

import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

/// How long a clone submit may go unanswered before its outcome counts as
/// unknown, and the bound on one status read. The server answers a submit
/// within about a second, after which the clone continues on the desktop.
const Duration kRemoteProjectCreateTimeout = Duration(seconds: 30);

/// Submits one untargeted Portal command on the paired session and returns
/// the server's answer.
typedef RemoteUntargetedCommandSubmit =
    Future<RemotePortalCommandResult> Function({
      required String type,
      required Map<String, dynamic> payload,
    });

/// What one `portal.workspace.create` remote clone submit established.
sealed class RemoteProjectCreateOutcome {
  const RemoteProjectCreateOutcome();
}

/// The desktop cloned the repository within the server's wait.
final class RemoteProjectCreateCompleted extends RemoteProjectCreateOutcome {
  const RemoteProjectCreateCompleted({required this.workspaceId});

  final String workspaceId;
}

/// The server accepted the clone; its result arrives later for [commandId].
final class RemoteProjectCreatePending extends RemoteProjectCreateOutcome {
  const RemoteProjectCreatePending({
    required this.commandId,
    required this.queuedWhileReconnecting,
  });

  final String commandId;

  /// The desktop is reconnecting; the clone starts when it is back.
  final bool queuedWhileReconnecting;
}

/// The server or desktop rejected the clone.
final class RemoteProjectCreateFailed extends RemoteProjectCreateOutcome {
  const RemoteProjectCreateFailed(this.message);

  final String message;
}

/// The clone may have been accepted, but its answer was lost or unusable.
final class RemoteProjectCreateUnknown extends RemoteProjectCreateOutcome {
  const RemoteProjectCreateUnknown();
}

/// Adds projects to the paired desktop by cloning a git URL
/// (`portal.workspace.create`, CAN-3988).
final class RemoteProjectCommands {
  const RemoteProjectCommands({
    required this._submit,
    required this._readStatus,
  });

  final RemoteUntargetedCommandSubmit _submit;
  final Future<BrowserPortalCommandStatusResponse> Function(String commandId)
  _readStatus;

  /// Sends one `portal.workspace.create` remote clone of [remoteUrl] into
  /// Personal on the paired desktop. Never retries: a clone is not
  /// idempotent, so a lost answer is [RemoteProjectCreateUnknown].
  Future<RemoteProjectCreateOutcome> createProjectFromGitUrl(
    String remoteUrl,
  ) async {
    final RemotePortalCommandResult response;
    try {
      response = await _submit(
        type: 'portal.workspace.create',
        payload: {'kind': 'remote-clone', 'remoteUrl': remoteUrl.trim()},
      ).timeout(kRemoteProjectCreateTimeout);
    } on RemoteControlException catch (error) {
      // Raised before sending, for example with no paired session.
      return RemoteProjectCreateFailed(error.message);
    } on ApiException catch (error) {
      return _rejectionOrUnknown(error);
    } catch (_) {
      // Transport loss, timeout or an unreadable answer: the server may
      // have queued the clone.
      return const RemoteProjectCreateUnknown();
    }
    if (response.error case final error? when error.isNotEmpty) {
      return RemoteProjectCreateFailed(error);
    }
    final result = response.result;
    if (result != null) {
      final workspaceId = result['workspaceId'];
      return workspaceId is String && workspaceId.isNotEmpty
          ? RemoteProjectCreateCompleted(workspaceId: workspaceId)
          : const RemoteProjectCreateUnknown();
    }
    if (response.commandId.isEmpty) return const RemoteProjectCreateUnknown();
    return RemoteProjectCreatePending(
      commandId: response.commandId,
      queuedWhileReconnecting: response.queuedWhileReconnecting,
    );
  }

  /// Reads [commandId]'s status, for a clone whose terminal event was missed.
  /// Bounded, so one stalled read cannot hold back the next.
  Future<BrowserPortalCommandStatusResponse> commandStatus(String commandId) =>
      _readStatus(commandId).timeout(kRemoteProjectCreateTimeout);

  /// A 408 or 5xx may come after the server queued the clone; only the
  /// documented pre-enqueue 503 and 4xx answers prove nothing was sent.
  static RemoteProjectCreateOutcome _rejectionOrUnknown(ApiException error) {
    final message = apiErrorMessage(error);
    final rejectedBeforeEnqueue =
        error.statusCode == 503 &&
        message == 'Secure command delivery is unavailable.';
    if (!rejectedBeforeEnqueue &&
        (error.statusCode == 408 || error.statusCode >= 500)) {
      return const RemoteProjectCreateUnknown();
    }
    return RemoteProjectCreateFailed(
      message ?? 'The desktop did not accept the request.',
    );
  }
}
