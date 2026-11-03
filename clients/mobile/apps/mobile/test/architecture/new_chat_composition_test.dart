import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('new chat destination composition lives outside the Home feature', () {
    final composition = Directory('lib/ui/composition/new_chat');
    expect(composition.existsSync(), isTrue);
    for (final file in composition.listSync().whereType<File>()) {
      expect(
        file.readAsStringSync(),
        isNot(contains('features/home/')),
        reason: file.path,
      );
    }
    expect(
      File('lib/ui/features/home/views/new_chat_draft.dart').existsSync(),
      isFalse,
    );
    expect(
      File('lib/ui/features/home/views/home_shell.dart').readAsStringSync(),
      contains('package:mobile/ui/composition/new_chat/new_chat_draft.dart'),
    );
  });
}
