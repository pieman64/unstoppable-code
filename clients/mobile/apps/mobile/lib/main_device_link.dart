import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/app/device_link_device_name.dart';
import 'package:mobile/app/device_link_secure_store.dart';
import 'package:mobile/device_link/desktop/repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/font_licenses.dart';
import 'package:mobile/ui/features/device_link/desktop_link_screen.dart';
import 'package:mobile/ui/features/device_link/desktop_link_model.dart';

/// Run explicitly with `flutter run -t lib/main_device_link.dart`. The normal
/// entrypoint has no imports from this stack. No auth, analytics or Firebase
/// bootstrap runs here, and release builds refuse to start this entrypoint.
void main() {
  if (kReleaseMode) {
    throw UnsupportedError(
      'The device link prototype is available only in development builds.',
    );
  }
  WidgetsFlutterBinding.ensureInitialized();
  registerBundledFontLicenses();
  runApp(const DeviceLinkPrototypeApp());
}

class DeviceLinkPrototypeApp extends StatefulWidget {
  const DeviceLinkPrototypeApp({super.key});
  @override
  State<DeviceLinkPrototypeApp> createState() => _DeviceLinkPrototypeAppState();
}

class _DeviceLinkPrototypeAppState extends State<DeviceLinkPrototypeApp> {
  late final model = DesktopLinkModel(
    DesktopLinkRepository(
      store: DeviceLinkSecureStore.desktop(),
      deviceName: deviceLinkDeviceName,
    ),
  );
  @override
  void dispose() {
    model.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Device link prototype',
    theme: AppTheme.light,
    darkTheme: AppTheme.dark,
    home: DesktopLinkScreen(
      model: model,
      readCredentials: () async =>
          (await Clipboard.getData(Clipboard.kTextPlain))?.text,
    ),
  );
}
