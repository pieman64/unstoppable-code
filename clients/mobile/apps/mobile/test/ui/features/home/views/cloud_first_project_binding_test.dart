import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chats_screen.dart';
import 'package:mobile/ui/features/home/views/cloud_first_project_binding.dart';
import 'package:mobile/ui/features/remote/views/no_desktop_session_binding.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

import '../../../../support/fake_cloud_chat_repository.dart';
import '../../../../support/fake_remote_control_repository.dart';

/// Holds the pairing probe open until the test answers it.
final class _GatedRemoteRepository extends FakeRemoteControlRepository {
  /// Late so it is created inside the test's fake-async zone, where
  /// completing it is flushed by `pump`, rather than in `setUp`.
  late final Completer<RemoteSessionProbe> probe = Completer();
  int probeCalls = 0;

  @override
  Future<RemoteSessionProbe> probeSession() {
    probeCalls++;
    return probe.future;
  }
}

void main() {
  late FakeCloudChatRepository cloud;
  late _GatedRemoteRepository remoteRepository;
  late CloudChatsViewModel list;
  late RemoteControlViewModel remote;

  setUp(() {
    cloud = FakeCloudChatRepository();
    remoteRepository = _GatedRemoteRepository();
    list = CloudChatsViewModel(repository: cloud);
    remote = RemoteControlViewModel(repository: remoteRepository);
  });

  tearDown(() {
    list.dispose();
    remote.dispose();
  });

  Future<void> mountBinding(
    WidgetTester tester, {
    Widget? Function(Widget)? wrap,
  }) {
    const binding = CloudFirstProjectBinding(
      child: SizedBox(key: ValueKey('shell')),
    );
    return tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
          ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
        ],
        child: wrap?.call(binding) ?? binding,
      ),
    );
  }

  // CAN-2872: the Portal refuses a guest, so its probe would only ever come
  // back inconclusive and the guest would never get a project to chat in.
  testWidgets('a guest shell provisions without a pairing probe', (
    tester,
  ) async {
    await mountBinding(
      tester,
      wrap: (child) => NoDesktopSessionBinding(child: child),
    );
    await tester.pumpAndSettle();

    expect(cloud.provisionCalls, ['My project']);
    expect(list.workspaces.map((w) => w.name), ['My project']);
    expect(remoteRepository.probe.isCompleted, isFalse);
    expect(remoteRepository.probeCalls, 0);
  });

  testWidgets('provisions once the pairing probe finds no desktop', (
    tester,
  ) async {
    await mountBinding(tester);
    await tester.pumpAndSettle();

    // The project list has answered empty, but a paired desktop user must not
    // get a cloud project, so nothing happens until the probe answers.
    expect(list.cloudAvailable, isTrue);
    expect(cloud.provisionCalls, isEmpty);

    remoteRepository.probe.complete(const (
      outcome: RemoteSessionProbeOutcome.gone,
      connection: null,
    ));
    await tester.pumpAndSettle();

    expect(cloud.provisionCalls, ['My project']);
    expect(list.workspaces.map((w) => w.name), ['My project']);
    expect(find.byKey(const ValueKey('shell')), findsOneWidget);
  });

  testWidgets('a restored desktop pairing skips provisioning', (tester) async {
    await mountBinding(tester);
    await tester.pumpAndSettle();

    remoteRepository.probe.complete((
      outcome: RemoteSessionProbeOutcome.renderable,
      connection: RemoteConnection(
        deviceLabel: 'Studio Mac',
        pairedAt: DateTime(2026),
      ),
    ));
    await tester.pumpAndSettle();

    expect(remote.isConnected, isTrue);
    expect(cloud.provisionCalls, isEmpty);
    expect(list.workspaces, isEmpty);
  });

  testWidgets('an inconclusive pairing probe does not provision', (
    tester,
  ) async {
    await mountBinding(tester);
    await tester.pumpAndSettle();

    remoteRepository.probe.complete(const (
      outcome: RemoteSessionProbeOutcome.unknown,
      connection: null,
    ));
    await tester.pumpAndSettle();

    expect(remote.status, RemoteConnectionStatus.disconnected);
    expect(remote.hasProbedSession, isFalse);
    expect(cloud.provisionCalls, isEmpty);
    // Stops the restore retry the inconclusive probe armed (CAN-3557).
    remote.onAppBackgrounded();
  });

  testWidgets('a thrown pairing probe does not provision', (tester) async {
    await mountBinding(tester);
    await tester.pumpAndSettle();

    remoteRepository.probe.completeError(StateError('temporary outage'));
    await tester.pumpAndSettle();

    expect(remote.status, RemoteConnectionStatus.disconnected);
    expect(remote.hasProbedSession, isFalse);
    expect(cloud.provisionCalls, isEmpty);
    // Stops the restore retry the inconclusive probe armed (CAN-3557).
    remote.onAppBackgrounded();
  });

  testWidgets(
    'the cloud list waits for the pairing decision before empty state',
    (tester) async {
      final chat = CloudChatViewModel(
        repository: cloud,
        openStream: (_, {after}) => const Stream.empty(),
        observeLifecycle: false,
      );
      addTearDown(chat.dispose);
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
            ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
            ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
          ],
          child: const MaterialApp(
            home: CloudFirstProjectBinding(child: CloudChatsScreen()),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(list.cloudAvailable, isTrue);
      expect(find.byKey(const ValueKey('cloud-chats-empty')), findsNothing);
      expect(
        find.text('Create a project on the web to start chatting here.'),
        findsNothing,
      );

      remoteRepository.probe.complete(const (
        outcome: RemoteSessionProbeOutcome.gone,
        connection: null,
      ));
      await tester.pump();
      await tester.pump();
      expect(cloud.provisionCalls, ['My project']);
    },
  );

  testWidgets('the new-chat selector waits for the pairing decision', (
    tester,
  ) async {
    final chat = CloudChatViewModel(
      repository: cloud,
      openStream: (_, {after}) => const Stream.empty(),
      observeLifecycle: false,
    );
    addTearDown(chat.dispose);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
          ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
          ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
        ],
        child: const MaterialApp(
          home: CloudFirstProjectBinding(child: CloudChatScreen.create()),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(list.cloudAvailable, isTrue);
    expect(find.byKey(const ValueKey('cloud-new-chat-project')), findsNothing);
    expect(find.text('No project'), findsNothing);

    remoteRepository.probe.complete(const (
      outcome: RemoteSessionProbeOutcome.gone,
      connection: null,
    ));
    await tester.pump();
    await tester.pump();
    expect(cloud.provisionCalls, ['My project']);
  });
}
