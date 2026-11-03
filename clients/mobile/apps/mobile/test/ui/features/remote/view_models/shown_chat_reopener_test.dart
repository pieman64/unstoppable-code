import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/features/remote/view_models/shown_chat_reopener.dart';

const _a = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws',
  worktreeLocalId: 'wt',
  chatId: 'a',
);
const _b = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws',
  worktreeLocalId: 'wt',
  chatId: 'b',
);

void main() {
  late List<String?> reopened;
  late List<void Function()> frame;
  late ShownChatReopener reopener;

  setUp(() {
    reopened = [];
    frame = [];
    reopener = ShownChatReopener(
      reopen: (target) => reopened.add(target.chatId),
      afterFrame: frame.add,
    );
  });

  void endFrame() {
    final callbacks = [...frame];
    frame.clear();
    for (final callback in callbacks) {
      callback();
    }
  }

  test('reopens a chat after the frame that shows it', () {
    reopener.show(_a, sessionGeneration: 1);
    expect(reopened, isEmpty);
    endFrame();
    expect(reopened, ['a']);
  });

  test('rebuilds that keep showing the chat reopen nothing', () {
    reopener.show(_a, sessionGeneration: 1);
    endFrame();
    reopener
      ..show(_a, sessionGeneration: 1)
      ..show(_a, sessionGeneration: 1);
    endFrame();
    expect(reopened, ['a']);
    expect(frame, isEmpty);
  });

  test('switching chats, returning, or a new pairing reopens again', () {
    reopener.show(_a, sessionGeneration: 1);
    endFrame();
    reopener.show(_b, sessionGeneration: 1);
    endFrame();
    // Another route covered the screen, then it showed again.
    reopener
      ..show(null, sessionGeneration: 1)
      ..show(_b, sessionGeneration: 1);
    endFrame();
    reopener.show(_b, sessionGeneration: 2);
    endFrame();
    expect(reopened, ['a', 'b', 'b', 'b']);
  });

  test('only the latest showing in a frame reopens', () {
    reopener
      ..show(_a, sessionGeneration: 1)
      ..show(_b, sessionGeneration: 1);
    endFrame();
    expect(reopened, ['b']);
  });

  test('a chat left before the frame ends is not reopened', () {
    reopener
      ..show(_a, sessionGeneration: 1)
      ..show(null, sessionGeneration: 1);
    endFrame();
    expect(reopened, isEmpty);
  });
}
