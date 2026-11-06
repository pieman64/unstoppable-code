import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/device_link/desktop/saved_connection.dart';
import '../desktop_link_model.dart';
import 'account.dart';

/// Saved and available computers share one list in setup and the switcher.
/// Access keys are created and renewed by [ComputerConnectAccount]; this view
/// never asks for one.
class ComputerConnectionView extends StatelessWidget {
  const ComputerConnectionView({super.key, required this.account});
  final ComputerConnectAccount account;

  Future<void> _forget(BuildContext context, SavedComputer computer) async {
    if (await confirmDestructive(
      context,
      title: 'Forget ${computer.name}?',
      message:
          'You will need to approve pairing on this computer to connect again.',
      confirmLabel: 'Forget computer',
    )) {
      await account.forget(computer.id);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: account,
    builder: (context, _) {
      final theme = Theme.of(context);
      final colors = AppColors.of(context);
      final connection = account.engine.selected.chats.connection;
      final saved = account.computers;
      final available =
          account.peers.values
              .where(
                (peer) =>
                    peer.acceptsControl &&
                    !saved.any((computer) => computer.id == peer.id),
              )
              .toList()
            ..sort((a, b) => a.name.compareTo(b.name));
      final error = account.error ?? connection.error;
      final recover = account.setupUncertain || account.accessStatus == 401;
      final hasRows = saved.isNotEmpty || available.isNotEmpty;
      final searched = account.ready && account.hasCredential && !account.busy;
      return SingleChildScrollView(
        padding:
            CanopyScaffold.contentPaddingOf(context) +
            const EdgeInsets.fromLTRB(20, 24, 20, 24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.surfaceRaised,
                      shape: BoxShape.circle,
                      border: Border.all(color: colors.border),
                    ),
                    child: SizedBox.square(
                      dimension: 56,
                      child: Center(
                        child: CanopyIcon(
                          glyph: CanopyGlyph.macbook,
                          tint: colors.foreground,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  saved.isEmpty ? 'Connect to your computer' : 'Your computers',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: AppTypography.emphasisWeight,
                    fontVariations: AppTypography.emphasisVariations,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  saved.isEmpty
                      ? 'Work with your projects and chats from your phone.'
                      : 'Paired computers reconnect on their own while the desktop app is running.',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colors.foregroundSecondary,
                  ),
                ),
                const SizedBox(height: 24),
                if (error != null) ...[
                  InlineNotice(glyph: CanopyGlyph.circleInfo, state: error),
                  const SizedBox(height: 16),
                ],
                if (hasRows) ...[
                  _ComputerList(
                    children: [
                      for (final computer in saved)
                        _ComputerRow(
                          key: ValueKey(
                            'computer-connect-saved-${computer.id}',
                          ),
                          name: computer.name,
                          status: _status(computer.id),
                          connection: account
                              .engine
                              .sessions[computer.id]
                              ?.chats
                              .connection,
                          onCancel: () => account.disconnect(computer.id),
                          onTap: account.busy
                              ? null
                              : () => account.connect(computer.id),
                          trailing: PopupMenuButton<String>(
                            tooltip: 'Options for ${computer.name}',
                            icon: CanopyIcon(
                              glyph: CanopyGlyph.dotGrid1x3Horizontal,
                              tint: colors.foregroundSecondary,
                            ),
                            onSelected: (value) {
                              if (value == 'forget') {
                                unawaited(_forget(context, computer));
                              }
                              if (value == 'disconnect') {
                                unawaited(account.disconnect(computer.id));
                              }
                            },
                            itemBuilder: (_) => [
                              if (computer.reconnect)
                                const PopupMenuItem(
                                  value: 'disconnect',
                                  child: Text('Disconnect'),
                                ),
                              const PopupMenuItem(
                                value: 'forget',
                                child: Text('Forget computer'),
                              ),
                            ],
                          ),
                        ),
                      for (final peer in available)
                        _ComputerRow(
                          key: ValueKey('computer-connect-peer-${peer.id}'),
                          name: peer.name,
                          status:
                              account
                                      .engine
                                      .sessions[peer.id]
                                      ?.chats
                                      .connection
                                      .busy ==
                                  true
                              ? _status(peer.id)
                              : const (
                                  label: 'Ready to pair',
                                  tone: _Tone.active,
                                ),
                          connection: account
                              .engine
                              .sessions[peer.id]
                              ?.chats
                              .connection,
                          onCancel: () => account
                              .engine
                              .sessions[peer.id]
                              ?.chats
                              .connection
                              .disconnect(),
                          onTap: account.busy
                              ? null
                              : () => account.connect(peer.id),
                          trailing: CanopyIcon(
                            glyph: CanopyGlyph.chevronRightMedium,
                            tint: colors.foregroundSecondary,
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 24),
                ] else ...[
                  if (searched && error == null) ...[
                    Text(
                      'No computers found yet.',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleSmall,
                    ),
                    const SizedBox(height: 12),
                  ],
                  const _SetupSteps(),
                  const SizedBox(height: 24),
                ],
                CanopyButton(
                  expand: true,
                  label: account.finding
                      ? 'Finding computers…'
                      : recover || error != null
                      ? 'Try again'
                      : !account.hasCredential
                      ? 'Connect a computer'
                      : 'Find computers',
                  loading: account.finding,
                  onPressed: account.busy
                      ? null
                      : () => recover
                            ? account.setUpAgain()
                            : account.findComputers(),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );

  _Status _status(String id) {
    final computer = account.saved.computers[id];
    final connection = account.engine.sessions[id]?.chats.connection;
    if (connection?.phase == DesktopLinkPhase.connected) {
      return (label: 'Connected', tone: _Tone.success);
    }
    if (connection?.reconnecting == true) {
      return (label: 'Reconnecting…', tone: _Tone.active);
    }
    if (connection?.phase == DesktopLinkPhase.pairing) {
      return (label: 'Waiting for approval…', tone: _Tone.active);
    }
    if (connection?.busy == true) {
      return (label: 'Connecting…', tone: _Tone.active);
    }
    if (computer?.reconnect == false) {
      return (label: 'Disconnected', tone: _Tone.neutral);
    }
    if (account.accessDenied) {
      return (label: 'Connection needs attention', tone: _Tone.warning);
    }
    if (!account.peers.containsKey(id)) {
      return (label: 'Computer offline', tone: _Tone.neutral);
    }
    if (account.peers[id]?.acceptsControl != true) {
      return (label: 'Remote access is off', tone: _Tone.neutral);
    }
    if (connection?.error != null) {
      return (label: 'Could not connect', tone: _Tone.warning);
    }
    return (label: 'Ready to connect', tone: _Tone.active);
  }
}

enum _Tone { success, active, warning, neutral }

typedef _Status = ({String label, _Tone tone});

/// The three things a person does on the desktop before a computer appears.
class _SetupSteps extends StatelessWidget {
  const _SetupSteps();

  static const _steps = [
    'Open ${Brand.productDisplayName} on your computer',
    'In Settings, turn on Remote access',
    'Sign in with this account on both devices',
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (index, step) in _steps.indexed)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.surfaceRaised,
                    shape: BoxShape.circle,
                    border: Border.all(color: colors.border),
                  ),
                  child: SizedBox.square(
                    dimension: 28,
                    child: Center(
                      child: Text(
                        '${index + 1}',
                        style: AppTypography.compactLabel.copyWith(
                          color: colors.foreground,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(step, style: theme.textTheme.bodyMedium),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// Approval stays attached to the computer whose identity is being checked.
class _PairingCode extends StatelessWidget {
  const _PairingCode(this.code);
  final String code;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Check the code on your computer',
            style: theme.textTheme.titleSmall,
          ),
          const SizedBox(height: 12),
          Text(
            code,
            key: const ValueKey('computer-connect-code'),
            style: theme.textTheme.headlineLarge?.copyWith(
              fontFamily: AppTypography.monoFamily,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 12),
          Text(
            'Approve on your computer only if both codes match. You only need to do this once.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: AppColors.of(context).foregroundSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

/// One bordered group so saved and available computers read as one list.
class _ComputerList extends StatelessWidget {
  const _ComputerList({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Material(
      color: colors.surfaceRaised,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: colors.border),
      ),
      child: Column(
        children: [
          for (final (index, child) in children.indexed) ...[
            if (index > 0) Divider(height: 1, color: colors.border),
            child,
          ],
        ],
      ),
    );
  }
}

class _ComputerRow extends StatelessWidget {
  const _ComputerRow({
    super.key,
    required this.name,
    required this.status,
    required this.onTap,
    required this.trailing,
    required this.connection,
    required this.onCancel,
  });
  final DesktopLinkModel? connection;
  final VoidCallback onCancel;
  final String name;
  final _Status status;
  final VoidCallback? onTap;
  final Widget trailing;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final status = StatusColors.of(context);
    final tone = switch (this.status.tone) {
      _Tone.success => status.success,
      _Tone.active => status.active,
      _Tone.warning => status.warning,
      _Tone.neutral => status.neutral,
    };
    final busy = connection?.busy == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ListTile(
          contentPadding: const EdgeInsetsDirectional.only(start: 16, end: 8),
          leading: CanopyIcon(
            glyph: CanopyGlyph.macbook,
            tint: colors.foreground,
          ),
          title: Text(
            name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.title.copyWith(color: colors.foreground),
          ),
          subtitle: Semantics(
            liveRegion: true,
            child: Row(
              children: [
                if (busy)
                  const LoadingSpinner(size: 12)
                else
                  DecoratedBox(
                    decoration: BoxDecoration(
                      color: tone,
                      shape: BoxShape.circle,
                    ),
                    child: const SizedBox.square(dimension: 8),
                  ),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    this.status.label,
                    style: AppTypography.bodySmall.copyWith(
                      color: colors.foregroundSecondary,
                    ),
                  ),
                ),
              ],
            ),
          ),
          trailing: busy
              ? CanopyButton(
                  label: 'Cancel',
                  semanticsLabel: 'Cancel connection to $name',
                  variant: CanopyButtonVariant.inline,
                  onPressed: onCancel,
                )
              : trailing,
          onTap: busy ? null : onTap,
        ),
        if (connection?.code case final code?) _PairingCode(code),
      ],
    );
  }
}
