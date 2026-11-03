import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_session_command.dart';

/// The paired desktop's Claude and Codex plan usage commands (CAN-3635). The
/// repository supplies its session capabilities and its shared command
/// submission, so command identity and error mapping stay its own.
final class RemoteProviderUsageCommands {
  const RemoteProviderUsageCommands({
    required this._hasCapability,
    required this._submit,
  });

  final bool Function(String capability) _hasCapability;
  final RemoteSessionCommandSubmit _submit;

  /// Whether the desktop projects plan usage as the overview
  /// `provider_usage` singleton.
  bool get isSupported => _hasCapability('provider_usage');

  /// Asks the desktop to re-read [provider]'s plan usage. The command only
  /// acknowledges that a refresh started; new values arrive as a
  /// `provider_usage` delta. Returns the command id.
  Future<String> refresh(PortalProviderUsageProvider provider) async {
    if (!isSupported) {
      throw const RemoteControlException(
        'Update the desktop app to refresh usage.',
      );
    }
    return _submit(
      type: 'portal.provider_usage.refresh',
      payload: {'provider': provider.wire},
    );
  }
}
