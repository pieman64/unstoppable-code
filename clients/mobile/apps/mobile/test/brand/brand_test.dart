import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/brand/brand.g.dart';

void main() {
  group('Brand identity (unstoppable-code)', () {
    test('OAuth callback scheme/url match the unstoppable-code brand', () {
      expect(Brand.oauthCallbackScheme, 'unstoppable-code');
      expect(Brand.oauthCallbackUrl, 'unstoppable-code://auth');
    });

    test('display and short names are the Unstoppable brand', () {
      expect(Brand.displayName, 'Unstoppable');
      expect(Brand.shortName, 'Unstoppable');
    });
  });
}
