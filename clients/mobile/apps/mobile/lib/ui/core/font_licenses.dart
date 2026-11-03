import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Registers the license notices for fonts bundled with the mobile app.
void registerBundledFontLicenses() {
  LicenseRegistry.addLicense(() async* {
    yield LicenseEntryWithLineBreaks(const [
      'Inter',
    ], await rootBundle.loadString('assets/fonts/inter/OFL.txt'));
    yield LicenseEntryWithLineBreaks(const [
      'JetBrains Mono',
    ], await rootBundle.loadString('assets/fonts/jetbrains-mono/OFL.txt'));
  });
}
