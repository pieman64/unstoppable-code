import 'package:flutter/widgets.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

/// Mounts a shell whose session cannot pair a desktop, such as a guest's
/// (CAN-2872). It settles the nearest [RemoteControlViewModel] as having no
/// desktop before anything below reads it, so account prompts and the
/// new chat's destination decide without waiting on a pairing probe the
/// Portal would refuse. Leaving undoes the settle, so it cannot outlive the
/// guest even if the same view model serves the next session.
class NoDesktopSessionBinding extends StatefulWidget {
  const NoDesktopSessionBinding({super.key, required this.child});

  final Widget child;

  @override
  State<NoDesktopSessionBinding> createState() =>
      _NoDesktopSessionBindingState();
}

class _NoDesktopSessionBindingState extends State<NoDesktopSessionBinding> {
  late final RemoteControlViewModel _remote = context
      .read<RemoteControlViewModel>();

  @override
  void initState() {
    super.initState();
    // No notification: nothing below has built, and notifying a provider
    // while this mounts would mark an ancestor dirty mid-build.
    _remote.settleWithoutDesktop(notify: false);
  }

  @override
  void dispose() {
    _remote.allowDesktop(notify: false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
