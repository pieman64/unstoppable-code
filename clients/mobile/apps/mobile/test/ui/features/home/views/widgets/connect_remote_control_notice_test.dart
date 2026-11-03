import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/home/views/widgets/connect_remote_control_notice.dart';

const _notice = ValueKey('activity-connect-remote-control');

Widget _subject({
  required RemoteConnectionStatus status,
  required bool hasProbedSession,
  required VoidCallback? onConnect,
}) => MaterialApp(
  theme: AppTheme.light,
  home: Scaffold(
    body: ConnectRemoteControlNotice(
      status: status,
      hasProbedSession: hasProbedSession,
      onConnect: onConnect,
    ),
  ),
);

void main() {
  testWidgets('shows the prompt once the probe finds no pairing, and Connect '
      'runs the shell action (CAN-3715)', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    var connects = 0;
    await tester.pumpWidget(
      _subject(
        status: RemoteConnectionStatus.disconnected,
        hasProbedSession: true,
        onConnect: () => connects++,
      ),
    );

    expect(
      find.text('Connect Remote Control to open chats from notifications.'),
      findsOneWidget,
    );
    await tester.tap(find.text('Connect'));
    expect(connects, 1);
    expect(tester.takeException(), isNull);
  });

  for (final status in RemoteConnectionStatus.values) {
    for (final hasProbedSession in [false, true]) {
      if (status == RemoteConnectionStatus.disconnected && hasProbedSession) {
        continue;
      }
      testWidgets('hides the prompt while ${status.name}'
          '${hasProbedSession ? '' : ' before the probe answers'} '
          '(CAN-3715)', (tester) async {
        await tester.pumpWidget(
          _subject(
            status: status,
            hasProbedSession: hasProbedSession,
            onConnect: () {},
          ),
        );
        expect(find.byKey(_notice), findsNothing);
      });
    }
  }

  testWidgets('hides the prompt when the shell has no Remote tab (CAN-3715)', (
    tester,
  ) async {
    await tester.pumpWidget(
      _subject(
        status: RemoteConnectionStatus.disconnected,
        hasProbedSession: true,
        onConnect: null,
      ),
    );
    expect(find.byKey(_notice), findsNothing);
  });
}
