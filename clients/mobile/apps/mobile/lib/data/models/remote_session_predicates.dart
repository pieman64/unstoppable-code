/// Mobile mirror of the Remote Control session predicates.
///
/// **Source of truth:** `apps/web/src/components/portal/portal-session-predicates.ts`
/// (truth table pinned by its `__tests__/portal-session-predicates.test.ts`).
/// Keep this file case-for-case identical to that one; the mobile test suite
/// mirrors the same table.
///
/// Hand-written rather than generated: the surrounding
/// `remote_connection.dart` models are already deliberately mobile-local, and
/// `mobile-protocol-drift.yml` only covers `lib/data/protocol/generated/**`.
///
/// Why this matters (CAN-2651): the server's every-minute sweep flips a
/// session whose desktop heartbeat lapsed past 90s to `inactive` while leaving
/// it revivable. Mobile used to reject anything that was not `active`, which
/// dropped the user to the six-digit pairing form for a session that was about
/// to heal on its own.
library;

import 'package:mobile/data/models/remote_portal_event.dart';

/// When can the cached Remote Control shell render?
///
/// The shell renders for any session whose lifecycle is `active` or `inactive`
/// and whose connection is still in the shell-eligible band (`active` /
/// `reconnecting` / `inactive`). Anything else — `pending_auth`, a missing
/// session, or a connection that has fully `ended` — must fall through to
/// pairing.
bool canRenderRemoteShell({
  required String? sessionStatus,
  required RemotePortalConnectionStatus? connectionStatus,
}) {
  if (sessionStatus != 'active' && sessionStatus != 'inactive') return false;
  return connectionStatus == RemotePortalConnectionStatus.active ||
      connectionStatus == RemotePortalConnectionStatus.reconnecting ||
      connectionStatus == RemotePortalConnectionStatus.inactive;
}

/// When must pairing be offered?
///
/// True only when there is no usable session — absent, `pending_auth`, a fully
/// `ended` connection, or any state that fails [canRenderRemoteShell].
bool shouldShowRemoteCodeForm({
  required bool hasSession,
  required String? sessionStatus,
  required RemotePortalConnectionStatus? connectionStatus,
}) {
  if (!hasSession) return true;
  if (sessionStatus == 'pending_auth') return true;
  if (connectionStatus == RemotePortalConnectionStatus.ended) return true;
  return !canRenderRemoteShell(
    sessionStatus: sessionStatus,
    connectionStatus: connectionStatus,
  );
}
