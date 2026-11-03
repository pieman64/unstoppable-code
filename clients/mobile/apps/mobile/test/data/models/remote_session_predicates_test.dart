/// Case-for-case mirror of
/// `apps/web/src/components/portal/__tests__/portal-session-predicates.test.ts`.
/// If a case is added there, add it here (and vice versa) — the two predicate
/// implementations are only useful while they agree.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session_predicates.dart';

void main() {
  group('canRenderRemoteShell', () {
    test('renders shell for active session with active connection', () {
      expect(
        canRenderRemoteShell(
          sessionStatus: 'active',
          connectionStatus: RemotePortalConnectionStatus.active,
        ),
        isTrue,
      );
    });

    test('renders shell for active session with reconnecting connection', () {
      expect(
        canRenderRemoteShell(
          sessionStatus: 'active',
          connectionStatus: RemotePortalConnectionStatus.reconnecting,
        ),
        isTrue,
      );
    });

    test('renders shell for inactive session with inactive connection', () {
      // The cached shell stays visible during the inactive grace window so
      // the user keeps a useful surface while the desktop is offline.
      expect(
        canRenderRemoteShell(
          sessionStatus: 'inactive',
          connectionStatus: RemotePortalConnectionStatus.inactive,
        ),
        isTrue,
      );
    });

    test('does not render shell for pending_auth session', () {
      expect(
        canRenderRemoteShell(
          sessionStatus: 'pending_auth',
          connectionStatus: RemotePortalConnectionStatus.pending,
        ),
        isFalse,
      );
    });

    test('does not render shell when connection has ended', () {
      expect(
        canRenderRemoteShell(
          sessionStatus: 'inactive',
          connectionStatus: RemotePortalConnectionStatus.ended,
        ),
        isFalse,
      );
    });

    test('does not render shell with a missing session status', () {
      expect(
        canRenderRemoteShell(sessionStatus: null, connectionStatus: null),
        isFalse,
      );
    });
  });

  group('shouldShowRemoteCodeForm', () {
    test('shows the form when there is no session', () {
      expect(
        shouldShowRemoteCodeForm(
          hasSession: false,
          sessionStatus: null,
          connectionStatus: null,
        ),
        isTrue,
      );
    });

    test('shows the form for pending_auth sessions', () {
      expect(
        shouldShowRemoteCodeForm(
          hasSession: true,
          sessionStatus: 'pending_auth',
          connectionStatus: RemotePortalConnectionStatus.pending,
        ),
        isTrue,
      );
    });

    test('shows the form when the connection has fully ended', () {
      expect(
        shouldShowRemoteCodeForm(
          hasSession: true,
          sessionStatus: 'active',
          connectionStatus: RemotePortalConnectionStatus.ended,
        ),
        isTrue,
      );
    });

    test('keeps the cached shell for an inactive session', () {
      expect(
        shouldShowRemoteCodeForm(
          hasSession: true,
          sessionStatus: 'inactive',
          connectionStatus: RemotePortalConnectionStatus.inactive,
        ),
        isFalse,
      );
    });

    test('keeps the shell for a reconnecting session', () {
      expect(
        shouldShowRemoteCodeForm(
          hasSession: true,
          sessionStatus: 'active',
          connectionStatus: RemotePortalConnectionStatus.reconnecting,
        ),
        isFalse,
      );
    });
  });
}
