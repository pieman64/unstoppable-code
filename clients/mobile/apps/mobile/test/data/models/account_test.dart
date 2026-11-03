import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/account.dart';

void main() {
  group('UpdateProfileResponse.fromJson', () {
    test('parses name and image', () {
      final parsed = UpdateProfileResponse.fromJson(<String, dynamic>{
        'name': 'Alex Rivera',
        'image': 'https://cdn.example.com/a.png',
      });

      expect(parsed.name, 'Alex Rivera');
      expect(parsed.image, 'https://cdn.example.com/a.png');
    });

    test('accepts a null image', () {
      final parsed = UpdateProfileResponse.fromJson(<String, dynamic>{
        'name': 'Alex Rivera',
        'image': null,
      });

      expect(parsed.image, isNull);
    });
  });
}
