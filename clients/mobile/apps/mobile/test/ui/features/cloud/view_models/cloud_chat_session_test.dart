import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'cloud_chat_test_support.dart' show accepted, live;
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_session.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_transcript_mapper.dart';

void main() {
  final now = DateTime(2026);
  CloudChatSessionState state() =>
      CloudChatSessionState(chatId: 'chat', cursorEpoch: 'epoch');
  CloudOutboxEntry entry(
    String id, {
    CloudOutboxStatus status = CloudOutboxStatus.queued,
    DateTime? deadline,
  }) => CloudOutboxEntry(
    clientRequestId: id,
    payload: const CloudSendPayload(text: 'hello'),
    enqueuedAt: now,
    status: status,
    nextAttemptAt: deadline,
  );
  CloudTranscriptMessage row(String id, String requestId) =>
      CloudTranscriptMessage(
        messageId: id,
        clientRequestId: requestId,
        chatId: 'chat',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: id,
        occurredAt: now,
      );
  test('effects follow bootstrap, post, attach ordering and strict FIFO', () {
    final live = state().copyWith(
      sessionStatus: CloudSessionStatus.live,
      outbox: [entry('a'), entry('b')],
    );
    expect(deriveCloudEffects(live, now), [CloudSessionEffect.post]);
    expect(
      deriveCloudEffects(
        live.copyWith(
          outbox: [
            entry('a', deadline: now.add(const Duration(seconds: 1))),
            entry('b'),
          ],
        ),
        now,
      ),
      isEmpty,
    );
    expect(
      deriveCloudEffects(
        live.copyWith(
          outbox: [
            entry('a'),
            entry('b', status: CloudOutboxStatus.posting),
          ],
        ),
        now,
      ),
      isEmpty,
    );
    expect(
      deriveCloudEffects(
        live.copyWith(attachment: CloudAttachmentStatus.stale),
        now,
      ),
      [CloudSessionEffect.bootstrap, CloudSessionEffect.post],
    );
    expect(
      deriveCloudEffects(
        live.copyWith(sessionStatus: CloudSessionStatus.unknown),
        now,
      ),
      [CloudSessionEffect.bootstrap],
    );
    expect(
      deriveCloudEffects(
        live.copyWith(
          outbox: [
            entry('a', status: CloudOutboxStatus.accepted),
            entry('b'),
          ],
        ),
        now,
      ),
      isEmpty,
    );
  });
  test('cursorless live turn bootstraps once; checkpoint allows attach', () {
    final live = state().copyWith(
      liveTurn: CloudLiveTurn(userMessageId: 'u', startedAt: now),
    );
    expect(deriveCloudEffects(live, now), [CloudSessionEffect.bootstrap]);
    expect(
      deriveCloudEffects(
        live.copyWith(sessionStatus: CloudSessionStatus.live, cursor: '1'),
        now,
      ),
      [CloudSessionEffect.attach],
    );
    expect(
      deriveCloudEffects(
        live.copyWith(attachment: CloudAttachmentStatus.stale),
        now,
      ),
      [CloudSessionEffect.bootstrap],
    );
  });
  test('cursor and capability invariants allow resets only across epochs', () {
    final previous = state().copyWith(
      cursor: 'stream:99:turn:9',
      capabilityState: CloudCapabilityState(BigInt.from(4)),
    );
    expect(
      advanceCloudCursor(previous.cursor, 'stream:99:turn:3'),
      previous.cursor,
    );
    expect(
      advanceCloudCursor('999999999999999999999', '1000000000000000000000'),
      '1000000000000000000000',
    );
    expect(advanceCloudCursor('10', '9'), '10');
    expect(advanceCloudCursor('10', 'stream:10:turn:1'), 'stream:10:turn:1');
    expect(advanceCloudCursor('stream:10:turn:1', '10'), 'stream:10:turn:1');
    expect(advanceCloudCursor('opaque', 'other'), 'other');
    expect(
      () => assertCloudSessionInvariants(
        previous.copyWith(cursor: null),
        previous,
      ),
      throwsStateError,
    );
    expect(
      () => assertCloudSessionInvariants(
        previous.copyWith(capabilityState: CloudCapabilityState(BigInt.one)),
        previous,
      ),
      throwsStateError,
    );
    assertCloudSessionInvariants(
      previous.copyWith(
        cursorEpoch: 'new',
        cursor: null,
        capabilityState: null,
      ),
      previous,
    );
  });
  test(
    'rejects concurrent posts, terminal live turns and orphan optimistic rows',
    () {
      expect(
        () => assertCloudSessionInvariants(
          state().copyWith(
            outbox: [
              entry('a', status: CloudOutboxStatus.posting),
              entry('b', status: CloudOutboxStatus.posting),
            ],
          ),
        ),
        throwsStateError,
      );
      expect(
        () => assertCloudSessionInvariants(
          state().copyWith(
            sessionStatus: CloudSessionStatus.terminal,
            liveTurn: CloudLiveTurn(userMessageId: 'u', startedAt: now),
          ),
        ),
        throwsStateError,
      );
      expect(
        () => assertCloudSessionInvariants(
          state().copyWith(optimistic: {'a': row('optimistic:a', 'a')}),
        ),
        throwsStateError,
      );
      assertCloudSessionInvariants(
        state().copyWith(
          outbox: [entry('a')],
          optimistic: {'a': row('optimistic:a', 'a')},
        ),
      );
    },
  );
  test(
    'canonical user wins by request id; ordering is timestamp then message id',
    () {
      final s = state().copyWith(
        transcript: [row('z', 'a'), row('b', 'b')],
        optimistic: {
          'a': row('optimistic:a', 'a'),
          'c': row('optimistic:c', 'c'),
        },
      );
      expect(s.visibleTranscript.map((m) => m.messageId), [
        'b',
        'optimistic:c',
        'z',
      ]);
      expect(() => s.transcript.clear(), throwsUnsupportedError);
      expect(() => s.optimistic.clear(), throwsUnsupportedError);
    },
  );

  test(
    'acceptance advances capability version strictly, replay changes no scalars',
    () {
      final previous = state().copyWith(
        cursor: '20',
        capabilityState: CloudCapabilityState(BigInt.from(5)),
        outbox: [entry('a')],
      );
      final result = PostTurnResult(
        message: accepted('a').message,
        replayed: false,
        streamAfter: '10',
        capabilityBundleStateVersion: '6',
        capabilityBundles: {
          'activeBundle': {'digest': 'active'},
          'pendingBundle': {'digest': 'pending'},
        },
      );
      final next = reduceCloudAccepted(previous, 'a', result, [
        row('canonical', 'a'),
      ], now);
      expect(next.cursor, '20');
      expect(next.capabilityState!.version, BigInt.from(6));
      expect(next.capabilityState!.activeDigest, 'active');
      expect(next.capabilityState!.pendingDigest, 'pending');
      final stale = reduceCloudAccepted(
        next,
        'missing',
        accepted('missing', version: '4'),
        [],
        now,
      );
      expect(stale.capabilityState, same(next.capabilityState));
      expect(stale.liveTurn, same(next.liveTurn));
      final replay = reduceCloudAccepted(
        previous,
        'a',
        accepted('a', replayed: true, cursor: '100', version: '100'),
        [],
        now,
      );
      expect(replay.cursor, '20');
      expect(replay.capabilityState, same(previous.capabilityState));
      expect(replay.liveTurn, isNull);
    },
  );
  test(
    'bootstrap resets frame clock when either half of live identity changes',
    () {
      final prior = state().copyWith(
        liveTurn: CloudLiveTurn(
          turnId: 'turn',
          userMessageId: 'other',
          startedAt: now,
        ),
        lastFrameAt: now,
      );
      final next = reduceCloudBootstrap(prior, live(), [], now);
      expect(next.lastFrameAt, isNull);
    },
  );
}
