import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

/// Gives a brand-new cloud account its first project, as the web client does
/// on first load, so the Chat landing screen can send without a web visit.
///
/// Sits in the authenticated shell because it needs both the cloud project
/// list and the desktop pairing: a user with a paired desktop is not a
/// first-run user even when they have no cloud project, so the decision waits
/// until the pairing probe has answered. [CloudChatsViewModel] owns the
/// once-per-account decision; this only feeds it the pairing state.
class CloudFirstProjectBinding extends StatefulWidget {
  const CloudFirstProjectBinding({super.key, required this.child});

  final Widget child;

  @override
  State<CloudFirstProjectBinding> createState() =>
      _CloudFirstProjectBindingState();
}

class _CloudFirstProjectBindingState extends State<CloudFirstProjectBinding> {
  late final CloudChatsViewModel _list = context.read<CloudChatsViewModel>();
  late final RemoteControlViewModel _remote = context
      .read<RemoteControlViewModel>();
  bool _evaluationScheduled = false;

  @override
  void initState() {
    super.initState();
    // The child reads this on its first build. Notifying a Provider while the
    // binding itself mounts would mark an ancestor dirty mid-build.
    _list.setFirstProjectPairingPending(true, notify: false);
    _list.addListener(_scheduleEvaluation);
    _remote.addListener(_scheduleEvaluation);
    // Post-frame: both calls notify synchronously, which the first build
    // forbids. Each is a no-op when a screen has already started it.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_list.load());
      unawaited(_remote.restoreIfIdle());
    });
  }

  @override
  void dispose() {
    _list.removeListener(_scheduleEvaluation);
    _remote.removeListener(_scheduleEvaluation);
    super.dispose();
  }

  /// Coalesces bursts of notifications into one evaluation, outside the
  /// notifying call, since starting a provision notifies in turn.
  void _scheduleEvaluation() {
    if (_evaluationScheduled) return;
    _evaluationScheduled = true;
    scheduleMicrotask(() {
      _evaluationScheduled = false;
      if (!mounted) return;
      // Pairing, a pairing attempt, or a pairing error all mean this user
      // works with a desktop. Disconnected means "no desktop" only once the
      // probe has answered.
      final paired = _remote.status != RemoteConnectionStatus.disconnected;
      if (!paired && !_remote.hasProbedSession) return;
      unawaited(_list.provisionFirstProjectIfNeeded(pairedDesktop: paired));
      _list.setFirstProjectPairingPending(false);
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
