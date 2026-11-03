import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/initials.dart';

void main() {
  group('initialsOf', () {
    test('uses the first and last word of a multi-word name', () {
      expect(initialsOf('Ada Lovelace'), 'AL');
      expect(initialsOf('  grace   brewster  hopper '), 'GH');
    });

    test('uses one letter for a single-word name', () {
      expect(initialsOf('grace'), 'G');
    });

    test('returns null for a blank name', () {
      expect(initialsOf(''), isNull);
      expect(initialsOf('   '), isNull);
    });
  });
}
