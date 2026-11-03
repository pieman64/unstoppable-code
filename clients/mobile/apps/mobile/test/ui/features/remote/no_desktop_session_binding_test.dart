import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_destination_store.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/chat_destination_preference_store.dart';
import 'package:mobile/ui/composition/new_chat/new_chat_draft.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/views/no_desktop_session_binding.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

import '../../../support/cloud_chat_providers.dart';
import '../../../support/fake_remote_control_repository.dart';

/// The Portal refuses a guest's probe (401), which the repository reports as
/// inconclusive.
final class _RefusedProbeRepository extends FakeRemoteControlRepository {
  int probeCalls = 0;

  @override
  Future<RemoteSessionProbe> probeSession() async {
    probeCalls++;
    return const (outcome: RemoteSessionProbeOutcome.unknown, connection: null);
  }
}

// CAN-2872: a guest cannot pair a desktop.
void main() {
  late _RefusedProbeRepository repository;
  late RemoteControlViewModel remote;

  setUp(() {
    repository = _RefusedProbeRepository();
    remote = RemoteControlViewModel(repository: repository);
  });

  tearDown(() {
    // Stops the restore retry an inconclusive probe arms.
    remote.onAppBackgrounded();
    remote.dispose();
  });

  Future<void> pumpNewChat(WidgetTester tester, {required bool guest}) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    const draft = NewChatDraft(isActive: true);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
          // Remembered on this device from an account that had a computer.
          Provider<ChatDestinationStore>.value(
            value: InMemoryChatDestinationStore('computer:Studio Mac'),
          ),
          ...cloudChatTestProviders(draftStore: InMemoryChatDraftStore()),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          home: guest ? const NoDesktopSessionBinding(child: draft) : draft,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('without the binding, a refused probe leaves a remembered '
      'computer connecting', (tester) async {
    await pumpNewChat(tester, guest: false);
    unawaited(remote.restoreIfIdle());
    await tester.pumpAndSettle();

    expect(remote.hasProbedSession, isFalse);
    expect(
      find.byKey(const ValueKey('new-chat-computer-draft-computer:Studio Mac')),
      findsOneWidget,
    );
    // Stops the restore retry the refused probe armed.
    remote.onAppBackgrounded();
  });

  testWidgets('a guest new chat ignores a remembered computer and starts on '
      'Cloud, without probing', (tester) async {
    await pumpNewChat(tester, guest: true);
    unawaited(remote.restoreIfIdle());
    await tester.pumpAndSettle();

    expect(remote.hasProbedSession, isTrue);
    expect(remote.status, RemoteConnectionStatus.disconnected);
    expect(repository.probeCalls, 0);
    expect(find.byKey(const ValueKey('new-chat-cloud-draft')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  // The guest-to-account switch normally rebuilds the shell's providers, but
  // the settle must not depend on it.
  testWidgets('leaving the binding lets the next session restore its desktop', (
    tester,
  ) async {
    final paired = _PairedRepository();
    final vm = RemoteControlViewModel(repository: paired);
    addTearDown(vm.dispose);
    Widget host(Widget child) =>
        ChangeNotifierProvider<RemoteControlViewModel>.value(
          value: vm,
          child: MaterialApp(home: child),
        );

    await tester.pumpWidget(
      host(const NoDesktopSessionBinding(child: SizedBox())),
    );
    await tester.runAsync(vm.restoreIfIdle);
    expect(paired.probeCalls, 0);

    // The account's shell replaces the guest's in the same provider scope.
    await tester.pumpWidget(host(const SizedBox()));
    expect(vm.hasProbedSession, isFalse);
    await tester.runAsync(vm.restoreIfIdle);
    await tester.pump();

    expect(paired.probeCalls, 1);
    expect(vm.isConnected, isTrue);
    expect(vm.connection?.deviceLabel, 'Studio Mac');
  });

  test('settling drops a probe already in flight', () async {
    final gate = Completer<RemoteSessionProbe>();
    final gated = _GatedRepository(gate.future);
    final vm = RemoteControlViewModel(repository: gated);
    addTearDown(vm.dispose);

    final restore = vm.restoreIfIdle();
    vm.settleWithoutDesktop();
    gate.complete(const (
      outcome: RemoteSessionProbeOutcome.unknown,
      connection: null,
    ));
    await restore;

    expect(vm.hasProbedSession, isTrue);
    expect(vm.isRestoring, isFalse);
    expect(vm.isRestoreRetrying, isFalse);
  });
}

final class _GatedRepository extends FakeRemoteControlRepository {
  _GatedRepository(this._probe);

  final Future<RemoteSessionProbe> _probe;

  @override
  Future<RemoteSessionProbe> probeSession() => _probe;
}

final class _PairedRepository extends FakeRemoteControlRepository {
  int probeCalls = 0;

  @override
  Future<RemoteSessionProbe> probeSession() async {
    probeCalls++;
    return (
      outcome: RemoteSessionProbeOutcome.renderable,
      connection: RemoteConnection(
        deviceLabel: 'Studio Mac',
        pairedAt: DateTime(2026),
      ),
    );
  }
}
