/// Live event channel for the mobile Remote Control feature: a Dart port of
/// the web Portal's dual transport (`portal-event-sse.ts` +
/// `portal-event-poller.ts`).
///
/// Preferred transport is SSE (`GET .../events/stream?after=N`), whose
/// `event: batch` frames each carry a full `PollBrowserPortalEventsResponse`
/// — byte-identical to the long-poll route — so both paths funnel through
/// [RemotePortalEventBatch.fromJson] and the consumer cannot tell them apart.
/// Cursor semantics are shared: resume with `?after=<nextCursor>`. A chat
/// snapshot can approach the SSE frame cap, so each connection parses its
/// chunks incrementally ([PortalSseParser]) and [PortalEventDecoder] decodes
/// large payloads off the UI isolate, one at a time and in stream order.
///
/// Fallback rules:
///  * SSE responses of 401/403 (and `event: error` frames carrying
///    401/403/404) trigger the subscriber's authoritative session probe before
///    emitting a synthetic session-ended batch. A valid or unreachable pairing
///    retries automatically; subscribers without a probe treat them as terminal.
///  * Only a real SSE incompatibility falls back to long-polling: a 404 on
///    the SSE route alone (the route may be feature-gated or absent on older
///    servers), or a frame larger than the parser's cap. Long-poll delivers
///    from the same cursor, and SSE is probed again once the next step of a
///    separate paced streak elapses (CAN-4873). A long-poll 404 uses the same
///    session probe before deciding whether to terminate.
///  * Connect errors, timeouts, 5xx and streams that die without any server
///    activity stay on SSE and retry with backoff. A long-lived stream whose
///    `: keepalive` comments flowed is a healthy idle stream, not a failure —
///    the server emits one every 10s precisely so clients can tell the two
///    apart.
///
/// Reconnect pacing (CAN-2358, CAN-4873): a healthy stream reconnects
/// immediately; a delivered stream that dies within
/// [PortalEventStream.minHealthyStreamLifetime] means an intermediary is
/// cutting streams per batch, so consecutive short-lived streams back off
/// exponentially (250ms → 8s with 50-100% jitter) instead of storming. Failed
/// connections and batches reporting the desktop inactive or ended back off
/// from [PortalEventStream.retryDelay] to [PortalEventStream.maxRetryDelay]
/// with 80-100% jitter. A healthy active batch, a keepalive-healthy stream or
/// the subscriber's `wake` signal resets that backoff.
///
/// Each SSE connection owns a dedicated [http.Client] so cancelling or an
/// idle timeout hard-aborts the held-open socket — important on mobile where
/// the app backgrounds mid-stream. Consecutive long-polls share one client,
/// closed when a poll fails and when the subscription ends.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:developer';
import 'dart:math' as math;

import 'package:http/http.dart' as http;
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/services/portal_event_decoder.dart';
import 'package:mobile/data/services/portal_reconnect_backoff.dart';
import 'package:mobile/data/services/portal_sse_parser.dart';

export 'package:mobile/data/services/portal_sse_parser.dart'
    show
        SseFrame,
        SseParseResult,
        kMaxPortalSseBufferChars,
        parsePortalSseFrames;

/// Streams [RemotePortalEventBatch]es for one Portal session.
final class PortalEventStream {
  PortalEventStream({
    required this.baseUrl,
    required this.headersProvider,
    http.Client Function()? clientFactory,
    http.Client Function()? confirmationClientFactory,
    this.retryDelay = const Duration(seconds: 4),
    this.confirmationTimeout = defaultConfirmationTimeout,
    this.sseIdleTimeout = idleTimeout,
    this.longPollTimeoutMs = 25000,
    DateTime Function()? now,
    double Function()? random,
    this._wait,
    this.decoder = const PortalEventDecoder(),
  }) : _clientFactory = clientFactory ?? http.Client.new,
       _confirmationClientFactory =
           confirmationClientFactory ?? http.Client.new,
       _now = now ?? DateTime.now,
       _random = random ?? _defaultRandom;

  /// Origin + browser portal base path, e.g.
  /// `https://host/api/v1/desktop-app/portal/browser`.
  final String baseUrl;

  /// Auth headers for every request (see `ApiClient.buildHeaders`).
  final Map<String, String> Function() headersProvider;

  /// First step of the backoff after a failed connection or an inactive or
  /// ended session; doubles per consecutive attempt up to [maxRetryDelay].
  final Duration retryDelay;

  /// Maximum time spent confirming an ambiguous terminal transport response.
  /// A timeout is inconclusive, so the subscription retries with its cursor.
  final Duration confirmationTimeout;
  final Duration sseIdleTimeout;

  /// `timeoutMs` forwarded on long-poll requests
  /// (`PORTAL_LONG_POLL_MAX_TIMEOUT_MS` on the server caps it at 25s).
  final int longPollTimeoutMs;

  final http.Client Function() _clientFactory;
  final http.Client Function() _confirmationClientFactory;

  /// Decodes batch payloads, moving large ones off the calling isolate.
  /// Decodes run one at a time in stream order; a result that completes
  /// after the subscription was cancelled is dropped.
  final PortalEventDecoder decoder;

  /// Clock for SSE connection lifetimes and SSE re-probes; injectable for
  /// tests.
  final DateTime Function() _now;

  /// Jitter source for every backoff; injectable for tests.
  final double Function() _random;

  /// Sleeps between reconnect attempts; injectable for tests. Without it the
  /// subscription uses a timer it cancels on wake and cancellation.
  final Future<void> Function(Duration delay)? _wait;

  static final math.Random _sharedRandom = math.Random();

  static double _defaultRandom() => _sharedRandom.nextDouble();

  /// Cap for the backoff while connections fail or the desktop sleeps. With
  /// the 4s first step and 80-100% jitter, at most five attempts fit in two
  /// minutes, and a desktop that wakes is reached within one capped step.
  static const Duration maxRetryDelay = Duration(seconds: 60);

  /// Bounds the authoritative session read without making brief network stalls
  /// look like proof that the pairing ended.
  static const Duration defaultConfirmationTimeout = Duration(seconds: 10);

  /// A socket can stop delivering without closing when mobile networks change.
  /// Bound both connecting and silence; server keepalives arrive every 10s.
  static const Duration connectionTimeout = Duration(seconds: 15);
  static const Duration idleTimeout = Duration(seconds: 30);

  /// A delivered stream that dies faster than this is treated as churn: with
  /// a healthy stream + server keepalives it should live for many poll
  /// cycles, so a short-lived-but-delivered connection means something
  /// between us and the origin is cutting streams per batch (CAN-2358).
  /// Reconnecting instantly then storms at the inter-event rate; back off
  /// exponentially instead until a connection survives past this threshold.
  static const Duration minHealthyStreamLifetime = Duration(seconds: 10);

  /// First short-stream backoff step; doubles per consecutive short stream
  /// up to [shortStreamBackoffCap] with 50-100% jitter (streak 1 waits
  /// 125-250ms). Mirrors the web client's `shortStreamBackoffMs`.
  static const Duration shortStreamBackoffBase = Duration(milliseconds: 250);
  static const Duration shortStreamBackoffCap = Duration(seconds: 8);

  /// Opens the event channel for [sessionId], resuming after [initialCursor].
  /// Cancelling the subscription aborts any in-flight request. The stream
  /// closes after emitting a synthetic session-ended batch when the server
  /// reports the session terminally gone (401/403/404). When supplied,
  /// [confirmSessionEnded] must verify these ambiguous transport errors against
  /// the authoritative session endpoint using its supplied, independently
  /// owned client. The stream closes that client when the probe completes,
  /// times out, or the subscription is cancelled. False or a failed probe
  /// retries with the same cursor; an explicit session-ended event remains
  /// authoritative.
  ///
  /// [onLiveChanged] reports whether events can currently reach this
  /// subscription. It turns true once the server answers (the SSE primer, a
  /// keepalive, or a delivered batch) and false only while the subscription
  /// waits to retry a connection that ended without any server activity, so
  /// a healthy stream that rotates does not flicker. It starts false and is
  /// called only on change.
  ///
  /// An event on [wake] says the desktop is back: it resets the outage
  /// backoff and ends a pending outage wait, so the next attempt starts now.
  /// The subscriber scopes it to this subscription's session.
  Stream<RemotePortalEventBatch> subscribe({
    required String sessionId,
    int initialCursor = 0,
    Future<bool> Function(http.Client client)? confirmSessionEnded,
    void Function(bool live)? onLiveChanged,
    Stream<void>? wake,
  }) {
    late StreamController<RemotePortalEventBatch> controller;
    // The in-flight connection's client, closed to abort it on cancel.
    http.Client? client;
    // Ends the pending reconnect wait early.
    void Function()? endWait;
    final cancelled = Completer<void>();
    var running = true;

    Future<void> run() async {
      var cursor = initialCursor;
      RemotePortalConnectionStatus? lastStatus;
      var live = false;
      final outage = PortalReconnectBackoff(
        base: retryDelay,
        cap: maxRetryDelay,
        random: _random,
      );
      // Paces SSE re-probes after an incompatibility; successful polls do
      // not reset it, only a delivering SSE stream does.
      final sseProbe = PortalReconnectBackoff(
        base: retryDelay,
        cap: maxRetryDelay,
        random: _random,
      );
      final shortStreams = PortalReconnectBackoff(
        base: shortStreamBackoffBase,
        cap: shortStreamBackoffCap,
        jitterFloor: 0.5,
        random: _random,
      );
      // Set while demoted to long-poll: when to probe SSE again.
      DateTime? sseProbeAt;
      http.Client? pollClient;
      var waitingOnOutage = false;

      void closePollClient() {
        pollClient?.close();
        pollClient = null;
      }

      final wakeSubscription = wake?.listen((_) {
        outage.reset();
        if (waitingOnOutage) endWait?.call();
      });

      void setLive(bool value) {
        if (!running || live == value) return;
        live = value;
        onLiveChanged?.call(value);
      }

      bool sessionDown() =>
          lastStatus == RemotePortalConnectionStatus.inactive ||
          lastStatus == RemotePortalConnectionStatus.ended;

      void emit(RemotePortalEventBatch batch) {
        if (!running) return;
        controller.add(batch);
        cursor = batch.nextCursor;
        lastStatus = batch.connectionStatus ?? lastStatus;
        // The desktop answered, so a later outage starts a new streak even
        // when the same stream or poll goes on to report it inactive.
        if (!sessionDown()) outage.reset();
      }

      void emitEnded() {
        if (!running) return;
        controller.add(
          RemotePortalEventBatch(
            events: const [RemoteSessionEndedEvent()],
            nextCursor: cursor,
            connectionStatus: RemotePortalConnectionStatus.ended,
          ),
        );
      }

      Future<bool> confirmedEnded() async {
        if (confirmSessionEnded == null) return true;
        final confirmationClient = _confirmationClientFactory();
        var confirmationClientClosed = false;

        void closeConfirmationClient() {
          if (confirmationClientClosed) return;
          confirmationClientClosed = true;
          confirmationClient.close();
        }

        try {
          return await Future.any<bool>([
            confirmSessionEnded(confirmationClient).timeout(
              confirmationTimeout,
              onTimeout: () {
                closeConfirmationClient();
                return false;
              },
            ),
            cancelled.future.then((_) {
              closeConfirmationClient();
              return false;
            }),
          ]);
        } catch (_) {
          // A failed probe cannot establish that the pairing was revoked.
          return false;
        } finally {
          closeConfirmationClient();
        }
      }

      Future<void> pause(Duration delay, {bool outageWait = false}) async {
        if (!running) return;
        final done = Completer<void>();
        void finish() {
          if (!done.isCompleted) done.complete();
        }

        final wait = _wait;
        final timer = wait == null ? Timer(delay, finish) : null;
        if (wait != null) unawaited(wait(delay).whenComplete(finish));
        endWait = () {
          timer?.cancel();
          finish();
        };
        waitingOnOutage = outageWait;
        await done.future;
        waitingOnOutage = false;
        endWait = null;
      }

      Future<void> outagePause() => pause(outage.next(), outageWait: true);

      void demote() {
        shortStreams.reset();
        sseProbeAt = _now().add(sseProbe.next());
      }

      try {
        while (running) {
          final probeAt = sseProbeAt;
          if (probeAt == null) {
            final activeClient = _clientFactory();
            client = activeClient;
            final _SseConnectionResult result;
            try {
              result = await _consumeSse(
                client: activeClient,
                sessionId: sessionId,
                cursor: () => cursor,
                isRunning: () => running,
                emit: emit,
                onActivity: () => setLive(true),
              );
            } finally {
              // A timed-out Future alone leaves its socket alive. Each attempt
              // owns its transport so closing it cannot affect the next one.
              activeClient.close();
              if (identical(client, activeClient)) client = null;
            }
            if (!running) return;
            if (result.outcome != _SseOutcome.unsupported &&
                !result.delivered &&
                !result.sawActivity) {
              setLive(false);
            }
            switch (result.outcome) {
              case _SseOutcome.terminal:
                if (await confirmedEnded()) {
                  emitEnded();
                  return;
                }
                await outagePause();
              case _SseOutcome.unsupported:
                demote();
              case _SseOutcome.completed:
                final healthy = result.lifetime >= minHealthyStreamLifetime;
                if (result.oversized) {
                  // An oversized frame recurs at the same cursor on every
                  // reconnect; long-poll has no frame cap and can deliver it.
                  demote();
                } else if (result.delivered && sessionDown()) {
                  // The server self-terminates streams for a non-active
                  // session and sends the same batch on every reconnect, so
                  // this extends the outage streak; only an active batch
                  // ([emit]) resets it.
                  shortStreams.reset();
                  await outagePause();
                } else if (result.delivered) {
                  sseProbe.reset();
                  if (healthy) {
                    // Healthy long-lived stream: reconnect promptly to
                    // resume from the delivered cursor.
                    shortStreams.reset();
                  } else {
                    // Delivered but died young: an intermediary is cutting
                    // streams per batch (CAN-2358). Escalate the backoff.
                    await pause(shortStreams.next());
                  }
                } else {
                  shortStreams.reset();
                  if (result.sawActivity && healthy) {
                    // Keepalives flowed on a long-lived idle stream: SSE is
                    // healthy end-to-end and the server rotated it.
                    outage.reset();
                  } else {
                    await outagePause();
                  }
                }
            }
            continue;
          }

          final activeClient = pollClient ??= _clientFactory();
          client = activeClient;
          final _PollOutcome outcome;
          try {
            outcome = await _pollOnce(
              client: activeClient,
              sessionId: sessionId,
              cursor: cursor,
              emit: emit,
            );
          } finally {
            if (identical(client, activeClient)) client = null;
          }
          if (!running) {
            // Cancelling closed the in-flight poll's client.
            pollClient = null;
            return;
          }
          setLive(outcome == _PollOutcome.delivered);
          switch (outcome) {
            case _PollOutcome.terminal:
              if (await confirmedEnded()) {
                emitEnded();
                return;
              }
              await outagePause();
            case _PollOutcome.failed:
              // A timed-out poll leaves its socket alive; a fresh client
              // cannot inherit it.
              closePollClient();
              await outagePause();
            case _PollOutcome.delivered:
              // A poll that reports the desktop inactive/ended returns at
              // once instead of holding, so re-polling with no gap would
              // tight-loop and drain battery.
              if (sessionDown()) await outagePause();
          }
          // Each demotion polls at least once; SSE is probed again once its
          // paced step has elapsed.
          if (!_now().isBefore(probeAt)) {
            sseProbeAt = null;
            closePollClient();
          }
        }
      } finally {
        closePollClient();
        await wakeSubscription?.cancel();
        if (running) {
          running = false;
          await controller.close();
        }
      }
    }

    controller = StreamController<RemotePortalEventBatch>(
      onListen: () {
        unawaited(run());
      },
      onCancel: () {
        running = false;
        if (!cancelled.isCompleted) cancelled.complete();
        endWait?.call();
        // Hard-abort any held-open SSE/long-poll socket.
        client?.close();
      },
    );
    return controller.stream;
  }

  /// Consumes one SSE connection. Emits every `batch` frame it delivers and
  /// reports what the connection observed (delivery, keepalive activity,
  /// lifetime) so the reconnect loop can pace itself.
  Future<_SseConnectionResult> _consumeSse({
    required http.Client client,
    required String sessionId,
    required int Function() cursor,
    required bool Function() isRunning,
    required void Function(RemotePortalEventBatch) emit,
    required void Function() onActivity,
  }) async {
    http.StreamedResponse response;
    try {
      final uri = Uri.parse(
        '$baseUrl/sessions/$sessionId/events/stream',
      ).replace(queryParameters: {'after': '${cursor()}'});
      final request = http.Request('GET', uri);
      request.headers.addAll({
        ...headersProvider(),
        'Accept': 'text/event-stream',
      });
      response = await client.send(request).timeout(connectionTimeout);
    } catch (_) {
      return isRunning()
          ? const _SseConnectionResult.failed()
          : const _SseConnectionResult.terminal();
    }

    if (response.statusCode == 401 || response.statusCode == 403) {
      return const _SseConnectionResult.terminal();
    }
    if (response.statusCode == 404) {
      // The stream route may be absent/gated while long-poll still works;
      // long-poll's own 404 handling decides whether the session is gone.
      return const _SseConnectionResult.unsupported();
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return const _SseConnectionResult.failed();
    }

    final connectedAt = _now();
    var delivered = false;
    var sawActivity = false;
    final parser = PortalSseParser();
    _SseConnectionResult completed({bool oversized = false}) =>
        _SseConnectionResult.completed(
          delivered: delivered,
          sawActivity: sawActivity,
          oversized: oversized,
          lifetime: _now().difference(connectedAt),
        );
    try {
      // `await for` pauses the response (and its idle timer) while a frame
      // decodes, so at most one decode is in flight and frames stay ordered.
      await for (final chunk
          in response.stream
              .transform(utf8.decoder)
              .timeout(
                sseIdleTimeout,
                onTimeout: (sink) {
                  client.close();
                  sink.addError(
                    TimeoutException('Event stream stopped responding.'),
                  );
                  sink.close();
                },
              )) {
        if (!isRunning()) break;
        final parsed = Timeline.timeSync(
          'PortalEventStream.parseChunk',
          () => parser.add(chunk),
        );
        if (parsed.sawActivity) {
          sawActivity = true;
          onActivity();
        }
        for (final frame in parsed.frames) {
          if (frame.event == 'batch') {
            final batch = await decoder.sseBatch(frame.data);
            if (!isRunning()) return completed();
            if (batch != null) {
              delivered = true;
              emit(batch);
            }
          } else if (frame.event == 'error') {
            final status = await decoder.errorStatus(frame.data);
            if (!isRunning()) return completed();
            if (status == 401 || status == 403 || status == 404) {
              return const _SseConnectionResult.terminal();
            }
            return completed();
          }
        }

        // The frame in progress filled the cap without completing. Abort
        // before accepting more data.
        if (parsed.oversized) return completed(oversized: true);
      }
    } catch (_) {
      // Dropped connection; fall through to the retry decision below. A
      // decode that fails to run (the worker isolate cannot start or its
      // result cannot be sent back) lands here too: the frame is not
      // skipped, and the next connection resumes from the last delivered
      // cursor.
    }
    return completed();
  }

  /// Issues one long-poll GET, emitting the batch on success.
  Future<_PollOutcome> _pollOnce({
    required http.Client client,
    required String sessionId,
    required int cursor,
    required void Function(RemotePortalEventBatch) emit,
  }) async {
    try {
      final uri = Uri.parse('$baseUrl/sessions/$sessionId/events').replace(
        queryParameters: {
          'after': '$cursor',
          'timeoutMs': '$longPollTimeoutMs',
        },
      );
      final response = await client
          .get(uri, headers: headersProvider())
          .timeout(Duration(milliseconds: longPollTimeoutMs + 10000));
      if (response.statusCode == 401 ||
          response.statusCode == 403 ||
          response.statusCode == 404) {
        return _PollOutcome.terminal;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return _PollOutcome.failed;
      }
      final batch = await decoder.pollBody(
        response.bodyBytes,
        response.headers,
      );
      if (batch == null) return _PollOutcome.failed;
      // [emit] drops a batch that finished decoding after cancellation.
      emit(batch);
      return _PollOutcome.delivered;
    } catch (_) {
      return _PollOutcome.failed;
    }
  }
}

enum _SseOutcome { completed, unsupported, terminal }

/// What one SSE connection observed. [_SseOutcome.completed] covers every
/// non-terminal, non-404 connection — the reconnect loop derives pacing and
/// long-poll demotion from [delivered], [sawActivity], and [lifetime].
final class _SseConnectionResult {
  const _SseConnectionResult.completed({
    required this.delivered,
    required this.sawActivity,
    required this.lifetime,
    this.oversized = false,
  }) : outcome = _SseOutcome.completed;

  /// A connection that failed before observing anything (connect error or
  /// non-2xx response).
  const _SseConnectionResult.failed()
    : outcome = _SseOutcome.completed,
      delivered = false,
      sawActivity = false,
      oversized = false,
      lifetime = Duration.zero;

  const _SseConnectionResult.unsupported()
    : outcome = _SseOutcome.unsupported,
      delivered = false,
      sawActivity = false,
      oversized = false,
      lifetime = Duration.zero;

  const _SseConnectionResult.terminal()
    : outcome = _SseOutcome.terminal,
      delivered = false,
      sawActivity = false,
      oversized = false,
      lifetime = Duration.zero;

  final _SseOutcome outcome;
  final bool delivered;
  final bool sawActivity;

  /// The connection was aborted because a single frame exceeded
  /// [kMaxPortalSseBufferChars]. The frame recurs at the same cursor on
  /// every reconnect, so this must keep counting toward long-poll demotion
  /// no matter how healthy the stream otherwise looked.
  final bool oversized;
  final Duration lifetime;
}

enum _PollOutcome { delivered, failed, terminal }
