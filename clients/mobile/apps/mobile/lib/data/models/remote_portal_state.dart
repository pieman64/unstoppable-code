import 'remote_session.dart';
import 'remote_cached_chat_tail.dart';
import 'remote_portal_event.dart';
import 'remote_provider_usage.dart';

/// `GET .../sessions/{id}/state` response (`GetBrowserPortalStateResponse`):
/// Projected state and the cursor committed atomically with that projection.
class RemotePortalStateResult {
  const RemotePortalStateResult({
    required this.snapshot,
    this.connectionStatus,
    this.eventCursor,
    this.refreshing = false,
    this.projectionPending = false,
    this.chatTailCoverage,
  });

  final RemoteSessionSnapshot snapshot;
  final RemotePortalConnectionStatus? connectionStatus;

  /// Highest event represented in this projection. Only the initial overview
  /// read may seed the session stream; a scoped chat read must not advance it.
  final int? eventCursor;

  /// True when the server transparently enqueued a refresh state request.
  final bool refreshing;
  final bool projectionPending;
  final RemoteChatTailCoverage? chatTailCoverage;

  factory RemotePortalStateResult.fromJson(Map<String, dynamic> json) {
    final state = json['state'];
    final status = json['connectionStatus'];
    final cursor = json['eventCursor'];
    final rawSnapshot = json['snapshot'];
    final providerUsage =
        rawSnapshot is Map<String, dynamic> &&
            rawSnapshot['scope'] == 'overview'
        ? parseProviderUsageEntities(
            rawSnapshot['entities'],
            authoritative: true,
          )
        : null;
    return RemotePortalStateResult(
      snapshot: RemoteSessionSnapshot.fromJson(
        state is Map<String, dynamic> ? state : const {},
      ).copyWith(providerUsage: providerUsage),
      connectionStatus: RemotePortalConnectionStatus.fromWire(
        status is String ? status : null,
      ),
      eventCursor: cursor is int && cursor >= 0 ? cursor : null,
      refreshing: json['refreshing'] == true,
      projectionPending: json['projectionPending'] == true,
      chatTailCoverage: RemoteChatTailCoverage.fromJson(
        json['chatTailCoverage'],
      ),
    );
  }
}
