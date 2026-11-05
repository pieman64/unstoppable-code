import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'desktop_link_model.dart';

class DesktopLinkScreen extends StatefulWidget {
  const DesktopLinkScreen({
    super.key,
    required this.model,
    required this.readCredentials,
  });
  final DesktopLinkModel model;
  final Future<String?> Function() readCredentials;
  @override
  State<DesktopLinkScreen> createState() => _DesktopLinkScreenState();
}

class _DesktopLinkScreenState extends State<DesktopLinkScreen>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused) {
      unawaited(widget.model.suspend());
    }
    if (state == AppLifecycleState.resumed) unawaited(widget.model.resume());
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.model,
    builder: (context, _) {
      final model = widget.model;
      return CanopyScaffold(
        appBar: const CanopyAppBar(content: Text('Device link prototype')),
        body: Builder(
          builder: (context) => ListView(
            key: const ValueKey('desktop-link-screen'),
            padding:
                CanopyScaffold.contentPaddingOf(context) +
                const EdgeInsets.all(24),
            children: [
              Text(
                'Connect using desktop remote access',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              const Text(
                'This developer client uses the existing device relay and encrypted desktop protocol. Approve pairing on your computer after comparing the code.',
              ),
              const SizedBox(height: 24),
              Semantics(
                liveRegion: true,
                child: Text(switch (model.phase) {
                  DesktopLinkPhase.disconnected => 'Disconnected',
                  DesktopLinkPhase.connecting =>
                    'Connecting to the device relay…',
                  DesktopLinkPhase.reconnecting => 'Reconnecting…',
                  DesktopLinkPhase.pairing =>
                    'Waiting for approval on your computer',
                  DesktopLinkPhase.connected =>
                    'Connected to ${model.host?['name'] ?? 'your computer'}',
                  DesktopLinkPhase.failed => 'Connection failed',
                }, style: Theme.of(context).textTheme.titleMedium),
              ),
              if (model.error case final error?) ...[
                const SizedBox(height: 12),
                InlineNotice(glyph: CanopyGlyph.circleInfo, state: error),
              ],
              if (model.code case final code?) ...[
                const SizedBox(height: 16),
                const Text(
                  'Compare this code with the desktop pairing request.',
                ),
                const SizedBox(height: 12),
                Text(
                  code,
                  key: const ValueKey('desktop-link-code'),
                  style: Theme.of(context).textTheme.headlineLarge,
                ),
              ],
              const SizedBox(height: 20),
              if (!model.busy && model.phase != DesktopLinkPhase.connected) ...[
                CanopyButton(
                  label: 'Paste relay credentials and connect',
                  expand: true,
                  onPressed: () async {
                    try {
                      await model.pasteCredentials(
                        await widget.readCredentials(),
                      );
                    } catch (_) {
                      await model.pasteCredentials(null);
                    }
                  },
                ),
                const SizedBox(height: 8),
                const Text(
                  'Developer credentials stay in memory. The prototype saves only its device identity and paired computer keys.',
                ),
              ],
              if (model.host case final host?) ...[
                Text('Desktop version: ${host['appVersion']}'),
                Text(
                  'Protocol: ${host['version'] is Map ? (host['version'] as Map)['protocolVersion'] : 'unknown'}',
                ),
                const SizedBox(height: 16),
                CanopyButton(
                  label: 'Read host info',
                  onPressed: model.refresh,
                  expand: true,
                ),
                if (model.roundTrip case final time?)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(
                      'Last request: ${time.inMilliseconds} ms · Desktop pushes: ${model.pushes}',
                    ),
                  ),
              ],
              Wrap(
                spacing: 8,
                children: [
                  if (model.busy || model.phase == DesktopLinkPhase.connected)
                    CanopyButton(
                      label: model.busy ? 'Cancel' : 'Disconnect',
                      onPressed: model.disconnect,
                      variant: CanopyButtonVariant.inline,
                    ),
                  if (model.canReconnect &&
                      !model.busy &&
                      model.phase != DesktopLinkPhase.connected)
                    CanopyButton(
                      label: 'Reconnect',
                      onPressed: model.reconnect,
                      variant: CanopyButtonVariant.inline,
                    ),
                  if (!model.busy)
                    CanopyButton(
                      label: 'Forget pairings',
                      onPressed: model.forget,
                      variant: CanopyButtonVariant.inline,
                    ),
                ],
              ),
            ],
          ),
        ),
      );
    },
  );
}
