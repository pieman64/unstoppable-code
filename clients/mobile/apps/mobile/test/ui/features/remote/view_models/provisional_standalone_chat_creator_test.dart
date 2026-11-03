import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/provisional_standalone_chat_creator.dart';

void main() {
  late bool supportsCreate;
  late List<RemoteStandaloneChatTarget> created;
  late ProvisionalStandaloneChatCreator creator;

  setUp(() {
    supportsCreate = true;
    created = [];
    creator = ProvisionalStandaloneChatCreator(
      supportsCreate: () => supportsCreate,
      create: (target) async => created.add(target),
    );
  });

  test('creates the provisional chat in its project', () async {
    await creator.ensureCreated(
      chatId: 'cc-new',
      projectLocalId: 'ws-cowork',
      isOpen: true,
    );
    expect(created, hasLength(1));
    expect(created.single.chatId, 'cc-new');
    expect(created.single.projectLocalId, 'ws-cowork');
  });

  test(
    'does nothing for an older desktop without the create command',
    () async {
      supportsCreate = false;
      await creator.ensureCreated(
        chatId: 'cc-new',
        projectLocalId: 'ws-cowork',
        isOpen: true,
      );
      expect(created, isEmpty);
    },
  );

  test('does nothing without a provisional chat or project', () async {
    await creator.ensureCreated(
      chatId: null,
      projectLocalId: 'ws-cowork',
      isOpen: true,
    );
    await creator.ensureCreated(
      chatId: 'cc-new',
      projectLocalId: null,
      isOpen: true,
    );
    expect(created, isEmpty);
  });

  test('refuses once the owning screen is closed', () async {
    await expectLater(
      creator.ensureCreated(
        chatId: 'cc-new',
        projectLocalId: 'ws-cowork',
        isOpen: false,
      ),
      throwsA(isA<RemoteControlException>()),
    );
    expect(created, isEmpty);
  });
}
