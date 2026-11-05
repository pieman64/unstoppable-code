import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/text-field/canopy_text_field.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';

import 'device_link_view_model.dart';

class DeviceLinkScreen extends StatefulWidget {
  const DeviceLinkScreen({
    super.key,
    required this.model,
    required this.readInvitation,
  });
  final DeviceLinkViewModel model;
  final Future<String?> Function() readInvitation;
  @override
  State<DeviceLinkScreen> createState() => _DeviceLinkScreenState();
}

class _DeviceLinkScreenState extends State<DeviceLinkScreen>
    with WidgetsBindingObserver {
  final _message = TextEditingController();
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _message.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      unawaited(widget.model.suspend());
    }
    if (state == AppLifecycleState.resumed) unawaited(widget.model.resume());
  }

  Future<void> _paste() async {
    try {
      final invitation = await widget.readInvitation();
      if (!mounted) return;
      if (invitation == null || invitation.trim().isEmpty) {
        widget.model.reportMissingInvitation();
      } else {
        await widget.model.connect(invitation);
      }
    } catch (_) {
      if (mounted) widget.model.reportMissingInvitation();
    }
  }

  Future<void> _send() async {
    final text = _message.text;
    await widget.model.send(text);
    if (mounted && widget.model.error == null) _message.clear();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.model,
    builder: (context, _) {
      final model = widget.model;
      final connected = model.phase == DeviceLinkPhase.connected;
      return CanopyScaffold(
        appBar: const CanopyAppBar(content: Text('Device link prototype')),
        body: Builder(
          builder: (context) => ListView(
            key: const ValueKey('device-link-screen'),
            padding:
                CanopyScaffold.contentPaddingOf(context) +
                const EdgeInsets.fromLTRB(20, 24, 20, 24),
            children: [
              Text(
                'Test a separate connection to your computer.',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              const Text(
                'This developer prototype exchanges test messages with a local peer. It has no access to your projects or chats.',
              ),
              const SizedBox(height: 24),
              Semantics(
                liveRegion: true,
                child: Text(switch (model.phase) {
                  DeviceLinkPhase.disconnected => 'Disconnected',
                  DeviceLinkPhase.connecting =>
                    'Establishing a secure connection…',
                  DeviceLinkPhase.awaitingApproval =>
                    'Waiting for approval on your computer',
                  DeviceLinkPhase.connected =>
                    'Connected to ${model.peerName ?? 'your computer'}',
                  DeviceLinkPhase.failed => 'Connection failed',
                }, style: Theme.of(context).textTheme.titleMedium),
              ),
              if (model.error case final error?) ...[
                const SizedBox(height: 12),
                InlineNotice(glyph: CanopyGlyph.circleInfo, state: error),
              ],
              if (model.pairingCode case final code?) ...[
                const SizedBox(height: 16),
                const Text(
                  'Check that this code matches the code on the desktop approval page.',
                ),
                const SizedBox(height: 12),
                Semantics(
                  label: 'Pairing code $code',
                  child: Text(
                    code,
                    key: const ValueKey('device-link-code'),
                    style: Theme.of(context).textTheme.headlineLarge,
                  ),
                ),
              ],
              const SizedBox(height: 20),
              if (!connected && !model.busy) ...[
                CanopyButton(
                  key: const ValueKey('device-link-connect'),
                  label: 'Paste invitation and connect',
                  onPressed: _paste,
                  expand: true,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Copy the invitation from the local desktop peer. Invitations expire after 10 minutes.',
                ),
              ],
              if (connected) ...[
                CanopyTextField(
                  key: const ValueKey('device-link-message'),
                  controller: _message,
                  labelText: 'Test message',
                  enabled: !model.sending,
                  onSubmitted: (_) => unawaited(_send()),
                ),
                const SizedBox(height: 12),
                CanopyButton(
                  key: const ValueKey('device-link-send'),
                  label: 'Send test message',
                  onPressed: _send,
                  loading: model.sending,
                  expand: true,
                ),
                const SizedBox(height: 16),
                if (model.lastRoundTrip case final elapsed?)
                  Text(
                    'Last round trip: ${elapsed.inMilliseconds} ms · Live pushes: ${model.pushCount}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
              ],
              Wrap(
                spacing: 8,
                children: [
                  if (model.canReconnect && !model.busy && !connected)
                    CanopyButton(
                      label: 'Reconnect',
                      onPressed: model.reconnect,
                      variant: CanopyButtonVariant.inline,
                    ),
                  if (connected || model.busy)
                    CanopyButton(
                      label: model.busy ? 'Cancel' : 'Disconnect',
                      onPressed: model.disconnect,
                      variant: CanopyButtonVariant.inline,
                    ),
                  if (model.canReconnect && !model.busy)
                    CanopyButton(
                      label: 'Forget pairings',
                      onPressed: model.forgetPairings,
                      variant: CanopyButtonVariant.inline,
                    ),
                ],
              ),
              for (final message in model.messages)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        message.fromPeer ? 'Desktop echo' : 'You',
                        style: Theme.of(context).textTheme.labelMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(message.text),
                    ],
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );
}
