import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/social_provider.dart';

void main() {
  test('apple provider has wire "apple" and label "Apple"', () {
    expect(SocialProvider.apple.wire, 'apple');
    expect(SocialProvider.apple.label, 'Apple');
  });
}
