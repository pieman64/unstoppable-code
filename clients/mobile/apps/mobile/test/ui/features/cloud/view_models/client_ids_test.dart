import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/cloud/view_models/client_ids.dart';

void main() {
  final uuidV4 = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  );

  test('randomUuidV4 produces RFC 4122 version-4 ids', () {
    for (var i = 0; i < 100; i++) {
      expect(randomUuidV4(), matches(uuidV4));
    }
  });

  test('randomUuidV4 sets version and variant bits from any byte source', () {
    // All-ones bytes would otherwise produce `f` in the version nibble and
    // `f` in the variant nibble; the helper must force `4` and `8..b`.
    final id = randomUuidV4(random: _ConstantRandom(0xff));
    expect(id, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
    final zero = randomUuidV4(random: _ConstantRandom(0));
    expect(zero, '00000000-0000-4000-8000-000000000000');
  });

  test('successive ids differ', () {
    expect({for (var i = 0; i < 50; i++) randomUuidV4()}, hasLength(50));
  });
}

final class _ConstantRandom implements Random {
  _ConstantRandom(this.value);
  final int value;
  @override
  bool nextBool() => value != 0;
  @override
  double nextDouble() => 0;
  @override
  int nextInt(int max) => value % max;
}
