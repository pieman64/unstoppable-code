import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/clock.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/run_lifetime.dart';

import 'fixtures.dart';

void main() {
  const chat = (scope: RemoteChatScope.worktree, chatId: 'one');

  test('finished history stays out; a live run stays until dismissed', () {
    final memory = BackgroundTrayRunLifetime();
    expect(
      memory.select(chat, [run('r', BackgroundTrayRunStatus.succeeded)]),
      isEmpty,
    );
    expect(
      memory.select(chat, [run('r', BackgroundTrayRunStatus.running)]),
      hasLength(1),
    );
    expect(memory.select(chat, []), isEmpty);
    expect(
      memory.select(chat, [run('r', BackgroundTrayRunStatus.failed)]),
      hasLength(1),
    );
    memory.dismiss(chat, 'r');
    expect(
      memory.select(chat, [run('r', BackgroundTrayRunStatus.failed)]),
      isEmpty,
    );
  });

  test(
    'paused and input runs count as seen live; a restart clears dismissal',
    () {
      for (final status in [
        BackgroundTrayRunStatus.paused,
        BackgroundTrayRunStatus.needsInput,
      ]) {
        final memory = BackgroundTrayRunLifetime();
        expect(memory.select(chat, [run('r', status)]), hasLength(1));
        memory.dismiss(chat, 'r');
        expect(
          memory.select(chat, [run('r', BackgroundTrayRunStatus.cancelled)]),
          isEmpty,
        );
        expect(memory.select(chat, [run('r', status)]), hasLength(1));
        expect(
          memory.select(chat, [run('r', BackgroundTrayRunStatus.completed)]),
          hasLength(1),
        );
      }
    },
  );

  test(
    'seen-live and dismissal are isolated by chat and scope and reset in memory',
    () {
      const otherChat = (scope: RemoteChatScope.worktree, chatId: 'two');
      const standalone = (scope: RemoteChatScope.standalone, chatId: 'one');
      final memory = BackgroundTrayRunLifetime();
      memory.select(chat, [run('r', BackgroundTrayRunStatus.running)]);
      final done = [run('r', BackgroundTrayRunStatus.succeeded)];
      expect(memory.select(otherChat, done), isEmpty);
      expect(memory.select(standalone, done), isEmpty);
      memory.select(otherChat, [run('r', BackgroundTrayRunStatus.running)]);
      memory.dismiss(otherChat, 'r');
      expect(memory.select(chat, done), hasLength(1));
      expect(BackgroundTrayRunLifetime().select(chat, done), isEmpty);
    },
  );

  test(
    'clock ticks every second only expanded and stops on collapse and dispose',
    () {
      fakeAsync((async) {
        var ticks = 0;
        final clock = BackgroundTrayClock(
          onTick: () => ticks++,
          nowMs: () => async.elapsed.inMilliseconds,
        );
        async.elapse(const Duration(seconds: 3));
        expect(ticks, 0);
        clock.setExpanded(true);
        expect(clock.now, 3000);
        final afterExpansion = ticks;
        clock.setExpanded(true);
        expect(async.periodicTimerCount, 1);
        async.elapse(const Duration(seconds: 2));
        expect(clock.now, 5000);
        expect(ticks, afterExpansion + 2);
        clock.setExpanded(false);
        expect(async.periodicTimerCount, 0);
        async.elapse(const Duration(seconds: 3));
        expect(clock.now, 5000);
        clock.setExpanded(true);
        expect(clock.now, 8000);
        clock.dispose();
        expect(async.periodicTimerCount, 0);
        final afterDispose = ticks;
        clock.setExpanded(true);
        async.elapse(const Duration(seconds: 2));
        expect(ticks, afterDispose);
        expect(async.periodicTimerCount, 0);
      });
    },
  );

  test(
    'elapsed labels floor seconds and preserve the desktop hour formatting',
    () {
      final cases = <num?, String>{
        null: 'Not available',
        -1: 'Not available',
        double.nan: 'Not available',
        double.infinity: 'Not available',
        0: '0s',
        999: '0s',
        59999: '59s',
        60000: '1m',
        61000: '1m 1s',
        3599000: '59m 59s',
        3600000: '1h',
        3601000: '1h 0m 1s',
        3660000: '1h 1m',
        3661000: '1h 1m 1s',
      };
      for (final entry in cases.entries) {
        expect(
          formatBackgroundTrayElapsed(entry.key),
          entry.value,
          reason: '${entry.key}ms',
        );
      }
    },
  );
}
