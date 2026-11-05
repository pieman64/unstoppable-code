import 'dart:async';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/ui/features/device_link/computer_connect/controller.dart';
import 'package:mobile/ui/features/device_link/computer_connect/screen.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:mobile/app/device_link_device_name.dart';
import 'package:mobile/app/device_link_secure_store.dart';
import 'package:mobile/device_link/chats/repository.dart';
import 'package:mobile/device_link/desktop/repository.dart';
import 'package:mobile/ui/core/font_licenses.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/device_link/chats_shell.dart';
import 'package:mobile/ui/features/device_link/chats_view_model.dart';
import 'package:mobile/ui/features/device_link/desktop_link_model.dart';

/// Independent developer entrypoint. No changes to normal mobile routing,
/// Portal bootstrap or existing chat screens are needed to try device chats.
void main() {
  if (kReleaseMode) {
    throw UnsupportedError(
      'Device chats are available only in development builds.',
    );
  }
  WidgetsFlutterBinding.ensureInitialized();
  registerBundledFontLicenses();
  runApp(const _DeviceChatsRoot());
}

class _DeviceChatsRoot extends StatefulWidget {
  const _DeviceChatsRoot();
  @override
  State<_DeviceChatsRoot> createState() => _DeviceChatsRootState();
}

class _DeviceChatsRootState extends State<_DeviceChatsRoot>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused) {
      unawaited(model.connection.suspend());
    }
    if (state == AppLifecycleState.resumed) {
      unawaited(model.connection.resume());
    }
  }

  late final transport = DesktopLinkRepository(
    store: DeviceLinkSecureStore.desktop(),
    deviceName: deviceLinkDeviceName,
  );
  late final model = DeviceChatsViewModel(
    connection: DesktopLinkModel(transport),
    chats: DeviceChatsRepository(transport),
  );
  late final controller = ComputerConnectController(model);
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    controller.dispose();
    model.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Computer connect',
    theme: AppTheme.light,
    darkTheme: AppTheme.dark,
    home: ComputerConnectScreen(
      controller: controller,
      apiOrigin: AppConfig.apiBaseUrl,
    ),
  );
}

class DeviceChatsApp extends StatelessWidget {
  const DeviceChatsApp({
    super.key,
    required this.model,
    required this.readCredentials,
    this.themeMode = ThemeMode.system,
  });
  final DeviceChatsViewModel model;
  final Future<String?> Function() readCredentials;
  final ThemeMode themeMode;
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Device chats',
    theme: AppTheme.light,
    darkTheme: AppTheme.dark,
    themeMode: themeMode,
    home: DeviceChatsShell(model: model, readCredentials: readCredentials),
  );
}
