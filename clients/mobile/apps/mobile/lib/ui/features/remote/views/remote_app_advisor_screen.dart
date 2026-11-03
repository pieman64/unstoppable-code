import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/repositories/remote_app_advisor_commands.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_app_advisor_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:mobile/ui/features/remote/views/widgets/pending_question_indicator.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:provider/provider.dart';

/// The Advisor destination (CAN-3989): the paired desktop's App Advisor
/// chats, one row per Work Entry in the desktop's order.
///
/// Advisor runs on the desktop, so without a pairing this shows the same
/// pairing form as Remote control, as the web Advisor does, and a desktop
/// without Advisor support gets the update prompt.
class RemoteAppAdvisorScreen extends StatefulWidget {
  const RemoteAppAdvisorScreen({super.key, this.isActive = true});

  /// Whether this is the visible destination. Chats start loading in the
  /// background once the desktop connects; while visible, this screen also
  /// starts a load the background start missed.
  final bool isActive;

  @override
  State<RemoteAppAdvisorScreen> createState() => _RemoteAppAdvisorScreenState();
}

class _RemoteAppAdvisorScreenState extends State<RemoteAppAdvisorScreen> {
  void _open(BuildContext context, {String? chatId}) {
    final viewModel = context.read<RemoteControlViewModel>();
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: viewModel,
            child: RemoteAppAdvisorChatScreen(chatId: chatId),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<RemoteControlViewModel>();
    final advisor = viewModel.appAdvisor;
    // Normally the background start already loaded the list. Cover a missed
    // one: after a reconnect discarded the list, or when an updated desktop
    // starts announcing Advisor.
    if (widget.isActive &&
        advisor.canAct &&
        !advisor.isHydrated &&
        !advisor.isHydrating &&
        advisor.hydrationError == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(advisor.hydrate());
      });
    }
    final showDegraded = RemoteDegradedBanner.shows(
      status: viewModel.portalConnectionStatus,
      linkState: viewModel.linkState,
    );
    final entries = advisor.entries;

    final connected = viewModel.status == RemoteConnectionStatus.connected;
    final showHydrationError =
        connected &&
        advisor.isSupported &&
        entries.isNotEmpty &&
        !advisor.isHydrated &&
        advisor.hydrationError != null;

    final Widget body;
    if (!connected) {
      body = switch (viewModel.status) {
        RemoteConnectionStatus.connecting => const Center(
          child: LoadingSpinner(size: 22),
        ),
        _ when viewModel.isRestoring && !viewModel.isRestoreRetrying =>
          const Center(child: LoadingSpinner(size: 22)),
        _ => const ConnectDesktopView(),
      };
    } else if (!advisor.isSupported) {
      body = const AppAdvisorUpdatePrompt();
    } else if (entries.isEmpty && advisor.hydrationError != null) {
      body = _CenteredStatus(
        message: advisor.hydrationError!,
        onRetry: advisor.canAct ? () => unawaited(advisor.hydrate()) : null,
      );
    } else if (entries.isEmpty && !advisor.isHydrated && advisor.canAct) {
      body = const Center(child: LoadingSpinner(size: 22));
    } else if (entries.isEmpty) {
      body = const _CenteredStatus(message: 'No chats yet');
    } else {
      body = Builder(
        builder: (context) => ListView.builder(
          key: const ValueKey('app-advisor-list'),
          padding: CanopyScaffold.contentPaddingOf(
            context,
          ).copyWith(top: showDegraded || showHydrationError ? 0 : null),
          itemCount: entries.length,
          itemBuilder: (context, index) {
            final entry = entries[index];
            return _EntryRow(
              entry: entry,
              onTap: () => _open(context, chatId: entry.activeChatId),
            );
          },
        ),
      );
    }

    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        leading: HomeMenuButton.maybeOf(context, designSystem: true),
        content: const Text('Orchestrator'),
        trailing: connected && advisor.isSupported
            ? CanopyIconButton(
                key: const ValueKey('app-advisor-new-chat'),
                glyph: CanopyGlyph.bubblePlus,
                tooltip: 'New chat',
                onPressed: advisor.canAct ? () => _open(context) : null,
              )
            : null,
      ),
      body: Column(
        children: [
          if (connected && showDegraded)
            Builder(
              builder: (context) => Padding(
                padding: CanopyScaffold.contentPaddingOf(
                  context,
                ).copyWith(bottom: 0),
                child: RemoteDegradedBanner(
                  status: viewModel.portalConnectionStatus,
                  linkState: viewModel.linkState,
                  deviceLabel: viewModel.connection?.deviceLabel,
                ),
              ),
            ),
          if (showHydrationError)
            Builder(
              builder: (context) => Padding(
                padding: CanopyScaffold.contentPaddingOf(context).copyWith(
                  top: showDegraded ? 0 : null,
                  bottom: 0,
                  left: 16,
                  right: 16,
                ),
                child: Row(
                  children: [
                    Expanded(child: Text(advisor.hydrationError!)),
                    TextButton(
                      onPressed: advisor.canAct
                          ? () => unawaited(advisor.hydrate())
                          : null,
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ),
          Expanded(child: body),
        ],
      ),
    );
  }
}

/// Shown in place of Advisor when the paired desktop predates it.
class AppAdvisorUpdatePrompt extends StatelessWidget {
  const AppAdvisorUpdatePrompt({super.key});

  @override
  Widget build(BuildContext context) => const _CenteredStatus(
    key: ValueKey('app-advisor-update-prompt'),
    message: kRemoteAppAdvisorNeedsDesktopUpdate,
  );
}

/// One Work Entry: its title, a spinner while any tab works, the question
/// signal, and its tab count when it has more than one.
class _EntryRow extends StatelessWidget {
  const _EntryRow({required this.entry, required this.onTap});

  final RemoteAppAdvisorEntry entry;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tabCount = entry.tabs.length;
    final trailing = [
      if (entry.needsAnswer) const PendingQuestionIndicator(size: 16),
      if (entry.isRunning)
        const Tooltip(message: 'Working', child: ThinkingSpinner(size: 12)),
      if (tabCount > 1)
        Text(
          '$tabCount chats',
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
    ];
    return ListTile(
      key: ValueKey('app-advisor-entry-${entry.key}'),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
      visualDensity: VisualDensity.compact,
      minTileHeight: 48,
      title: Text(
        entry.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodyMedium,
      ),
      trailing: trailing.isEmpty
          ? null
          : Row(mainAxisSize: MainAxisSize.min, spacing: 8, children: trailing),
      onTap: onTap,
    );
  }
}

class _CenteredStatus extends StatelessWidget {
  const _CenteredStatus({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (onRetry case final retry?) ...[
              const SizedBox(height: 12),
              FilledButton.tonal(onPressed: retry, child: const Text('Retry')),
            ],
          ],
        ),
      ),
    );
  }
}
