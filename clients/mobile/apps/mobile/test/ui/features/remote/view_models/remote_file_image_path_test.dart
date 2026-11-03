// CAN-5130: the viewer resolves Markdown image sources itself, so these
// rules are the client-side gate in front of `readAsset`. The desktop still
// enforces containment; anything rejected here must never reach it.
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_image_path.dart';

void main() {
  group('normalizeRemoteFilePath', () {
    test('keeps root-relative paths and collapses empty and dot segments', () {
      expect(normalizeRemoteFilePath('docs/report.md'), 'docs/report.md');
      expect(normalizeRemoteFilePath('./docs//a/./b.md'), 'docs/a/b.md');
      expect(normalizeRemoteFilePath('docs/a/../b.md'), 'docs/b.md');
      expect(
        normalizeRemoteFilePath('.playwright/can-5130/report.md'),
        '.playwright/can-5130/report.md',
      );
    });

    test('rejects paths outside the selected root', () {
      for (final path in [
        '',
        '.',
        '../report.md',
        'docs/../../report.md',
        '/etc/passwd',
        r'C:\report.md',
        'C:/report.md',
        r'\\server\share\report.md',
        r'docs\..\..\report.md',
        'file:///report.md',
        'docs/report\u0000.md',
      ]) {
        expect(normalizeRemoteFilePath(path), isNull, reason: path);
      }
    });

    test('rejects a drive or scheme that dot segments expose', () {
      for (final path in [
        'docs/../C:/report.md',
        './C:/report.md',
        'docs/../file:report.md',
        'a/b/../../https:/example.com/report.md',
      ]) {
        expect(normalizeRemoteFilePath(path), isNull, reason: path);
      }
      expect(normalizeRemoteFilePath('docs/../C/report.md'), 'C/report.md');
    });
  });

  group('resolveRemoteFileImagePath', () {
    String? resolve(String source, {String document = 'docs/report.md'}) =>
        resolveRemoteFileImagePath(documentPath: document, source: source);

    test('resolves against the report folder', () {
      expect(
        resolve('./after.png', document: '.playwright/can-5130/report.md'),
        '.playwright/can-5130/after.png',
      );
      expect(resolve('after.png'), 'docs/after.png');
      expect(resolve('img/after.png'), 'docs/img/after.png');
      expect(resolve('img/after.png', document: 'report.md'), 'img/after.png');
    });

    test('allows parent segments that stay inside the root', () {
      expect(resolve('../shared/a.png'), 'shared/a.png');
      expect(
        resolve('../../c.png', document: 'docs/a/b/report.md'),
        'docs/c.png',
      );
    });

    test('decodes percent escapes exactly once', () {
      expect(resolve('before%20light.png'), 'docs/before light.png');
      // A double-encoded dot segment stays a literal folder name.
      expect(resolve('%252e%252e/x.png'), 'docs/%2e%2e/x.png');
    });

    test('ignores a query or fragment on a local source', () {
      expect(resolve('after.png?raw=1'), 'docs/after.png');
      expect(resolve('after.png#zoom'), 'docs/after.png');
    });

    test('rejects escapes, absolute paths, schemes and remote URLs', () {
      for (final source in [
        '',
        '   ',
        '#top',
        '.',
        '../../x.png',
        '../../../etc/passwd',
        '%2e%2e/%2e%2e/x.png',
        '..%2f..%2fx.png',
        '/etc/passwd',
        '%2fetc/passwd',
        r'C:\img.png',
        'C:/img.png',
        r'\\server\share\img.png',
        r'img\..\..\x.png',
        'img%5c..%5c..%5cx.png',
        '//example.com/img.png',
        'file:///etc/passwd',
        'file:img.png',
        'http://example.com/img.png',
        'https://example.com/img.png',
        'HTTPS://example.com/img.png',
        'data:image/png;base64,AAAA',
        'javascript:alert(1)',
        'img%00.png',
        'img\u0000.png',
        'img%E0%A4%A.png',
      ]) {
        expect(resolve(source), isNull, reason: source);
      }
    });

    test('rejects a drive or scheme that parent segments expose', () {
      for (final source in [
        '../C:/secret.png',
        '%2e%2e/C:/secret.png',
        '..%2fC:%2fsecret.png',
        '../file:secret.png',
        '../https:/example.com/a.png',
        './../C:/secret.png',
      ]) {
        expect(resolve(source), isNull, reason: source);
      }
      expect(
        resolve('../C:/secret.png', document: 'docs/a/report.md'),
        'docs/C:/secret.png',
      );
    });

    test('rejects every source when the document path is unsafe', () {
      expect(resolve('a.png', document: '../report.md'), isNull);
      expect(resolve('a.png', document: '/abs/report.md'), isNull);
    });
  });
}
