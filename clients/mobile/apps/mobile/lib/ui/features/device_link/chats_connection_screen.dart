import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'desktop_link_model.dart';

/// Separate connection version for the chat entrypoint. Existing screens
/// remain untouched and this view owns no transport or account storage.
class DeviceChatsConnectionScreen extends StatelessWidget {
  const DeviceChatsConnectionScreen({
    super.key,
    required this.model,
    required this.readCredentials,
  });
  final DesktopLinkModel model;
  final Future<String?> Function() readCredentials;
  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: const CanopyAppBar(content: Text('Device chats')),
    body: Builder(
      builder: (context) => ListView(
        padding:
            CanopyScaffold.contentPaddingOf(context) + const EdgeInsets.all(24),
        children: [
          Text(
            'Connect to your computer',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 12),
          const Text(
            'Browse chats and send messages through a paired computer. This is a separate developer version.',
          ),
          const SizedBox(height: 24),
          Semantics(
            liveRegion: true,
            child: Text(switch (model.phase) {
              DesktopLinkPhase.connecting => 'Connecting…',
              DesktopLinkPhase.pairing => 'Compare the code on your computer',
              DesktopLinkPhase.failed => 'Connection failed',
              _ => 'Disconnected',
            }, style: Theme.of(context).textTheme.titleMedium),
          ),
          if (model.code case final code?) ...[
            const SizedBox(height: 16),
            Text(
              code,
              key: const ValueKey('device-chats-pairing-code'),
              style: Theme.of(context).textTheme.headlineLarge,
            ),
            const SizedBox(height: 12),
            const Text('Allow this device only when both codes match.'),
          ],
          if (model.error case final error?) ...[
            const SizedBox(height: 12),
            InlineNotice(glyph: CanopyGlyph.circleInfo, state: error),
          ],
          const SizedBox(height: 20),
          if (!model.busy)
            CanopyButton(
              label: 'Paste relay credentials and connect',
              onPressed: () async {
                try {
                  await model.pasteCredentials(await readCredentials());
                } catch (_) {
                  await model.pasteCredentials(null);
                }
              },
              expand: true,
            ),
          if (model.canReconnect && !model.busy)
            CanopyButton(
              label: 'Reconnect',
              onPressed: model.reconnect,
              variant: CanopyButtonVariant.inline,
            ),
          if (model.busy)
            CanopyButton(
              label: 'Cancel',
              onPressed: model.disconnect,
              variant: CanopyButtonVariant.inline,
            ),
          if (!model.busy) ...[
            const SizedBox(height: 12),
            const Text(
              'Developer credentials stay in memory. Pairing keys are stored separately from Remote Control.',
            ),
          ],
        ],
      ),
    ),
  );
}
