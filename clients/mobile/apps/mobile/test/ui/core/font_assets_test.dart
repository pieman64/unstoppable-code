import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'bundles real normal and italic TrueType fonts for offline use',
    () async {
      for (final entry in {
        'inter': 'Inter',
        'jetbrains-mono': 'JetBrainsMono',
      }.entries) {
        for (final suffix in ['', '-Italic']) {
          final data = await rootBundle.load(
            'assets/fonts/${entry.key}/${entry.value}Variable$suffix.ttf',
          );
          expect(
            data.getUint32(0),
            0x00010000,
          ); // TrueType sfnt, not WOFF or an HTML error.
          final tags = <String>[];
          for (var i = 0; i < data.getUint16(4); i++) {
            tags.add(
              String.fromCharCodes(
                data.buffer.asUint8List(data.offsetInBytes + 12 + i * 16, 4),
              ),
            );
          }
          expect(tags, containsAll(['fvar', 'glyf', 'name']));
        }
      }
    },
  );
}
