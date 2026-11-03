// Pins the import boundaries from
// docs/planning/2026-09-20-mobile-cloud-chats/design.md §3.3.
//
// The shared chat stack must know nothing about Remote Control, cloud chats,
// or data access; the cloud feature must never reach into Remote Control.
// Runs under `flutter test`, whose working directory is the package root.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const sharedChatRoots = [
  'lib/ui/features/chat',
  'lib/ui/core/chat',
  'lib/data/models/chat_message.dart',
  'lib/data/models/turn_outcome.dart',
  'lib/data/models/turn_timer.dart',
];
const sharedChatForbidden = [
  'features/remote/',
  'features/cloud/',
  'models/remote_',
  'models/cloud_',
  'data/repositories/',
  'data/services/',
];

const cloudRoots = ['lib/ui/features/cloud'];
const cloudDataPrefix = 'lib/data/';
const cloudForbidden = ['features/remote/', 'models/remote_'];

Iterable<File> dartFilesUnder(String root) {
  final entity = FileSystemEntity.typeSync(root);
  if (entity == FileSystemEntityType.file) return [File(root)];
  if (entity != FileSystemEntityType.directory) return const [];
  return Directory(root)
      .listSync(recursive: true)
      .whereType<File>()
      .where((file) => file.path.endsWith('.dart'));
}

/// `cloud_*.dart` files anywhere under lib/data belong to the cloud feature.
Iterable<File> cloudDataFiles() => dartFilesUnder(
  cloudDataPrefix,
).where((file) => file.uri.pathSegments.last.startsWith('cloud_'));

List<String> violations(Iterable<File> files, List<String> forbidden) {
  final found = <String>[];
  for (final file in files) {
    final lines = file.readAsLinesSync();
    for (final (index, line) in lines.indexed) {
      final trimmed = line.trimLeft();
      if (!trimmed.startsWith('import ') && !trimmed.startsWith('export ')) {
        continue;
      }
      for (final needle in forbidden) {
        if (trimmed.contains(needle)) {
          found.add('${file.path}:${index + 1}: $trimmed');
        }
      }
    }
  }
  return found;
}

void main() {
  test('Remote navigation imports no Home feature widgets', () {
    expect(
      violations(dartFilesUnder('lib/ui/features/remote'), [
        'features/home/views/widgets/',
      ]),
      isEmpty,
    );
  });

  test('shared chat UI, remote Advisor and remote effort do not import the '
      'chat feature', () {
    final files = [
      ...dartFilesUnder('lib/ui/core/chat'),
      File('lib/ui/features/remote/views/remote_app_advisor_chat_screen.dart'),
      File('lib/ui/features/remote/view_models/remote_composer_effort.dart'),
      File('lib/ui/features/remote/views/remote_new_chat_draft.dart'),
    ];
    expect(violations(files, ['ui/features/chat/']), isEmpty);
  });

  test('shared chat stack imports no feature or data-access code', () {
    final files = sharedChatRoots.expand(dartFilesUnder).toList();
    expect(files, isNotEmpty, reason: 'shared chat stack should exist');
    expect(violations(files, sharedChatForbidden), isEmpty);
  });

  test('cloud feature imports nothing from Remote Control', () {
    final files = [...cloudRoots.expand(dartFilesUnder), ...cloudDataFiles()];
    // Empty until the cloud feature lands; the assertion still holds.
    expect(violations(files, cloudForbidden), isEmpty);
  });
}
