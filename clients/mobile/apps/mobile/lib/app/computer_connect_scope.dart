import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/device_link/desktop/hub.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/core/navigation/home_extra_destination.dart';
import 'package:mobile/ui/features/device_link/computer_connect/account.dart';
import 'package:mobile/ui/features/device_link/computer_connect/engine.dart';
import 'package:mobile/ui/features/device_link/computer_connect/screen.dart';
import 'computer_connect_keys.dart';
import 'device_link_device_name.dart';
import 'device_link_secure_store.dart';

/// Account-scoped composition, offered against staging in every build mode.
/// The installation identity keeps old desktop pairings; credentials
/// and remembered computers are account/server scoped.
class ComputerConnectScope extends StatefulWidget {
  const ComputerConnectScope({
    super.key,
    required this.child,
    required this.accountId,
    required this.sessionToken,
    required this.twoFactorProof,
    required this.enabled,
  });
  final Widget child;
  final String? accountId, sessionToken, twoFactorProof;
  final bool enabled;
  @override
  State<ComputerConnectScope> createState() => _ComputerConnectScopeState();
}

class _ComputerConnectScopeState extends State<ComputerConnectScope>
    with WidgetsBindingObserver {
  ComputerConnectEngine? _engine;
  ComputerConnectAccount? _account;
  bool get _enabled =>
      AppConfig.usesStagingServer &&
      widget.enabled &&
      widget.accountId != null &&
      widget.sessionToken != null;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_enabled || _engine != null) return;
    final origin = AppConfig.apiBaseUrl;
    final engine = ComputerConnectEngine(
      DesktopLinkHub(
        store: DeviceLinkSecureStore.desktop(),
        deviceName: deviceLinkDeviceName,
      ),
      drafts: maybeChatDraftStore(context),
    );
    final keys = ComputerConnectKeys(
      origin: origin,
      sessionToken: widget.sessionToken!,
      twoFactorProof: widget.twoFactorProof,
    );
    _engine = engine;
    _account = ComputerConnectAccount(
      engine: engine,
      store: DeviceLinkSecureStore.connection(
        accountId: widget.accountId!,
        origin: origin,
      ),
      accountId: widget.accountId!,
      origin: origin,
      createCredential: keys.create,
    );
    WidgetsBinding.instance.addObserver(this);
    unawaited(_account!.restore());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final account = _account;
    if (account == null) return;
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused) {
      unawaited(account.suspend());
    }
    if (state == AppLifecycleState.resumed) unawaited(account.resume());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _account?.dispose();
    _engine?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final engine = _engine;
    final account = _account;
    if (!_enabled || engine == null || account == null) return widget.child;
    return ListenableBuilder(
      listenable: account,
      child: widget.child,
      builder: (context, child) => HomeExtraDestination(
        label: 'Computer connect',
        subtitle: account.selectedName ?? 'Connect a computer',
        pageBuilder: (_) => ListenableBuilder(
          listenable: account,
          builder: (_, _) => ComputerConnectScreen(
            key: ObjectKey(engine.selected),
            controller: engine.selected,
            apiOrigin: AppConfig.apiBaseUrl,
            account: account,
          ),
        ),
        child: child!,
      ),
    );
  }
}
