import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/font_licenses.dart';

void main() {
  testWidgets('registers bundled Inter and JetBrains Mono OFL notices', (
    tester,
  ) async {
    registerBundledFontLicenses();

    final entries = await LicenseRegistry.licenses.toList();
    final licensesByPackage = {
      for (final entry in entries)
        for (final package in entry.packages) package: entry.paragraphs,
    };

    expect(licensesByPackage, contains('Inter'));
    expect(licensesByPackage, contains('JetBrains Mono'));
    expect(
      licensesByPackage['Inter']!.map((paragraph) => paragraph.text).join(),
      contains('SIL OPEN FONT LICENSE Version 1.1'),
    );
    expect(
      licensesByPackage['JetBrains Mono']!
          .map((paragraph) => paragraph.text)
          .join(),
      contains('SIL OPEN FONT LICENSE Version 1.1'),
    );
  });
}
