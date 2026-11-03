import 'dart:async';

import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/remote/view_models/remote_connection_status_label.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/chat_search_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:mobile/ui/features/remote/views/widgets/workspaces_list_view.dart';
import 'package:provider/provider.dart';

/// The "Remote" tab root: the mobile Remote Control surface.
///
/// Switches its body on the pairing [RemoteConnectionStatus].  The
/// [RemoteConnectionStatus.error] state reuses [ConnectDesktopView] (which
/// surfaces the failure inline on the code field) rather than a dead-end error
/// page, so a rejected code lands the user right back on the connect form.
///
/// On first build it kicks off the one-shot server-side pairing restore, and
/// while mounted it forwards app background/foreground transitions to the
/// view model so the live event stream releases its connection when the app
/// is not visible and catches up when it returns.
class RemoteScreen extends StatefulWidget {
  const RemoteScreen({super.key});

  @override
  State<RemoteScreen> createState() => _RemoteScreenState();
}

class _RemoteScreenState extends State<RemoteScreen>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Post-frame: restoreIfIdle notifies listeners immediately (restoring
    // spinner state), which is not allowed during the first build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(context.read<RemoteControlViewModel>().restoreIfIdle());
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final viewModel = context.read<RemoteControlViewModel>();
    switch (state) {
      case AppLifecycleState.resumed:
        unawaited(viewModel.onAppForegrounded());
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        viewModel.onAppBackgrounded();
      case AppLifecycleState.inactive:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.read<RemoteControlViewModel>();
    context.select<RemoteControlViewModel, Object>(
      (vm) => (
        vm.status,
        vm.isRestoring,
        vm.isRestoreRetrying,
        vm.connection?.deviceLabel,
        vm.connection?.lastSeenAt,
        vm.portalConnectionStatus,
        vm.linkState,
        vm.canSearchChats,
      ),
    );
    final connected = viewModel.status == RemoteConnectionStatus.connected;

    final navigation = HomeNavigationScope.maybeOf(context);
    return CanopyScaffold(
      appBar: CanopyAppBar(
        leading: navigation == null
            ? null
            : CanopyIconButton(
                key: const ValueKey('home-menu-button'),
                glyph: CanopyGlyph.barsThree,
                tooltip: 'Open navigation menu',
                onPressed: navigation.openDrawer,
              ),
        content: connected
            ? _RemoteTitle(
                connection: viewModel.connection,
                status: viewModel.portalConnectionStatus,
                linkState: viewModel.linkState,
              )
            : viewModel.isRestoreRetrying
            ? const _RetryingTitle()
            : const Text('Remote Control'),
        trailing: connected
            ? MenuAnchor(
                builder: (context, controller, child) => CanopyIconButton(
                  key: const ValueKey('remote-options'),
                  glyph: CanopyGlyph.dotGrid1x3Horizontal,
                  tooltip: 'Remote options',
                  onPressed: () => controller.isOpen
                      ? controller.close()
                      : controller.open(),
                ),
                menuChildren: [
                  if (viewModel.canSearchChats)
                    MenuItemButton(
                      leadingIcon: CanopyIcon(
                        glyph: CanopyGlyph.magnifyingGlass,
                        tint: AppColors.of(context).foregroundSecondary,
                      ),
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) =>
                              ChangeNotifierProvider<
                                RemoteControlViewModel
                              >.value(
                                value: viewModel,
                                child: const ChatSearchScreen(),
                              ),
                        ),
                      ),
                      child: const Text('Search chats'),
                    ),
                  MenuItemButton(
                    onPressed: () => unawaited(viewModel.disconnect()),
                    leadingIcon: const SizedBox(width: 24, height: 24),
                    child: const Text('Disconnect'),
                  ),
                ],
              )
            : null,
      ),
      body: switch (viewModel.status) {
        // An automatic retry keeps the form mounted, so a code the user is
        // typing survives it.
        RemoteConnectionStatus.disconnected
            when viewModel.isRestoring && !viewModel.isRestoreRetrying =>
          const Center(child: LoadingSpinner(size: 22)),
        RemoteConnectionStatus.disconnected ||
        RemoteConnectionStatus.error => const ConnectDesktopView(),
        RemoteConnectionStatus.connecting => const Center(
          child: LoadingSpinner(size: 22),
        ),
        RemoteConnectionStatus.connected => const WorkspacesListView(),
      },
    );
  }
}

/// The connected app bar title: the paired device name over its connection
/// status.
///
/// These two facts used to live in a full-width card directly under a generic
/// `Remote` title, which spent a whole row repeating what the title slot was
/// wasting. Folding them together buys that row back on every connected frame.
class _RemoteTitle extends StatelessWidget {
  const _RemoteTitle({
    required this.connection,
    required this.status,
    required this.linkState,
  });

  final RemoteConnection? connection;
  final RemotePortalConnectionStatus? status;
  final RemoteLinkState linkState;

  @override
  Widget build(BuildContext context) {
    final device = connection;
    // Connected without pairing metadata is a gap, not a state worth naming;
    // fall back to the tab's own name rather than an empty title.
    if (device == null) return const Text('Remote');

    final label = describeRemoteConnectionStatus(
      status: status,
      lastSeenAt: device.lastSeenAt,
      linkState: linkState,
    );
    return _StackedTitle(
      title: device.deviceLabel,
      titleKey: const ValueKey('remote-device-name'),
      label: label,
      labelKey: const ValueKey('remote-device-status'),
    );
  }
}

/// The disconnected title while restore keeps retrying an unreachable
/// server (CAN-3557). The pairing form below stays usable, so the retry
/// status rides in the title instead of costing the form vertical space.
class _RetryingTitle extends StatelessWidget {
  const _RetryingTitle();

  @override
  Widget build(BuildContext context) => const _StackedTitle(
    title: 'Remote Control',
    label: RemoteConnectionStatusLabel(
      text: "Can't reach the server · Retrying…",
      tone: RemoteConnectionTone.warning,
    ),
    labelKey: ValueKey('remote-restore-status'),
  );
}

/// A title over a one-line status, tinted by the status tone.
class _StackedTitle extends StatelessWidget {
  const _StackedTitle({
    required this.title,
    required this.label,
    this.titleKey,
    this.labelKey,
  });

  final String title;
  final RemoteConnectionStatusLabel label;
  final Key? titleKey;
  final Key? labelKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    final statusColor = switch (label.tone) {
      RemoteConnectionTone.neutral => colors.foregroundSecondary,
      RemoteConnectionTone.warning => StatusColors.of(context).warning,
      RemoteConnectionTone.failed => StatusColors.of(context).failed,
    };

    // The bar's height is fixed, so clamp scaling the same way Material's own
    // AppBar does for toolbar text. The semantic styles continue to own their
    // line heights.
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1.34,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            title,
            key: titleKey,
            style: theme.textTheme.titleMedium?.copyWith(
              color: colors.foreground,
              fontWeight: AppTypography.emphasisWeight,
              fontVariations: AppTypography.emphasisVariations,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          Text(
            label.text,
            key: labelKey,
            style: theme.textTheme.labelSmall?.copyWith(color: statusColor),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}
