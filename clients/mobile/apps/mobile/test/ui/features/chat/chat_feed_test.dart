import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/chat_glyph.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/core/chat/view_models/attachment_thumbnail_cache.dart';
import 'package:mobile/ui/core/chat/widgets/attachment_thumbnail_scope.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_card.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_transcript_mapper.dart';
import 'package:provider/provider.dart';

import '../../../support/painted_scroll_frames.dart';
import '../../../support/rebuild_counter.dart';
import '../../../support/reduced_motion.dart';
import '../../../support/tiny_png.dart';

Future<Uint8List> _pngOfSize(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    Paint()..color = const Color(0xFF3366FF),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  picture.dispose();
  return data!.buffer.asUint8List();
}

const _transcript = [
  ChatMessage(
    messageId: 'u-1',
    chatId: 'chat-1',
    role: ChatRole.user,
    status: ChatMessageStatus.complete,
    text: 'Fix the login badge',
  ),
  ChatMessage(
    messageId: 'a-1',
    chatId: 'chat-1',
    role: ChatRole.assistant,
    status: ChatMessageStatus.complete,
    text: '',
    parts: [
      ChatPart(kind: 'thinking', data: {'text': 'Inspecting auth.'}),
      ChatPart(
        kind: 'tool_use',
        toolFamily: 'bash',
        data: {'toolName': 'Bash', 'input': '{"command":"npm test"}'},
      ),
      ChatPart(
        kind: 'tool_use',
        toolFamily: 'read',
        data: {'toolName': 'Read', 'input': '{"file_path":"a.dart"}'},
      ),
      ChatPart(
        kind: 'tool_use',
        toolFamily: 'edit',
        data: {'toolName': 'Edit', 'input': '{"file_path":"a.dart"}'},
      ),
    ],
  ),
  ChatMessage(
    messageId: 'a-2',
    chatId: 'chat-1',
    role: ChatRole.assistant,
    status: ChatMessageStatus.complete,
    text: 'Done — the badge shows only on sign-in, via `LoginBadge`.',
  ),
];

/// A transcript whose rows differ wildly in height: tall multi-paragraph
/// turns at the top, terse one-liners at the bottom. That is the shape of a
/// real chat opened after a long session, and it is what makes
/// `SliverChildBuilderDelegate`'s average-height extrapolation of
/// `maxScrollExtent` wrong while the list is still lazily built. A uniform
/// transcript hides this bug: its estimate is right the first time.
List<ChatMessage> _unevenTranscript(int count) => [
  for (var index = 0; index < count; index++) ...[
    ChatMessage(
      messageId: 'u-$index',
      chatId: 'chat-1',
      role: ChatRole.user,
      status: ChatMessageStatus.complete,
      text: index < count ~/ 2
          ? 'Question $index. ${'A long multi-line prompt body. ' * 40}'
          : 'ok',
    ),
    ChatMessage(
      messageId: 'a-$index',
      chatId: 'chat-1',
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: index < count ~/ 2
          ? 'Answer $index. ${'A long multi-paragraph answer body. ' * 60}'
          : 'done',
    ),
  ],
];

List<ChatMessage> _longTranscript(int start, int count) => [
  for (var index = start; index < start + count; index++) ...[
    ChatMessage(
      messageId: 'u-$index',
      chatId: 'chat-1',
      role: ChatRole.user,
      status: ChatMessageStatus.complete,
      text: 'Question $index with enough text to give the row stable height.',
    ),
    ChatMessage(
      messageId: 'a-$index',
      chatId: 'chat-1',
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: 'Answer $index with enough text to make the transcript scroll.',
    ),
  ],
];

/// Records whether an activity already owned the position each time the feed
/// writes to it. A [ScrollPosition.jumpTo] opens with `goIdle()`, so a write
/// landing while something is scrolling cancels it — a reader's flick or the
/// ballistic that carries it.
class _JumpSpyController extends ScrollController {
  final List<bool> jumpsWhileScrolling = [];

  @override
  void jumpTo(double value) {
    if (hasClients) {
      jumpsWhileScrolling.add(position.isScrollingNotifier.value);
    }
    super.jumpTo(value);
  }
}

class _ResizableHorizontalScroller extends StatefulWidget {
  const _ResizableHorizontalScroller({super.key});

  @override
  State<_ResizableHorizontalScroller> createState() =>
      _ResizableHorizontalScrollerState();
}

class _ResizableHorizontalScrollerState
    extends State<_ResizableHorizontalScroller> {
  double _height = 80;

  void expandHeight() => setState(() => _height = 160);

  @override
  Widget build(BuildContext context) => SizedBox(
    height: _height,
    child: SingleChildScrollView(
      key: const ValueKey('nested-horizontal-scrollable'),
      scrollDirection: Axis.horizontal,
      child: SizedBox(width: 800, height: _height),
    ),
  );
}

/// A last row whose height changes in place, the way an answer or a panel
/// does when it finishes loading, without the feed itself rebuilding.
class _ResizableRow extends StatefulWidget {
  const _ResizableRow({super.key, required this.height});

  final double height;

  @override
  State<_ResizableRow> createState() => _ResizableRowState();
}

class _ResizableRowState extends State<_ResizableRow> {
  late double _height = widget.height;

  void resize(double height) => setState(() => _height = height);

  @override
  Widget build(BuildContext context) => SizedBox(height: _height);
}

const _watcherSentinel = 'PRIVATE-PAYLOAD-SENTINEL-4432';

/// A fired cloud watcher as Core stores it: the instruction block, a blank
/// line, then the visible notice (`agentWatcherFiredPromptText`).
String _cloudWatcherText(String label) => [
  '<system_instruction>',
  'Canopy watcher internal event details. This message was generated by '
      'Canopy, not typed by the user.',
  '',
  '<canopy_watcher_event>',
  '{\n  "watcherId": "w-1",\n  "label": "$label",\n'
      '  "secret": "$_watcherSentinel"\n}',
  '</canopy_watcher_event>',
  '</system_instruction>',
  '',
  'Canopy watcher fired.',
  label,
].join('\n');

List<ChatMessage> _cloudWatcherTranscript(
  String userText, {
  ChatWatcherFiredInfo? watcherFired,
}) => CloudTranscriptMapper(chatId: 'chat-1').hydrate(
  CloudChatBootstrap(
    messages: [
      CloudCoreMessage(
        id: 'u-w',
        role: 'USER',
        text: userText,
        cost: const CloudCoreCost(kind: CloudCoreCostKind.zero),
        costBilledViaLlmProxy: false,
        createdAtMs: 1789890000000,
        artifacts: const [],
        watcherFired: watcherFired,
      ),
      CloudCoreMessage(
        id: 'a-w',
        role: 'ASSISTANT',
        text: 'Reviewed the finished chat.',
        sourceKey: 'turn-1',
        cost: const CloudCoreCost(kind: CloudCoreCostKind.zero),
        costBilledViaLlmProxy: false,
        createdAtMs: 1789890001000,
        artifacts: const [],
      ),
    ],
    toolActivity: const [],
  ),
);

/// A Remote Control user row as the desktop sends it (`PortalChatMessage`).
RemoteChatMessage _remoteUserRow(
  String id,
  String text, {
  Map<String, dynamic>? watcherFired,
  List<Map<String, dynamic>> parts = const [],
}) => RemoteChatMessage.fromWireJson({
  'messageId': id,
  'chatId': 'chat-1',
  'scope': 'worktree',
  'role': 'user',
  'status': 'complete',
  'text': text,
  'createdAtMs': 1789890000000,
  'promptSource': 'automated',
  'watcherFired': ?watcherFired,
  'parts': parts,
});

void main() {
  useReducedMotion();
  // One theme per brightness for the whole file, as an app holds it. A fresh
  // ThemeData per pump would notify every themed row and hide whether the
  // feed itself rebuilt them.
  final lightTheme = AppTheme.light;
  final darkTheme = AppTheme.dark;

  Future<void> pumpFeed(
    WidgetTester tester, {
    List<ChatMessage> messages = _transcript,
    Set<String> expandedTurns = const {},
    ValueChanged<String>? onToggleTurn,
    bool dark = false,
    DateTime Function()? clock,
    bool? turnInProgress,
    int? turnElapsedMs,
    List<Widget> trailing = const [],
    VoidCallback? onLoadOlder,
    bool loadingOlder = false,
    bool settle = true,
    bool firstFrameOnly = false,
    String chatId = 'chat-1',
    ScrollController? controller,
    AttachmentThumbnailCache? thumbnails,
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final feedback = TurnFeedbackController(
      repository: MockTurnFeedbackRepository(),
    );
    Widget scoped(Widget child) => thumbnails == null
        ? child
        : AttachmentThumbnailScope(thumbnails: thumbnails, child: child);
    await tester.pumpWidget(
      ChangeNotifierProvider<TurnFeedbackController>.value(
        value: feedback,
        child: MaterialApp(
          theme: dark ? darkTheme : lightTheme,
          home: Scaffold(
            body: scoped(
              ChatFeed(
                chatId: chatId,
                messages: messages,
                expandedTurns: expandedTurns,
                turnInProgress:
                    turnInProgress ??
                    messages.any((message) => message.isStreaming),
                turnElapsedMs: turnElapsedMs,
                trailing: trailing,
                onLoadOlder: onLoadOlder,
                loadingOlder: loadingOlder,
                clock: clock ?? DateTime.now,
                controller: controller,
                onToggleTurn: onToggleTurn ?? (_) {},
              ),
            ),
          ),
        ),
      ),
    );
    if (firstFrameOnly) return;
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      await tester.pump();
    }
  }

  group('message attachments', () {
    const attachmentMessage = ChatMessage(
      messageId: 'u-att',
      chatId: 'chat-1',
      role: ChatRole.user,
      status: ChatMessageStatus.complete,
      text: 'what is this',
      attachments: [
        ChatMessageAttachment(
          attachmentId: 'att-1',
          filename: 'photo.png',
          mediaType: 'image/png',
        ),
      ],
    );

    Finder chip() => find.byKey(const ValueKey('message-attachment-att-1'));

    testWidgets('previews an image whose bytes this device retained', (
      tester,
    ) async {
      final thumbnails = AttachmentThumbnailCache();
      addTearDown(thumbnails.dispose);
      // The retain decodes through the real image codec, which only makes
      // progress on the real event loop, not the test's fake async zone.
      await tester.runAsync(
        () async => thumbnails.retain(
          attachmentId: 'att-1',
          mediaType: 'image/png',
          bytes: await _pngOfSize(80, 40),
        ),
      );

      await pumpFeed(
        tester,
        messages: const [attachmentMessage],
        thumbnails: thumbnails,
      );

      expect(chip(), findsOneWidget);
      // The preview replaces the generic glyph; the filename stays, because
      // it is the only thing that survives a scrollback reload.
      expect(
        find.descendant(of: chip(), matching: find.byType(Image)),
        findsOneWidget,
      );
      final preview = tester.widget<Image>(
        find.descendant(of: chip(), matching: find.byType(Image)),
      );
      // The cache already bounds the longest edge while preserving aspect
      // ratio. Asking the decoder for an exact square would squash non-square
      // thumbnails before BoxFit.cover gets a chance to crop them.
      if (preview.image case final ResizeImage resized) {
        expect(
          resized.width == null || resized.height == null,
          isTrue,
          reason: 'the decoder must not receive exact targets for both axes',
        );
      }
      expect(
        find.descendant(of: chip(), matching: find.text('photo.png')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('falls back to the filename chip with nothing retained', (
      tester,
    ) async {
      await pumpFeed(tester, messages: const [attachmentMessage]);

      expect(chip(), findsOneWidget);
      expect(
        find.descendant(of: chip(), matching: find.byType(Image)),
        findsNothing,
      );
      expect(
        find.descendant(of: chip(), matching: find.text('photo.png')),
        findsOneWidget,
      );
    });

    testWidgets('picks up a thumbnail retained after the chip is on screen', (
      tester,
    ) async {
      final thumbnails = AttachmentThumbnailCache();
      addTearDown(thumbnails.dispose);

      await pumpFeed(
        tester,
        messages: const [attachmentMessage],
        thumbnails: thumbnails,
      );
      expect(
        find.descendant(of: chip(), matching: find.byType(Image)),
        findsNothing,
      );

      // The decode is async, so the bubble renders before the preview is
      // ready. The chip has to rebuild on its own when it lands.
      await tester.runAsync(
        () => thumbnails.retain(
          attachmentId: 'att-1',
          mediaType: 'image/png',
          bytes: tinyPngBytes,
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.descendant(of: chip(), matching: find.byType(Image)),
        findsOneWidget,
      );
    });

    testWidgets('never previews a non-image attachment', (tester) async {
      final thumbnails = AttachmentThumbnailCache();
      addTearDown(thumbnails.dispose);
      // A hostile or buggy retain cannot make a PDF chip render an image.
      await tester.runAsync(
        () => thumbnails.retain(
          attachmentId: 'doc-1',
          mediaType: 'image/png',
          bytes: tinyPngBytes,
        ),
      );

      await pumpFeed(
        tester,
        thumbnails: thumbnails,
        messages: const [
          ChatMessage(
            messageId: 'u-doc',
            chatId: 'chat-1',
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'read this',
            attachments: [
              ChatMessageAttachment(
                attachmentId: 'doc-1',
                filename: 'spec.pdf',
                mediaType: 'application/pdf',
              ),
            ],
          ),
        ],
      );

      final docChip = find.byKey(const ValueKey('message-attachment-doc-1'));
      expect(docChip, findsOneWidget);
      expect(
        find.descendant(of: docChip, matching: find.byType(Image)),
        findsNothing,
      );
    });
  });

  /// The first painted surface at or under [root]: a colored
  /// [BoxDecoration] or a colored [Material], normalized to a decoration.
  BoxDecoration? decorationUnder(WidgetTester tester, Finder root) {
    for (final element
        in find
            .descendant(
              of: root,
              matching: find.byWidgetPredicate(
                (w) => w is DecoratedBox || w is Material,
              ),
              matchRoot: true,
            )
            .evaluate()) {
      final widget = element.widget;
      if (widget is DecoratedBox) {
        final decoration = widget.decoration;
        if (decoration is BoxDecoration && decoration.color != null) {
          return decoration;
        }
      } else if (widget is Material && widget.color != null) {
        return BoxDecoration(
          color: widget.color,
          borderRadius: widget.borderRadius,
        );
      }
    }
    return null;
  }

  /// Registers a scroll-behaviour test once per platform.
  ///
  /// Scroll physics are platform-specific: iOS uses [BouncingScrollPhysics],
  /// which ends the drag phase within a few dozen pixels and hands the rest to
  /// momentum, while Android's [ClampingScrollPhysics] applies the whole drag
  /// up front. Following intent, history anchoring and the latest affordance
  /// all read the scroll position, so each has to hold under both.
  void testScroll(String description, WidgetTesterCallback body) {
    for (final platform in const [TargetPlatform.android, TargetPlatform.iOS]) {
      testWidgets('$description (${platform.name})', (tester) async {
        debugDefaultTargetPlatformOverride = platform;
        try {
          await body(tester);
        } finally {
          // Cleared inside the body: the framework asserts every foundation
          // debug variable is unset before tearDown runs.
          debugDefaultTargetPlatformOverride = null;
        }
      });
    }
  }

  ScrollController feedController(WidgetTester tester) => tester
      .widget<ListView>(find.byKey(const ValueKey('remote-chat-transcript')))
      .controller!;

  group('ChatFeed', () {
    testWidgets('message text is selectable for copying', (tester) async {
      await pumpFeed(tester);

      for (final messageId in const ['u-1', 'a-2']) {
        final message = find.byKey(ValueKey('message-$messageId'));
        expect(
          find.descendant(of: message, matching: find.byType(SelectableText)),
          findsOneWidget,
        );
      }

      final userMessage = find.byKey(const ValueKey('message-u-1'));
      await tester.longPress(find.text('Fix the login badge'));
      await tester.pump();
      final editableText = find.descendant(
        of: userMessage,
        matching: find.byType(EditableText),
      );
      expect(
        tester
            .widget<EditableText>(editableText)
            .controller
            .selection
            .isCollapsed,
        isFalse,
      );
    });

    testWidgets('user prompt sits in a quiet full-width bubble', (
      tester,
    ) async {
      await pumpFeed(tester);
      final bubble = find.byKey(const ValueKey('user-bubble-u-1'));
      expect(bubble, findsOneWidget);

      // Desktop `BUBBLE_SURFACE_CLASS`: bg-quaternary fill, the house border
      // (same as the composer), rounded-xl = --radius-xl = 16px. Not the
      // Material primary container.
      final decoration = decorationUnder(tester, bubble);
      expect(decoration?.color, AppColors.light['bg-quaternary']);
      expect(decoration?.border?.top.color, AppColors.light['line-primary']);
      expect(decoration?.border?.top.width, 1);
      expect(decoration?.borderRadius, BorderRadius.circular(AppRadii.xl));

      // Full width of the transcript column (list padding aside).
      final feed = tester.getRect(find.byType(ChatFeed));
      final rect = tester.getRect(bubble);
      expect(rect.width, greaterThan(feed.width * 0.9));
    });

    testWidgets('assistant answer renders flat, with no bubble', (
      tester,
    ) async {
      await pumpFeed(tester);
      final answer = find.byKey(const ValueKey('message-a-2'));
      expect(answer, findsOneWidget);
      expect(decorationUnder(tester, answer), isNull);
      // Text is left-anchored at the same inset as the bubble text.
      final feed = tester.getRect(find.byType(ChatFeed));
      final text = tester.getRect(
        find
            .descendant(of: answer, matching: find.byType(SelectableText))
            .first,
      );
      expect(text.left - feed.left, inInclusiveRange(20, 28));
    });

    testWidgets('steps row is a filled card of per-category counts', (
      tester,
    ) async {
      String? toggled;
      await pumpFeed(tester, onToggleTurn: (key) => toggled = key);
      final row = find.byKey(const ValueKey('turn-steps-u-1'));
      expect(row, findsOneWidget);

      // No prose summary; one icon + count per category, desktop order.
      expect(find.textContaining('step'), findsNothing);
      expect(
        find.descendant(of: row, matching: find.text('1')),
        findsNWidgets(4),
      );
      expect(
        find.bySemanticsLabel(
          'Agent steps: 1 thinking, 1 bash, 1 read, 1 write/edit',
        ),
        findsOneWidget,
      );

      // Full-width surface one step above the base, with rounded-xl corners.
      final decoration = decorationUnder(tester, row);
      expect(decoration?.color, AppColors.light['bg-primary']);
      expect(decoration?.borderRadius, BorderRadius.circular(AppRadii.xl));
      // Desktop's own summary glyphs, one per category, in order.
      expect(
        tester
            .widgetList<ChatIcon>(
              find.descendant(of: row, matching: find.byType(ChatIcon)),
            )
            .map((icon) => icon.glyph),
        [
          ChatGlyph.thinking,
          ChatGlyph.terminal,
          ChatGlyph.document,
          ChatGlyph.documentPencil,
        ],
      );
      final feed = tester.getRect(find.byType(ChatFeed));
      expect(tester.getRect(row).width, greaterThan(feed.width * 0.9));

      await tester.tap(row);
      expect(toggled, 'u-1');
    });

    testWidgets('computer use steps use the shared cursor glyph', (
      tester,
    ) async {
      const messages = [
        ChatMessage(
          messageId: 'u-computer-use',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Open the settings page',
        ),
        ChatMessage(
          messageId: 'a-computer-use',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: '',
          parts: [
            ChatPart(
              kind: 'tool_use',
              toolFamily: 'computer-use',
              data: {'toolName': 'mcp__cua_repl__js'},
            ),
          ],
        ),
        ChatMessage(
          messageId: 'a-answer',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Settings is open.',
        ),
      ];

      await pumpFeed(tester, messages: messages);

      final row = find.byKey(const ValueKey('turn-steps-u-computer-use'));
      expect(row, findsOneWidget);
      expect(
        find.bySemanticsLabel('Agent steps: 1 computer use'),
        findsOneWidget,
      );
      expect(
        tester
            .widgetList<CanopyIcon>(
              find.descendant(of: row, matching: find.byType(CanopyIcon)),
            )
            .map((icon) => icon.glyph),
        contains(CanopyGlyph.cursorClick),
      );
    });

    testWidgets('expanded steps show flat rows in the secondary tone', (
      tester,
    ) async {
      await pumpFeed(tester, expandedTurns: const {'u-1'});
      expect(find.text('Inspecting auth.'), findsOneWidget);
      final thinking = tester.widget<Text>(find.text('Thinking'));
      expect(thinking.style?.color, AppColors.light['fg-secondary']);
    });

    testWidgets('agent-only intermediate has a populated collapsed summary', (
      tester,
    ) async {
      const messages = [
        ChatMessage(
          messageId: 'u-agent',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Delegate the research',
        ),
        ChatMessage(
          messageId: 'a-agent',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: '',
          parts: [
            ChatPart(kind: 'agent', data: {'displayName': 'Researcher'}),
          ],
        ),
        ChatMessage(
          messageId: 'a-answer',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Research complete.',
        ),
      ];

      await pumpFeed(tester, messages: messages);

      expect(find.byKey(const ValueKey('turn-steps-u-agent')), findsOneWidget);
      expect(find.bySemanticsLabel('Agent steps: 1 agents'), findsOneWidget);
    });

    testWidgets('uncounted intermediate does not show an empty steps card', (
      tester,
    ) async {
      const messages = [
        ChatMessage(
          messageId: 'u-result',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Run the command',
        ),
        ChatMessage(
          messageId: 'a-result',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: '',
          parts: [ChatPart(kind: 'tool_result', data: {})],
        ),
        ChatMessage(
          messageId: 'a-answer',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Command complete.',
        ),
      ];

      await pumpFeed(tester, messages: messages);

      expect(find.byKey(const ValueKey('turn-steps-u-result')), findsNothing);
      expect(find.bySemanticsLabel('Agent steps: '), findsNothing);
    });

    testWidgets('a completed turn carries no rating controls', (tester) async {
      await pumpFeed(tester);

      // The transcript is the agent's answer, not a survey: the per-turn
      // thumbs were removed, and nothing replaced them inline.
      expect(find.byKey(const ValueKey('turn-feedback-up')), findsNothing);
      expect(find.byKey(const ValueKey('turn-feedback-down')), findsNothing);
      expect(find.bySemanticsLabel('Good response'), findsNothing);
      expect(find.bySemanticsLabel('Bad response'), findsNothing);
    });

    testWidgets('inline code in the answer takes the accent color', (
      tester,
    ) async {
      await pumpFeed(tester);
      final answer = find.byKey(const ValueKey('message-a-2'));
      final editableFinder = find.descendant(
        of: answer,
        matching: find.byType(EditableText),
      );
      final editable = tester.widget<EditableText>(editableFinder);
      final textSpan = editable.controller.buildTextSpan(
        context: tester.element(editableFinder),
        style: editable.style,
        withComposing: false,
      );
      final spans = <TextSpan>[];
      textSpan.visitChildren((span) {
        if (span is TextSpan) spans.add(span);
        return true;
      });
      final code = spans.firstWhere((s) => s.text == 'LoginBadge');
      expect(code.style?.color, AppColors.light['fg-accent']);
      // Accent text only — no tinted box behind it.
      expect(code.style?.backgroundColor, isNull);
    });

    testWidgets('a live turn shows every step inline with no steps row', (
      tester,
    ) async {
      // Desktop parity: `TurnGroupRenderer` renders all assistant messages
      // while a turn is running and only collapses on completion, so a
      // progress note the agent wrote mid-turn never vanishes as the next
      // step lands.
      const live = [
        ChatMessage(
          messageId: 'u-9',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Apply the tweaks',
        ),
        ChatMessage(
          messageId: 'a-9',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Assets are in place. Now applying the code changes.',
          parts: [
            ChatPart(kind: 'thinking', data: {'text': 'Plan the edits.'}),
          ],
        ),
        ChatMessage(
          messageId: 'a-10',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: '',
          parts: [
            ChatPart(
              kind: 'tool_use',
              toolFamily: 'edit',
              data: {'toolName': 'Edit', 'input': '{"file_path":"a.dart"}'},
            ),
          ],
        ),
        ChatMessage(
          messageId: 'a-11',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.streaming,
          text: 'Running the tests next.',
        ),
      ];
      await pumpFeed(tester, messages: live);

      expect(find.byKey(const ValueKey('turn-steps-u-9')), findsNothing);
      expect(
        find.text('Assets are in place. Now applying the code changes.'),
        findsOneWidget,
      );
      expect(find.text('Plan the edits.'), findsOneWidget);
      expect(find.text('Edit'), findsOneWidget);
      expect(find.text('Running the tests next.'), findsOneWidget);
      // No collapse pill either: nothing was expanded by the user.
      expect(find.byKey(const ValueKey('collapse-steps-pill')), findsNothing);
    });

    testWidgets('a live turn preserves assistant message chronology', (
      tester,
    ) async {
      const live = [
        ChatMessage(
          messageId: 'u-order',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Keep these in order',
        ),
        ChatMessage(
          messageId: 'a-progress',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'The first update is ready.',
        ),
        ChatMessage(
          messageId: 'a-tool',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.streaming,
          text: '',
          parts: [
            ChatPart(
              kind: 'tool_use',
              toolFamily: 'edit',
              data: {'toolName': 'Edit', 'input': '{"file_path":"a.dart"}'},
            ),
          ],
        ),
      ];

      await pumpFeed(tester, messages: live);

      final progress = find.byKey(const ValueKey('message-a-progress'));
      final tool = find.byKey(const ValueKey('message-a-tool'));
      expect(progress, findsOneWidget);
      expect(tool, findsOneWidget);
      expect(
        tester.getTopLeft(progress).dy,
        lessThan(tester.getTopLeft(tool).dy),
      );
    });

    testWidgets('a running turn shows one progress indicator, not two', (
      tester,
    ) async {
      // Cloud turns publish an empty streaming assistant row the moment the
      // turn starts and carry no timer part, so the bottom "Working..." row
      // is the turn's indicator. The streaming row must not add its own.
      List<ChatMessage> transcript(String text) => [
        const ChatMessage(
          messageId: 'u-9',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Apply the tweaks',
        ),
        ChatMessage(
          messageId: 'a-9',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.streaming,
          text: text,
        ),
      ];

      await pumpFeed(tester, messages: transcript(''), turnInProgress: true);
      expect(find.text('Working...'), findsOneWidget);
      expect(find.byType(ThinkingSpinner), findsOneWidget);

      await pumpFeed(
        tester,
        messages: transcript('Reading the auth flow.'),
        turnInProgress: true,
      );
      expect(find.text('Reading the auth flow.'), findsOneWidget);
      expect(find.byType(ThinkingSpinner), findsOneWidget);
    });

    testWidgets('a streaming row keeps its spinner when nothing else shows', (
      tester,
    ) async {
      // No liveness and no timer part: the row is the only sign of progress.
      const live = [
        ChatMessage(
          messageId: 'u-9',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Apply the tweaks',
        ),
        ChatMessage(
          messageId: 'a-9',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.streaming,
          text: 'Reading the auth flow.',
        ),
      ];
      await pumpFeed(tester, messages: live, turnInProgress: false);
      expect(find.text('Working...'), findsNothing);
      expect(find.byType(ThinkingSpinner), findsOneWidget);
    });

    group('thinking row', () {
      const long =
          'I will start by reading the auth flow, then trace the badge '
          'visibility through the router before touching any tests.';
      final preview = '${long.substring(0, 80)}…';

      List<ChatMessage> thinkingTurn(
        String thinking, {
        bool live = true,
        List<ChatMessage> earlier = const [],
      }) => [
        ...earlier,
        const ChatMessage(
          messageId: 'u-live',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Apply the tweaks',
        ),
        ChatMessage(
          messageId: 'a-live',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: live
              ? ChatMessageStatus.streaming
              : ChatMessageStatus.complete,
          text: live ? '' : 'Done.',
          parts: [
            ChatPart(kind: 'thinking', data: {'text': thinking}),
          ],
        ),
      ];

      Finder panel() => find.byKey(const ValueKey('thinking-panel'));

      testWidgets('stays collapsed to its preview on a live turn and after', (
        tester,
      ) async {
        // Desktop/web `CollapsibleBlock` parity: the label plus the first 80
        // characters, never the full reasoning, whether the turn runs or not.
        await pumpFeed(tester, messages: thinkingTurn(long));
        expect(find.text('Thinking'), findsOneWidget);
        expect(find.text(preview), findsOneWidget);
        expect(find.text(long), findsNothing);
        expect(panel(), findsNothing);

        await pumpFeed(tester, messages: thinkingTurn(long, live: false));
        expect(find.text(preview), findsOneWidget);
        expect(find.text(long), findsNothing);
        expect(panel(), findsNothing);
      });

      testWidgets('a tap during a live turn expands it and streaming text '
          'keeps it open; a second tap collapses it', (tester) async {
        await pumpFeed(tester, messages: thinkingTurn(long));
        await tester.tap(find.text('Thinking'));
        await tester.pumpAndSettle();
        expect(panel(), findsOneWidget);
        expect(
          find.descendant(of: panel(), matching: find.text(long)),
          findsOneWidget,
        );
        // Expanded, the header drops its preview like desktop does.
        expect(find.text(preview), findsNothing);

        const grown = '$long Then I will update the badge tests.';
        await pumpFeed(tester, messages: thinkingTurn(grown));
        expect(
          find.descendant(of: panel(), matching: find.text(grown)),
          findsOneWidget,
        );

        await tester.tap(find.text('Thinking'));
        await tester.pumpAndSettle();
        expect(panel(), findsNothing);
        expect(find.text(grown), findsNothing);
        expect(find.text('${grown.substring(0, 80)}…'), findsOneWidget);
      });

      testWidgets('the expanded panel caps its height and scrolls inside', (
        tester,
      ) async {
        final tall = [
          for (var line = 1; line <= 60; line++) 'Reasoning line $line.',
        ].join('\n');
        await pumpFeed(
          tester,
          messages: thinkingTurn(tall, earlier: _longTranscript(0, 8)),
        );
        await tester.tap(find.text('Thinking'));
        await tester.pumpAndSettle();

        expect(tester.getSize(panel()).height, 300);
        final inner = tester.state<ScrollableState>(
          find.descendant(of: panel(), matching: find.byType(Scrollable)),
        );
        final feed = tester.state<ScrollableState>(
          find
              .descendant(
                of: find.byKey(const ValueKey('remote-chat-transcript')),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        expect(inner.position.maxScrollExtent, greaterThan(0));
        expect(inner.position.pixels, 0);

        // A drag inside the panel scrolls the reasoning, not the feed.
        final feedBefore = feed.position.pixels;
        await tester.drag(panel(), const Offset(0, -120));
        await tester.pumpAndSettle();
        expect(inner.position.pixels, greaterThan(0));
        expect(feed.position.pixels, feedBefore);

        // A drag that starts outside the panel still scrolls the feed.
        await tester.drag(find.text('Apply the tweaks'), const Offset(0, 200));
        await tester.pumpAndSettle();
        expect(feed.position.pixels, isNot(feedBefore));
        expect(tester.takeException(), isNull);
      });

      testWidgets('expanded reasoning is plain monospace in a bordered panel, '
          'in light and dark', (tester) async {
        for (final dark in [false, true]) {
          await pumpFeed(
            tester,
            messages: thinkingTurn('First line.\nSecond line.', live: false),
            dark: dark,
          );
          await tester.tap(find.text('Thinking'));
          await tester.pumpAndSettle();

          final colors = dark ? AppColors.dark : AppColors.light;
          final body = tester.widget<Text>(
            find.descendant(
              of: panel(),
              matching: find.text('First line.\nSecond line.'),
            ),
          );
          expect(body.style?.fontStyle, isNot(FontStyle.italic));
          expect(body.style?.fontFamily, AppTypography.code.fontFamily);
          expect(body.style?.color, colors['fg-secondary']);
          final decoration =
              tester.widget<Container>(panel()).decoration! as BoxDecoration;
          expect(decoration.border, Border.all(color: colors['line-primary']));
          expect(decoration.borderRadius, BorderRadius.circular(AppRadii.sm));
          expect(decoration.color, isNotNull);
          // Indented under the label, past the 16 px glyph slot and its gap.
          expect(
            tester.getTopLeft(panel()).dx,
            tester.getTopLeft(find.text('Thinking')).dx,
          );
          await tester.pumpWidget(const SizedBox.shrink());
        }
      });

      testWidgets('reasoning of 80 characters or fewer shows in full', (
        tester,
      ) async {
        final exact = 'x' * 79 + '.';
        await pumpFeed(tester, messages: thinkingTurn(exact));
        expect(find.text(exact), findsOneWidget);
        expect(find.textContaining('…'), findsNothing);
        expect(panel(), findsNothing);
      });

      testWidgets('blank reasoning has no preview and is not a button', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await pumpFeed(tester, messages: thinkingTurn('   '));
        expect(find.text('Thinking'), findsOneWidget);
        expect(
          tester.getSemantics(find.text('Thinking')),
          isNot(isSemantics(isButton: true)),
        );
        await tester.tap(find.text('Thinking'), warnIfMissed: false);
        await tester.pumpAndSettle();
        expect(panel(), findsNothing);
        semantics.dispose();
      });

      testWidgets('the header announces a button with its expanded state', (
        tester,
      ) async {
        final semantics = tester.ensureSemantics();
        await pumpFeed(tester, messages: thinkingTurn(long));
        expect(
          tester.getSemantics(find.text('Thinking')),
          isSemantics(
            isButton: true,
            hasTapAction: true,
            hasExpandedState: true,
            isExpanded: false,
          ),
        );
        await tester.tap(find.text('Thinking'));
        await tester.pumpAndSettle();
        expect(
          tester.getSemantics(find.text('Thinking')),
          isSemantics(
            isButton: true,
            hasTapAction: true,
            hasExpandedState: true,
            isExpanded: true,
          ),
        );
        semantics.dispose();
      });

      testWidgets('a long single word fits a 390 px phone collapsed and '
          'expanded', (tester) async {
        final word = 'a' * 3000;
        await pumpFeed(tester, messages: thinkingTurn(word));
        expect(tester.takeException(), isNull);
        expect(find.text('${'a' * 80}…'), findsOneWidget);
        await tester.tap(find.text('Thinking'));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(tester.getSize(panel()).height, lessThanOrEqualTo(300));
        expect(tester.getTopRight(panel()).dx, lessThanOrEqualTo(390));
      });
    });

    testWidgets('the working timer counts on the phone clock, skew or not', (
      tester,
    ) async {
      // The desktop's clock runs five minutes AHEAD of the phone's. Subtracting
      // desktop `startedAt` from phone `now` would clamp at 0:00 forever; the
      // row must instead anchor on the phone clock when the timer row lands.
      var phoneNow = DateTime.fromMillisecondsSinceEpoch(1_000_000_000);
      final desktopNow = phoneNow.add(const Duration(minutes: 5));
      final live = [
        const ChatMessage(
          messageId: 'u-9',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Apply the tweaks',
        ),
        ChatMessage(
          messageId: 'u-9:turn-timer',
          chatId: 'chat-1',
          role: ChatRole.system,
          status: ChatMessageStatus.streaming,
          text: '',
          occurredAt: desktopNow,
          parts: [
            ChatPart(
              kind: 'turn_timer',
              data: {
                'startedAt': desktopNow.millisecondsSinceEpoch,
                'completedAt': null,
              },
            ),
          ],
        ),
      ];
      await pumpFeed(tester, messages: live, clock: () => phoneNow);
      expect(find.text('Working... 0:00'), findsOneWidget);

      phoneNow = phoneNow.add(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Working... 0:03'), findsOneWidget);
    });

    testWidgets('reopening a live chat resumes from the newer host duration', (
      tester,
    ) async {
      var phoneNow = DateTime.fromMillisecondsSinceEpoch(1_000_000_000);
      final desktopStartedAt = phoneNow.add(const Duration(minutes: 5));
      final live = [
        const ChatMessage(
          messageId: 'u-9',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Apply the tweaks',
        ),
        ChatMessage(
          messageId: 'u-9:turn-timer',
          chatId: 'chat-1',
          role: ChatRole.system,
          status: ChatMessageStatus.streaming,
          text: '',
          // Rehydration returns the original timer carrier frame. Its own
          // timestamp therefore only proves that the turn began at 0:00.
          occurredAt: desktopStartedAt,
          parts: [
            ChatPart(
              kind: 'turn_timer',
              data: {
                'startedAt': desktopStartedAt.millisecondsSinceEpoch,
                'completedAt': null,
              },
            ),
          ],
        ),
      ];

      // The chat summary is projected when the screen is opened and carries
      // the current desktop-measured duration. It must outrank the stale
      // carrier timestamp instead of restarting the visible count at zero.
      await pumpFeed(
        tester,
        messages: live,
        turnInProgress: true,
        turnElapsedMs: 20000,
        clock: () => phoneNow,
      );
      expect(find.text('Working... 0:20'), findsOneWidget);

      phoneNow = phoneNow.add(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Working... 0:23'), findsOneWidget);
    });

    testWidgets('a stale host refresh cannot move a live timer backwards', (
      tester,
    ) async {
      var phoneNow = DateTime.fromMillisecondsSinceEpoch(1_000_000_000);
      final desktopStartedAt = phoneNow.add(const Duration(minutes: 5));
      final live = [
        const ChatMessage(
          messageId: 'u-9',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Apply the tweaks',
        ),
        ChatMessage(
          messageId: 'u-9:turn-timer',
          chatId: 'chat-1',
          role: ChatRole.system,
          status: ChatMessageStatus.streaming,
          text: '',
          occurredAt: desktopStartedAt,
          parts: [
            ChatPart(
              kind: 'turn_timer',
              data: {
                'startedAt': desktopStartedAt.millisecondsSinceEpoch,
                'completedAt': null,
              },
            ),
          ],
        ),
      ];

      await pumpFeed(
        tester,
        messages: live,
        turnInProgress: true,
        turnElapsedMs: 20000,
        clock: () => phoneNow,
      );
      expect(find.text('Working... 0:20'), findsOneWidget);

      phoneNow = phoneNow.add(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Working... 0:23'), findsOneWidget);

      // A delayed summary was measured before the phone reached 0:23. The
      // mounted row must keep its locally accumulated duration when it
      // re-anchors to that same timer frame.
      await pumpFeed(
        tester,
        messages: live,
        turnInProgress: true,
        turnElapsedMs: 21000,
        clock: () => phoneNow,
      );
      expect(find.text('Working... 0:23'), findsOneWidget);
    });

    testWidgets(
      'turnActive fallback waits for a host duration before claiming a count',
      (tester) async {
        var phoneNow = DateTime.fromMillisecondsSinceEpoch(1_000_000_000);
        await pumpFeed(tester, turnInProgress: true, clock: () => phoneNow);

        // No host-measured duration yet: the row says the agent is working
        // without claiming a count the host would immediately contradict.
        expect(find.text('Working...'), findsOneWidget);
        expect(find.textContaining('Working... 0:'), findsNothing);

        phoneNow = phoneNow.add(const Duration(seconds: 3));
        await tester.pump(const Duration(seconds: 1));
        expect(find.text('Working...'), findsOneWidget);
      },
    );

    testWidgets(
      'the fallback row never counts backwards once the host reports',
      (tester) async {
        // The phone starts the row at send time, but the host only starts its
        // own turn clock once the message lands. Counting locally from zero
        // first made the row rewind to 0:00 a second or two in.
        var phoneNow = DateTime.fromMillisecondsSinceEpoch(1_000_000_000);
        await pumpFeed(tester, turnInProgress: true, clock: () => phoneNow);
        expect(find.text('Working...'), findsOneWidget);

        phoneNow = phoneNow.add(const Duration(seconds: 2));
        await tester.pump(const Duration(seconds: 1));
        expect(find.text('Working...'), findsOneWidget);

        // The host's first report lands: 0.4s in on its own clock.
        await pumpFeed(
          tester,
          turnInProgress: true,
          turnElapsedMs: 400,
          clock: () => phoneNow,
        );
        expect(find.text('Working... 0:00'), findsOneWidget);

        phoneNow = phoneNow.add(const Duration(seconds: 3));
        await tester.pump(const Duration(seconds: 1));
        expect(find.text('Working... 0:03'), findsOneWidget);
      },
    );

    testWidgets('turnActive fallback resumes from the host duration', (
      tester,
    ) async {
      var phoneNow = DateTime.fromMillisecondsSinceEpoch(1_000_000_000);
      await pumpFeed(
        tester,
        turnInProgress: true,
        turnElapsedMs: 550000,
        clock: () => phoneNow,
      );

      expect(find.text('Working... 9:10'), findsOneWidget);

      phoneNow = phoneNow.add(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Working... 9:13'), findsOneWidget);
    });

    testWidgets(
      'the authoritative turn timer gates feedback and becomes the completed row',
      (tester) async {
        final startedAt = DateTime.fromMillisecondsSinceEpoch(1_000_000_000);

        List<ChatMessage> transcript({required bool completed}) => [
          const ChatMessage(
            messageId: 'u-9',
            chatId: 'chat-1',
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'Apply the tweaks',
          ),
          const ChatMessage(
            messageId: 'a-9',
            chatId: 'chat-1',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'The first update is ready.',
          ),
          ChatMessage(
            messageId: 'u-9:turn-timer',
            chatId: 'chat-1',
            role: ChatRole.system,
            // Timer carrier frames settle independently of the agent turn.
            status: ChatMessageStatus.complete,
            text: '',
            occurredAt: startedAt.add(Duration(seconds: completed ? 63 : 126)),
            parts: [
              ChatPart(
                kind: 'turn_timer',
                data: {
                  'startedAt': startedAt.millisecondsSinceEpoch,
                  'completedAt': completed
                      ? startedAt
                            .add(const Duration(seconds: 63))
                            .millisecondsSinceEpoch
                      : null,
                },
              ),
            ],
          ),
        ];

        await pumpFeed(
          tester,
          messages: transcript(completed: false),
          clock: () => startedAt,
        );
        expect(find.text('Working... 2:06'), findsOneWidget);

        await pumpFeed(
          tester,
          messages: transcript(completed: true),
          clock: () => startedAt,
        );
        expect(find.text('Completed in 1:03'), findsOneWidget);
      },
    );

    testWidgets('trailing rows sit inside the transcript, below the answer', (
      tester,
    ) async {
      await pumpFeed(
        tester,
        trailing: const [SizedBox(key: ValueKey('trailing-card'), height: 40)],
      );

      final card = find.byKey(const ValueKey('trailing-card'));
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('remote-chat-transcript')),
          matching: card,
        ),
        findsOneWidget,
      );
      // Below the agent's last row, so the question reads as the tail of the
      // answer rather than a shelf pinned above the composer.
      expect(
        tester.getTopLeft(card).dy,
        greaterThanOrEqualTo(
          tester.getBottomLeft(find.byKey(const ValueKey('message-a-2'))).dy,
        ),
      );
    });

    testWidgets('a trailing row keeps its element as new messages land', (
      tester,
    ) async {
      const card = SizedBox(key: ValueKey('trailing-card'), height: 40);
      await pumpFeed(tester, trailing: const [card]);
      final before = tester.element(
        find.byKey(const ValueKey('trailing-card')),
      );

      // Appending shifts every builder index in the reversed list; without the
      // key-to-index remap the card would be rebuilt from scratch and any
      // typed freeform answer would vanish mid-stream.
      await pumpFeed(
        tester,
        messages: const [
          ..._transcript,
          ChatMessage(
            messageId: 'a-3',
            chatId: 'chat-1',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'One more thing.',
          ),
        ],
        trailing: const [card],
      );

      expect(
        tester.element(find.byKey(const ValueKey('trailing-card'))),
        same(before),
      );
    });

    testScroll('loads at most one older page until leaving the threshold', (
      tester,
    ) async {
      var loadCount = 0;
      await pumpFeed(
        tester,
        messages: _longTranscript(0, 16),
        onLoadOlder: () => loadCount += 1,
      );
      final controller = tester
          .widget<ListView>(
            find.byKey(const ValueKey('remote-chat-transcript')),
          )
          .controller!;

      controller.jumpTo(150);
      await tester.pump();
      expect(loadCount, 1);

      controller.jumpTo(100);
      await tester.pump();
      expect(loadCount, 1);

      controller.jumpTo(400);
      await tester.pump();
      controller.jumpTo(150);
      await tester.pump();
      expect(loadCount, 2);
    });

    testScroll('retries an empty older-history load in a short transcript', (
      tester,
    ) async {
      var loadCount = 0;
      final messages = _longTranscript(0, 6);
      await pumpFeed(
        tester,
        messages: messages,
        onLoadOlder: () => loadCount += 1,
      );
      final controller = tester
          .widget<ListView>(
            find.byKey(const ValueKey('remote-chat-transcript')),
          )
          .controller!;
      expect(controller.position.maxScrollExtent, greaterThan(0));
      expect(controller.position.maxScrollExtent, lessThanOrEqualTo(200));

      controller.jumpTo(controller.position.maxScrollExtent / 2);
      await tester.pump();
      expect(loadCount, 1);

      await pumpFeed(
        tester,
        messages: messages,
        onLoadOlder: () => loadCount += 1,
        loadingOlder: true,
      );
      await pumpFeed(
        tester,
        messages: messages,
        onLoadOlder: () => loadCount += 1,
      );
      controller.jumpTo(controller.position.pixels - 1);
      await tester.pump();

      expect(loadCount, 2);
    });

    testScroll('retries an older-history load that never renders a loading '
        'frame', (tester) async {
      var loadCount = 0;
      final messages = _longTranscript(0, 6);
      await pumpFeed(
        tester,
        messages: messages,
        onLoadOlder: () => loadCount += 1,
      );
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      // Short enough that no reachable offset clears the 200px threshold, so
      // the user cannot re-arm the latch by scrolling out and back in.
      expect(controller.position.maxScrollExtent, greaterThan(0));
      expect(controller.position.maxScrollExtent, lessThanOrEqualTo(200));

      controller.jumpTo(controller.position.maxScrollExtent / 2);
      await tester.pump();
      expect(loadCount, 1);

      // The request fails before a loading frame is ever rendered: the
      // transcript is unchanged and `loadingOlder` is never observed true.
      await pumpFeed(
        tester,
        messages: messages,
        onLoadOlder: () => loadCount += 1,
      );

      // A fresh drag is a fresh request to page older history.
      await tester.drag(transcript, const Offset(0, 40));
      await tester.pumpAndSettle();

      expect(loadCount, 2);
    });

    testScroll('preserves the visible anchor when older messages prepend', (
      tester,
    ) async {
      final recent = _longTranscript(10, 16);
      await pumpFeed(tester, messages: recent, onLoadOlder: () {});
      final controller = tester
          .widget<ListView>(
            find.byKey(const ValueKey('remote-chat-transcript')),
          )
          .controller!;
      await tester.drag(
        find.byKey(const ValueKey('remote-chat-transcript')),
        const Offset(0, 500),
      );
      await tester.pump();
      controller.jumpTo(150);
      await tester.pump();
      final anchor = find.byKey(const ValueKey('message-u-11'));
      expect(anchor, findsOneWidget);
      final anchorTopBefore = tester.getTopLeft(anchor).dy;

      await pumpFeed(
        tester,
        messages: [..._longTranscript(0, 10), ...recent],
        onLoadOlder: () {},
      );

      expect(
        tester.getTopLeft(anchor).dy,
        moreOrLessEquals(anchorTopBefore, epsilon: 5),
      );
    });

    testScroll(
      'preserves a partially visible viewport-taller anchor on prepend',
      (tester) async {
        final tallMessage = ChatMessage(
          messageId: 'u-tall',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: List.filled(
            80,
            'A long line keeps this message taller than the viewport.',
          ).join('\n'),
        );
        final recent = [
          tallMessage,
          const ChatMessage(
            messageId: 'a-tall',
            chatId: 'chat-1',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Tail response.',
          ),
        ];
        await pumpFeed(tester, messages: recent);
        final controller = tester
            .widget<ListView>(
              find.byKey(const ValueKey('remote-chat-transcript')),
            )
            .controller!;
        controller.jumpTo(150);
        await tester.pump();
        await pumpFeed(tester, messages: recent, onLoadOlder: () {});
        final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
        ScrollStartNotification(
          metrics: controller.position,
          context: tester.element(transcript),
          dragDetails: DragStartDetails(),
        ).dispatch(tester.element(transcript));
        controller.jumpTo(149);
        await tester.pump();
        final anchor = find.byKey(const ValueKey('message-u-tall'));
        expect(anchor, findsOneWidget);
        expect(tester.getSize(anchor).height, greaterThan(844));
        final anchorTopBefore = tester.getTopLeft(anchor).dy;

        await pumpFeed(
          tester,
          messages: [..._longTranscript(-1, 1), ...recent],
          onLoadOlder: () {},
        );

        expect(
          tester.getTopLeft(anchor).dy,
          moreOrLessEquals(anchorTopBefore, epsilon: 5),
        );
      },
    );

    testScroll(
      'preserves the visible anchor when the tail grows during a prepend',
      (tester) async {
        final recent = _longTranscript(10, 16);
        await pumpFeed(tester, messages: recent, onLoadOlder: () {});
        final controller = tester
            .widget<ListView>(
              find.byKey(const ValueKey('remote-chat-transcript')),
            )
            .controller!;
        await tester.drag(
          find.byKey(const ValueKey('remote-chat-transcript')),
          const Offset(0, 500),
        );
        await tester.pump();
        controller.jumpTo(150);
        await tester.pump();
        final anchor = find.byKey(const ValueKey('message-u-11'));
        expect(anchor, findsOneWidget);
        final anchorTopBefore = tester.getTopLeft(anchor).dy;

        final withTailGrowth = [...recent, ..._longTranscript(26, 1)];
        await pumpFeed(tester, messages: withTailGrowth, onLoadOlder: () {});
        expect(
          tester.getTopLeft(anchor).dy,
          moreOrLessEquals(anchorTopBefore, epsilon: 5),
        );

        await pumpFeed(
          tester,
          messages: [..._longTranscript(0, 10), ...withTailGrowth],
          onLoadOlder: () {},
        );

        expect(
          tester.getTopLeft(anchor).dy,
          moreOrLessEquals(anchorTopBefore, epsilon: 5),
        );
      },
    );

    testScroll('anchors on the reading position reached during a pending '
        'older-history load', (tester) async {
      final recent = _longTranscript(10, 16);
      await pumpFeed(tester, messages: recent, onLoadOlder: () {});
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      await tester.drag(transcript, const Offset(0, 500));
      await tester.pump();

      // Entering the threshold starts the older-history request.
      controller.jumpTo(150);
      await tester.pump();

      // The request is still in flight, and the reader keeps moving.
      await pumpFeed(
        tester,
        messages: recent,
        onLoadOlder: () {},
        loadingOlder: true,
      );
      controller.jumpTo(600);
      await tester.pump();
      final anchor = find.byKey(const ValueKey('message-u-17'));
      expect(anchor, findsOneWidget);
      final anchorTopBefore = tester.getTopLeft(anchor).dy;

      await pumpFeed(
        tester,
        messages: [..._longTranscript(0, 10), ...recent],
        onLoadOlder: () {},
      );

      // A stale request-start anchor scrolls this row out of the viewport
      // entirely, so assert it is still mounted before reading its offset.
      expect(anchor, findsOneWidget);
      expect(
        tester.getTopLeft(anchor).dy,
        moreOrLessEquals(anchorTopBefore, epsilon: 5),
      );
    });

    /// Scrolls until [row] is built, then puts its top [top] pixels below
    /// the transcript's top edge.
    Future<void> placeRow(
      WidgetTester tester,
      ScrollController controller,
      Finder row,
      double top,
    ) async {
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      for (var i = 0; i < 40 && row.evaluate().isEmpty; i++) {
        controller.jumpTo(
          math.max(
            controller.position.minScrollExtent,
            controller.position.pixels - 300,
          ),
        );
        await tester.pump();
      }
      controller.jumpTo(
        controller.position.pixels +
            tester.getTopLeft(row).dy -
            tester.getTopLeft(transcript).dy -
            top,
      );
      await tester.pumpAndSettle();
    }

    testScroll('keeps the reading row in place when a replaced head and an '
        'older page land together', (tester) async {
      // CAN-3373: a bounded snapshot drops a cached head above the reader,
      // the shorter list puts them inside the older-history threshold, and
      // that page lands while the head-replacement restore is still running.
      var loads = 0;
      void onLoadOlder() => loads += 1;
      await pumpFeed(
        tester,
        messages: _longTranscript(4, 16),
        onLoadOlder: onLoadOlder,
      );
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      await tester.drag(transcript, const Offset(0, 500));
      await tester.pumpAndSettle();
      final anchor = find.byKey(const ValueKey('message-u-10'));
      await placeRow(tester, controller, anchor, 260);
      expect(loads, 0);
      final anchorTopBefore = tester.getTopLeft(anchor).dy;

      await pumpFeed(
        tester,
        messages: _longTranscript(8, 12),
        onLoadOlder: onLoadOlder,
        settle: false,
      );
      expect(loads, 1, reason: 'the shorter list should page older history');
      // A fast reply: the page lands before the restore has finished.
      await pumpFeed(
        tester,
        messages: _longTranscript(0, 20),
        onLoadOlder: onLoadOlder,
        settle: false,
      );
      await tester.pumpAndSettle();

      expect(anchor, findsOneWidget);
      expect(
        tester.getTopLeft(anchor).dy,
        moreOrLessEquals(anchorTopBefore, epsilon: 5),
      );
    });

    testScroll('lands a reader whose rows were replaced on the nearest '
        'surviving row', (tester) async {
      await pumpFeed(
        tester,
        messages: _longTranscript(0, 20),
        onLoadOlder: () {},
      );
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      await tester.drag(transcript, const Offset(0, 500));
      await tester.pumpAndSettle();
      // Read rows 2..8, which the replacement drops with everything above.
      // The top of a-2 peeks above u-3, so a-2 is the first row on screen.
      await placeRow(
        tester,
        controller,
        find.byKey(const ValueKey('message-u-3')),
        10,
      );
      expect(find.byKey(const ValueKey('message-u-9')), findsNothing);
      final readingTop = tester
          .getTopLeft(find.byKey(const ValueKey('message-a-2')))
          .dy;
      expect(readingTop, lessThan(0));

      await pumpFeed(
        tester,
        messages: _longTranscript(9, 11),
        onLoadOlder: () {},
      );

      // The first surviving row after the dropped ones takes the place of the
      // first row on screen instead of the view jumping elsewhere.
      final survivor = find.byKey(const ValueKey('message-u-9'));
      expect(survivor, findsOneWidget);
      expect(
        tester.getTopLeft(survivor).dy,
        moreOrLessEquals(readingTop, epsilon: 5),
      );
    });

    testScroll('nested scrolling does not cancel following latest content', (
      tester,
    ) async {
      final initial = _longTranscript(0, 16);
      final nestedScrollerKey = GlobalKey<_ResizableHorizontalScrollerState>();
      await pumpFeed(
        tester,
        messages: initial,
        trailing: [_ResizableHorizontalScroller(key: nestedScrollerKey)],
      );
      final controller = tester
          .widget<ListView>(
            find.byKey(const ValueKey('remote-chat-transcript')),
          )
          .controller!;
      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );

      await tester.drag(
        find.byKey(const ValueKey('nested-horizontal-scrollable')),
        const Offset(-200, 0),
      );
      nestedScrollerKey.currentState!.expandHeight();
      await tester.pumpAndSettle();

      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );
    });

    testScroll('keeps following latest content after a drag that ends at '
        'the bottom', (tester) async {
      final initial = _longTranscript(0, 16);
      await pumpFeed(tester, messages: initial);
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );

      // A drag toward the newest content while already pinned at the bottom:
      // the gesture cannot move the viewport, so the user never left the
      // latest content and streaming should keep following.
      await tester.drag(transcript, const Offset(0, -40));
      await tester.pumpAndSettle();
      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );

      await pumpFeed(tester, messages: [...initial, ..._longTranscript(16, 6)]);

      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );
    });

    testScroll('resumes following once the reader drags back to the bottom', (
      tester,
    ) async {
      final initial = _longTranscript(0, 16);
      await pumpFeed(tester, messages: initial);
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;

      // Reading back into history opts out of following streamed content.
      await tester.drag(transcript, const Offset(0, 400));
      await tester.pumpAndSettle();
      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        greaterThan(1),
      );

      // Returning by hand, rather than via the latest affordance, is the same
      // intent: the reader is back on the newest content.
      await tester.drag(transcript, const Offset(0, -2000));
      await tester.pumpAndSettle();
      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );

      await pumpFeed(tester, messages: [...initial, ..._longTranscript(16, 6)]);

      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );
    });

    testScroll('appended rows do not yank the reader mid-gesture', (
      tester,
    ) async {
      final initial = _longTranscript(0, 16);
      await pumpFeed(tester, messages: initial);
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );

      // Finger down on the newest content, dragged back into history and
      // still held: the gesture has not settled, so no scroll end has fired.
      final gesture = await tester.startGesture(tester.getCenter(transcript));
      // Resolve the touch-slop gesture arena the way a real pointer stream
      // does before sending the remainder of the held drag. A single 360px
      // synthetic move lets selectable text claim the otherwise vertical
      // gesture before the list observes its direction.
      await gesture.moveBy(const Offset(0, 20));
      await tester.pump();
      await gesture.moveBy(const Offset(0, 340));
      await tester.pump();
      final gapDuringDrag =
          controller.position.maxScrollExtent - controller.position.pixels;
      expect(gapDuringDrag, greaterThan(1));

      await pumpFeed(
        tester,
        messages: [...initial, ..._longTranscript(16, 1)],
        settle: false,
      );
      await tester.pump();

      // A row landing mid-drag must not snap the viewport to the bottom.
      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        greaterThanOrEqualTo(gapDuringDrag - 1),
      );

      await gesture.up();
      await tester.pumpAndSettle();
    });

    testScroll('a flick up from the newest content is not snapped back', (
      tester,
    ) async {
      // iOS hands off to the ballistic phase after a drag that can end
      // within a couple of dozen pixels of the bottom. Reading follow
      // intent through the same slack the affordance uses leaves the feed
      // believing the reader never left the newest content, so the jump
      // that keeps it pinned cancels the flick before it travels.
      await pumpFeed(tester, messages: _longTranscript(0, 16));
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      final start = controller.position.pixels;

      await tester.fling(transcript, const Offset(0, 500), 1200);
      await tester.pumpAndSettle();

      expect(
        start - controller.position.pixels,
        greaterThan(24),
        reason: 'the flick was snapped back to the newest content',
      );
    });

    testScroll('never writes the position out from under a scroll activity', (
      tester,
    ) async {
      // The invariant behind the flick regression above, stated directly:
      // following the newest content must never cancel an activity that
      // already owns the position. Asserting the rule rather than one
      // symptom of it also covers gestures this suite does not enumerate.
      final spy = _JumpSpyController();
      addTearDown(spy.dispose);
      await pumpFeed(tester, messages: _longTranscript(0, 16), controller: spy);

      // A flick away from the newest content, with the turn still streaming
      // so the follow path is armed and rows keep landing underneath it.
      await tester.fling(
        find.byKey(const ValueKey('remote-chat-transcript')),
        const Offset(0, 500),
        1200,
      );
      await tester.pump();
      await pumpFeed(
        tester,
        messages: _longTranscript(0, 17),
        controller: spy,
        turnInProgress: true,
        settle: false,
      );
      await tester.pumpAndSettle();

      expect(
        spy.jumpsWhileScrolling,
        everyElement(isFalse),
        reason:
            'the feed jumped to the newest content while an activity still '
            'owned the position, cancelling it',
      );
    });

    testScroll('continuation landing passes do not cancel a reader drag', (
      tester,
    ) async {
      final spy = _JumpSpyController();
      addTearDown(spy.dispose);
      await pumpFeed(tester, messages: _unevenTranscript(60), controller: spy);
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));

      // Appended streaming content starts a non-forced multi-pass landing.
      await pumpFeed(
        tester,
        messages: _unevenTranscript(80),
        controller: spy,
        turnInProgress: true,
        settle: false,
      );

      // The first landing pass has scheduled a continuation. Begin a small
      // drag before that pass runs: it is within the feed's 24px latest-content
      // slack, so following remains armed, but the gesture owns the position.
      spy.jumpsWhileScrolling.clear();
      final gesture = await tester.startGesture(tester.getCenter(transcript));
      await gesture.moveBy(const Offset(0, 20));
      await tester.pump();

      expect(
        spy.jumpsWhileScrolling,
        everyElement(isFalse),
        reason:
            'a continuation pass jumped while the reader drag owned the '
            'position',
      );

      await gesture.up();
      await tester.pumpAndSettle();
    });

    testScroll('CAN-3945 stays on the newest message when a cached tail is '
        'replaced by the full uneven transcript', (tester) async {
      // A cached tail opens first; the desktop snapshot then replaces it with
      // the whole history. Its tall early rows make the lazy list's extent
      // estimate wrong by thousands of pixels until the real end lays out.
      final full = _unevenTranscript(60);
      await pumpFeed(tester, messages: full.sublist(full.length - 40));

      final recorded = await recordPaintedScrollFrames(
        tester,
        feedController(tester).position,
        () => pumpFeed(tester, messages: full, settle: false),
      );

      expectEveryFrameOnNewest(recorded);
      expect(find.byKey(const ValueKey('message-a-59')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testScroll('CAN-3945 the first frame after the last row grows already '
        'shows the newest content', (tester) async {
      final rowKey = GlobalKey<_ResizableRowState>();
      await pumpFeed(
        tester,
        messages: _longTranscript(0, 16),
        trailing: [_ResizableRow(key: rowKey, height: 80)],
      );

      final recorded = await recordPaintedScrollFrames(
        tester,
        feedController(tester).position,
        () async => rowKey.currentState!.resize(2880),
      );

      expectEveryFrameOnNewest(recorded);
      expect(
        tester.getRect(find.byKey(rowKey)).bottom,
        moreOrLessEquals(
          tester
              .getRect(find.byKey(const ValueKey('remote-chat-transcript')))
              .bottom,
          epsilon: 9,
        ),
      );
      expect(tester.takeException(), isNull);
    });

    testScroll('CAN-3945 the first frame after a streamed answer grows already '
        'shows the newest content', (tester) async {
      final initial = _longTranscript(0, 16);
      await pumpFeed(tester, messages: initial);
      final grown = [
        ...initial.sublist(0, initial.length - 1),
        ChatMessage(
          messageId: 'a-15',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Answer 15. ${'A long multi-paragraph answer body. ' * 120}',
        ),
      ];

      final recorded = await recordPaintedScrollFrames(
        tester,
        feedController(tester).position,
        () => pumpFeed(tester, messages: grown, settle: false),
      );

      expectEveryFrameOnNewest(recorded);
      expect(tester.takeException(), isNull);
    });

    testScroll('CAN-3945 rests on the newest content without a corrective '
        'animation when the last row shrinks', (tester) async {
      final rowKey = GlobalKey<_ResizableRowState>();
      await pumpFeed(
        tester,
        messages: _longTranscript(0, 16),
        trailing: [_ResizableRow(key: rowKey, height: 2880)],
      );

      final recorded = await recordPaintedScrollFrames(
        tester,
        feedController(tester).position,
        () async => rowKey.currentState!.resize(80),
      );

      expectEveryFrameOnNewest(recorded);
      expect(tester.takeException(), isNull);
    });

    testScroll('CAN-3945 a held drag keeps the position while the last row '
        'grows', (tester) async {
      // The feed's own controller corrects the position during layout, which
      // a jump spy cannot see. A reader's held drag must still own it.
      final rowKey = GlobalKey<_ResizableRowState>();
      await pumpFeed(
        tester,
        messages: _longTranscript(0, 16),
        trailing: [_ResizableRow(key: rowKey, height: 80)],
      );
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final position = feedController(tester).position;

      final gesture = await tester.startGesture(tester.getCenter(transcript));
      await gesture.moveBy(const Offset(0, 20));
      await tester.pump();
      await gesture.moveBy(const Offset(0, 10));
      await tester.pump();
      final heldAt = position.pixels;
      expect(position.maxScrollExtent - heldAt, inInclusiveRange(1, 24));

      rowKey.currentState!.resize(2880);
      await tester.pump();
      await tester.pump();

      expect(
        position.pixels,
        heldAt,
        reason: 'the feed moved the position under a held drag',
      );

      await gesture.up();
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });

    testScroll('offers the way back as soon as the reader leaves the latest '
        'content', (tester) async {
      final initial = _longTranscript(0, 16);
      await pumpFeed(tester, messages: initial);
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      final affordance = find.byKey(
        const ValueKey('remote-chat-scroll-to-bottom'),
      );
      expect(affordance, findsNothing);

      // Well short of a full viewport: far enough to stop following the
      // newest content, so the reader needs a way back.
      controller.jumpTo(controller.position.maxScrollExtent - 100);
      await tester.pumpAndSettle();
      final gap =
          controller.position.maxScrollExtent - controller.position.pixels;
      expect(gap, greaterThan(24));
      expect(gap, lessThan(controller.position.viewportDimension));

      expect(affordance, findsOneWidget);
    });

    testScroll('recomputes the latest affordance after content grows', (
      tester,
    ) async {
      final initial = _longTranscript(0, 12);
      await pumpFeed(tester, messages: initial);
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      final affordance = find.byKey(
        const ValueKey('remote-chat-scroll-to-bottom'),
      );
      expect(affordance, findsNothing);

      controller.jumpTo(controller.position.maxScrollExtent - 100);
      await tester.pumpAndSettle();
      expect(affordance, findsOneWidget);
      final pixelsBefore = controller.position.pixels;

      // Growth arrives as a content-dimension change with no scrolling, and
      // must not move a reader who has opted out.
      await pumpFeed(
        tester,
        messages: [...initial, ..._longTranscript(12, 10)],
      );
      expect(
        controller.position.pixels,
        moreOrLessEquals(pixelsBefore, epsilon: 1),
      );
      expect(affordance, findsOneWidget);

      // The affordance targets the grown transcript, not the stale extent.
      await tester.tap(affordance);
      await tester.pumpAndSettle();
      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );
    });

    testScroll('latest action follows content appended during its animation', (
      tester,
    ) async {
      // The 250ms latest animation only ticks across frames with animations
      // enabled. Under reduce-motion it resolves in a single step and never
      // passes through the mid-flight offsets this test is about. Safe here
      // because these fixtures have no always-on spinner; add one and the
      // trailing pumpAndSettle would hang instead of failing.
      tester.binding.platformDispatcher.clearAccessibilityFeaturesTestValue();
      final initial = _longTranscript(0, 18);
      await pumpFeed(tester, messages: initial);
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      await tester.drag(transcript, const Offset(0, 6000));
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const ValueKey('remote-chat-scroll-to-bottom')),
      );
      // Frame-paced so the animation is genuinely in flight when the new
      // rows land, which is the only shape that exercises the retarget.
      for (var frame = 0; frame < 6; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
        if (frame == 2) {
          // The pacing is load-bearing: if the tween has already finished,
          // this test stops covering the retarget and passes vacuously.
          expect(controller.position.pixels, greaterThan(0));
          expect(
            controller.position.pixels,
            lessThan(controller.position.maxScrollExtent - 1),
          );
          await pumpFeed(
            tester,
            messages: [...initial, ..._longTranscript(18, 8)],
            settle: false,
          );
        }
      }
      await tester.pumpAndSettle();

      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );
    });

    testScroll('pointer down interrupts the latest animation', (tester) async {
      // Same pacing as the sibling test above: a real in-flight animation.
      tester.binding.platformDispatcher.clearAccessibilityFeaturesTestValue();
      final initial = _longTranscript(0, 18);
      await pumpFeed(tester, messages: initial);
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      await tester.drag(transcript, const Offset(0, 6000));
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const ValueKey('remote-chat-scroll-to-bottom')),
      );
      for (var frame = 0; frame < 3; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      // There must be a live animation to interrupt, or this passes vacuously.
      expect(
        controller.position.pixels,
        lessThan(controller.position.maxScrollExtent - 1),
      );
      final gesture = await tester.startGesture(tester.getCenter(transcript));
      await tester.pump(const Duration(milliseconds: 16));
      await gesture.up();
      await tester.pumpAndSettle();

      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        greaterThan(1),
      );
    });

    testScroll('switching chats mid-animation lands on the new chat', (
      tester,
    ) async {
      tester.binding.platformDispatcher.clearAccessibilityFeaturesTestValue();
      await pumpFeed(tester, messages: _longTranscript(0, 18));
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      await tester.drag(transcript, const Offset(0, 6000));
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const ValueKey('remote-chat-scroll-to-bottom')),
      );
      await tester.pump(const Duration(milliseconds: 16));

      // The reader switches tabs while that animation is running. This state
      // object is reused across chats, so the stale animation must not keep
      // owning the position and chase the previous chat's target.
      await pumpFeed(
        tester,
        messages: _longTranscript(100, 40),
        chatId: 'chat-2',
        settle: false,
      );
      await tester.pump();
      await tester.pump();

      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );
    });

    testScroll('latest action outranks a history page landing mid-animation', (
      tester,
    ) async {
      tester.binding.platformDispatcher.clearAccessibilityFeaturesTestValue();
      final recent = _longTranscript(10, 16);
      await pumpFeed(tester, messages: recent, onLoadOlder: () {});
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      await tester.drag(transcript, const Offset(0, 6000));
      await tester.pumpAndSettle();
      controller.jumpTo(150);
      await tester.pump();

      await tester.tap(
        find.byKey(const ValueKey('remote-chat-scroll-to-bottom')),
      );
      await tester.pump(const Duration(milliseconds: 16));
      await tester.pump(const Duration(milliseconds: 16));

      // The older page requested at the threshold lands mid-animation. An
      // explicit tap outranks preserving the old reading position.
      await pumpFeed(
        tester,
        messages: [..._longTranscript(0, 10), ...recent],
        onLoadOlder: () {},
        settle: false,
      );
      await tester.pumpAndSettle();

      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );
    });

    testScroll('a second latest tap does not cut the animation short', (
      tester,
    ) async {
      tester.binding.platformDispatcher.clearAccessibilityFeaturesTestValue();
      await pumpFeed(tester, messages: _longTranscript(0, 18));
      final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
      final controller = tester.widget<ListView>(transcript).controller!;
      final affordance = find.byKey(
        const ValueKey('remote-chat-scroll-to-bottom'),
      );
      await tester.drag(transcript, const Offset(0, 6000));
      await tester.pumpAndSettle();

      await tester.tap(affordance);
      await tester.pump(const Duration(milliseconds: 16));
      await tester.pump(const Duration(milliseconds: 16));
      await tester.tap(affordance);
      await tester.pump(const Duration(milliseconds: 16));

      // Still easing toward the newest content rather than snapped onto it.
      expect(
        controller.position.pixels,
        lessThan(controller.position.maxScrollExtent - 1),
      );

      await tester.pumpAndSettle();
      expect(
        controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1),
      );
    });

    testScroll('opens on the latest content without a corrective scroll '
        'animation', (tester) async {
      // A lazily built list only estimates `maxScrollExtent` from the rows it
      // has built. Jumping to that estimate on an uneven transcript overshoots
      // the real end by thousands of pixels, and the scroll physics then
      // animate the viewport back — a visible glide down the whole history.
      await pumpFeed(tester, messages: _unevenTranscript(80), settle: false);
      final controller = tester
          .widget<ListView>(
            find.byKey(const ValueKey('remote-chat-transcript')),
          )
          .controller!;

      // A few frames is all an exact landing needs: jump, re-measure, re-clamp.
      for (var frame = 0; frame < 5; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
      }

      final position = controller.position;
      expect(
        position.pixels,
        moreOrLessEquals(position.maxScrollExtent, epsilon: 1),
        reason: 'the feed should be resting on the newest content',
      );
      expect(
        position.isScrollingNotifier.value,
        isFalse,
        reason: 'no scroll activity should still be correcting the position',
      );
    });

    for (final (shape, messages) in [
      ('even', _longTranscript(0, 25)),
      ('uneven', _unevenTranscript(25)),
    ]) {
      testScroll('lays out an $shape 50-row transcript on its newest row in '
          'the first frame', (tester) async {
        // CAN-3373: a chat reopened from the on-device cache has its rows at
        // the first build. The newest one must be laid out in the viewport
        // on that frame, not a frame after the history's top.
        await pumpFeed(tester, messages: messages, firstFrameOnly: true);
        final controller = tester
            .widget<ListView>(
              find.byKey(const ValueKey('remote-chat-transcript')),
            )
            .controller!;
        final newest = find.byKey(const ValueKey('message-a-24'));
        expect(newest, findsOneWidget);
        expect(
          controller.position.pixels,
          moreOrLessEquals(controller.position.maxScrollExtent, epsilon: 1),
        );
        final transcript = tester.getRect(
          find.byKey(const ValueKey('remote-chat-transcript')),
        );
        expect(
          tester.getRect(newest).bottom,
          lessThanOrEqualTo(transcript.bottom),
        );

        // The landing gate still opens once the landing has confirmed it,
        // and nothing moves on the way.
        final landedAt = tester.getTopLeft(newest).dy;
        final gate = find.byKey(
          const ValueKey('remote-chat-transcript-visibility'),
        );
        for (var frame = 2; frame <= 3; frame++) {
          await tester.pump();
          expect(tester.getTopLeft(newest).dy, landedAt);
        }
        expect(tester.widget<Opacity>(gate).opacity, 1);
        expect(controller.position.isScrollingNotifier.value, isFalse);
      });
    }

    testScroll('keeps the transcript hidden until it lands on the latest '
        'content', (tester) async {
      await pumpFeed(tester, messages: _unevenTranscript(80), settle: false);
      final gate = find.byKey(
        const ValueKey('remote-chat-transcript-visibility'),
      );

      // The landing runs in a post-frame callback, so the first painted frame
      // is still at the top of the history. It must not be shown.
      expect(tester.widget<Opacity>(gate).opacity, 0);

      await tester.pumpAndSettle();
      expect(tester.widget<Opacity>(gate).opacity, 1);
    });

    testScroll('stale landing callbacks cannot reveal a newer chat', (
      tester,
    ) async {
      const gateKey = ValueKey('remote-chat-transcript-visibility');
      await pumpFeed(tester, messages: _unevenTranscript(80), settle: false);
      expect(tester.widget<Opacity>(find.byKey(gateKey)).opacity, 0);

      // Switch chats while the first transcript still has continuation passes
      // queued. Those callbacks belong to the old layout and must not open the
      // visibility gate that the new transcript just re-armed.
      await pumpFeed(
        tester,
        chatId: 'chat-2',
        messages: _unevenTranscript(100),
        settle: false,
      );

      expect(
        tester.widget<Opacity>(find.byKey(gateKey)).opacity,
        0,
        reason:
            'a continuation from the previous chat revealed the replacement '
            'transcript before its own landing converged',
      );

      await tester.pumpAndSettle();
      expect(tester.widget<Opacity>(find.byKey(gateKey)).opacity, 1);
    });

    testScroll('re-hides a stable chat while an empty feed hydrates', (
      tester,
    ) async {
      const gateKey = ValueKey('remote-chat-transcript-visibility');
      await pumpFeed(tester, messages: const [], turnInProgress: true);
      expect(tester.widget<Opacity>(find.byKey(gateKey)).opacity, 1);

      await pumpFeed(
        tester,
        messages: _unevenTranscript(80),
        turnInProgress: true,
        settle: false,
      );

      expect(
        tester.widget<Opacity>(find.byKey(gateKey)).opacity,
        0,
        reason:
            'the hydrated transcript must stay hidden until its authoritative '
            'landing completes',
      );

      await tester.pumpAndSettle();
      expect(tester.widget<Opacity>(find.byKey(gateKey)).opacity, 1);
    });

    testScroll('reveals a transcript too short to scroll', (tester) async {
      // Fail-open: nothing to land on must never leave the feed invisible.
      await pumpFeed(tester, settle: false);
      final gate = find.byKey(
        const ValueKey('remote-chat-transcript-visibility'),
      );

      await tester.pumpAndSettle();
      expect(tester.widget<Opacity>(gate).opacity, 1);
      expect(find.text('Fix the login badge'), findsOneWidget);
    });

    testWidgets('dark mode uses the dark brand tokens', (tester) async {
      await pumpFeed(tester, dark: true);
      final decoration = decorationUnder(
        tester,
        find.byKey(const ValueKey('user-bubble-u-1')),
      );
      expect(decoration?.color, AppColors.dark['bg-quaternary']);
    });
  });

  group('unchanged rows', () {
    // Rows a store republishes keep their object identity, so they are
    // created once here and shared across pumps; only the live answer is a
    // new object per streamed revision. Short enough that every row is laid
    // out, so a zero build count cannot come from virtualization.
    final startedAt = DateTime(2026, 1, 1, 9);
    final completedTurn = <ChatMessage>[
      const ChatMessage(
        messageId: 'u-1',
        chatId: 'chat-1',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'Fix the login badge',
      ),
      const ChatMessage(
        messageId: 'a-1',
        chatId: 'chat-1',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: '',
        parts: [
          ChatPart(
            kind: 'tool_use',
            toolFamily: 'bash',
            data: {
              'toolName': 'Bash',
              'toolUseId': 'tool-1',
              'input': '{"command":"npm test"}',
            },
          ),
        ],
      ),
      const ChatMessage(
        messageId: 'r-1',
        chatId: 'chat-1',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: '',
        parts: [
          ChatPart(
            kind: 'tool_result',
            data: {'toolUseId': 'tool-1', 'output': 'all green'},
          ),
        ],
      ),
      const ChatMessage(
        messageId: 'a-2',
        chatId: 'chat-1',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: 'Done — the badge shows only on sign-in.',
      ),
      ChatMessage(
        messageId: 'timer-1',
        chatId: 'chat-1',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: '',
        parts: [
          ChatPart(
            kind: 'turn_timer',
            data: {
              'startedAt': startedAt.millisecondsSinceEpoch,
              'completedAt': startedAt
                  .add(const Duration(seconds: 63))
                  .millisecondsSinceEpoch,
            },
          ),
        ],
      ),
    ];
    const livePrompt = ChatMessage(
      messageId: 'u-2',
      chatId: 'chat-1',
      role: ChatRole.user,
      status: ChatMessageStatus.complete,
      text: 'Now the logout badge',
    );
    const liveStep = ChatMessage(
      messageId: 's-3',
      chatId: 'chat-1',
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: '',
      parts: [
        ChatPart(
          kind: 'tool_use',
          toolFamily: 'read',
          data: {'toolName': 'Read', 'toolUseId': 'tool-3'},
        ),
      ],
    );
    ChatMessage liveAnswer(int revision) => ChatMessage(
      messageId: 'a-3',
      chatId: 'chat-1',
      role: ChatRole.assistant,
      status: ChatMessageStatus.streaming,
      text: 'Streaming answer $revision',
    );

    const completedRowKeys = [
      ValueKey('message-content-u-1'),
      ValueKey('message-content-a-2'),
      ValueKey('message-content-u-2'),
      ValueKey('message-content-s-3'),
      ValueKey('turn-steps-u-1'),
    ];

    testWidgets('streaming the live answer rebuilds no other row', (
      tester,
    ) async {
      await pumpFeed(
        tester,
        messages: [...completedTurn, livePrompt, liveStep, liveAnswer(0)],
      );
      for (final key in completedRowKeys) {
        expect(find.byKey(key), findsOneWidget, reason: '$key is on screen');
      }
      final completedTimer = tester.element(find.text('Completed in 1:03'));
      final counter = RebuildCounter();

      for (var revision = 1; revision <= 3; revision++) {
        await pumpFeed(
          tester,
          messages: [
            ...completedTurn,
            livePrompt,
            liveStep,
            liveAnswer(revision),
          ],
        );
      }

      expect(find.text('Streaming answer 3'), findsOneWidget);
      expect(
        counter.ofKey(const ValueKey('message-content-a-3')),
        greaterThan(0),
      );
      for (final key in completedRowKeys) {
        expect(counter.ofKey(key), 0, reason: '$key rebuilt');
      }
      expect(counter.ofElement(completedTimer), 0);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a parent rebuild with unchanged inputs rebuilds no row', (
      tester,
    ) async {
      await pumpFeed(tester, expandedTurns: const {'u-1'});
      final counter = RebuildCounter();

      await pumpFeed(tester, expandedTurns: const {'u-1'});

      for (final id in ['u-1', 'a-1', 'a-2']) {
        final key = ValueKey('message-content-$id');
        expect(find.byKey(key), findsOneWidget);
        expect(counter.ofKey(key), 0, reason: '$id rebuilt');
      }
      expect(counter.ofKey(const ValueKey('turn-steps-u-1')), 0);
    });

    testWidgets('a corrected completed turn reaches its rows', (tester) async {
      await pumpFeed(tester, messages: completedTurn);
      expect(find.text('Done — the badge shows only on sign-in.'), findsOne);

      // An authoritative snapshot republishes rows of a finished turn: the
      // answer text changes and its step gains a call, same ids throughout.
      await pumpFeed(
        tester,
        messages: [
          completedTurn[0],
          const ChatMessage(
            messageId: 'a-1',
            chatId: 'chat-1',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: '',
            parts: [
              ChatPart(
                kind: 'tool_use',
                toolFamily: 'bash',
                data: {'toolName': 'Bash', 'toolUseId': 'tool-1'},
              ),
              ChatPart(
                kind: 'tool_use',
                toolFamily: 'bash',
                data: {'toolName': 'Bash', 'toolUseId': 'tool-2'},
              ),
            ],
          ),
          completedTurn[2],
          const ChatMessage(
            messageId: 'a-2',
            chatId: 'chat-1',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Corrected answer.',
          ),
          completedTurn[4],
        ],
      );

      expect(find.text('Corrected answer.'), findsOneWidget);
      expect(
        find.text('Done — the badge shows only on sign-in.'),
        findsNothing,
      );
      expect(find.bySemanticsLabel('Agent steps: 2 bash'), findsOneWidget);
    });

    testWidgets('a late tool result reaches a finished turn', (tester) async {
      final withoutResult = [
        for (final message in completedTurn)
          if (message.messageId != 'r-1') message,
      ];
      await pumpFeed(
        tester,
        messages: withoutResult,
        expandedTurns: const {'u-1'},
      );
      expect(find.text('all green'), findsNothing);

      await pumpFeed(
        tester,
        messages: completedTurn,
        expandedTurns: const {'u-1'},
      );
      await tester.tap(find.byKey(const ValueKey('tool-a-1-tool-1')));
      await tester.pumpAndSettle();

      expect(find.textContaining('all green'), findsOneWidget);
    });

    testWidgets('expanding steps and a new toggle callback reach the row', (
      tester,
    ) async {
      final toggled = <String>[];
      await pumpFeed(tester, onToggleTurn: (_) => fail('stale callback'));
      expect(find.byKey(const ValueKey('message-content-a-1')), findsNothing);

      await pumpFeed(tester, onToggleTurn: toggled.add);
      await tester.tap(find.byKey(const ValueKey('turn-steps-u-1')));
      expect(toggled, ['u-1']);

      await pumpFeed(
        tester,
        expandedTurns: const {'u-1'},
        onToggleTurn: toggled.add,
      );
      expect(find.byKey(const ValueKey('message-content-a-1')), findsOneWidget);
    });

    testWidgets('a theme change still repaints unchanged rows', (tester) async {
      await pumpFeed(tester);
      await pumpFeed(tester, dark: true);

      final decoration = decorationUnder(
        tester,
        find.byKey(const ValueKey('user-bubble-u-1')),
      );
      expect(decoration?.color, AppColors.dark['bg-quaternary']);
    });

    testWidgets('a typed Other answer survives streaming and history', (
      tester,
    ) async {
      List<AskUserQuestionAnswer>? submitted;
      final question = PendingQuestionCard(
        key: const ValueKey('question-req-1'),
        request: const AskUserQuestionState(
          requestId: 'req-1',
          questions: [
            AskUserQuestion(
              id: 'q1',
              question: 'Deploy now?',
              options: ['Yes', 'No'],
              allowOther: true,
            ),
          ],
        ),
        onSubmit: (answers) => submitted = answers,
        onDismiss: () {},
      );
      final recent = [...completedTurn, livePrompt, liveAnswer(0)];
      await pumpFeed(tester, messages: recent, trailing: [question]);
      await tester.ensureVisible(find.text('Other'));
      await tester.tap(find.text('Other'));
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('question-other-field-req-1-0')),
        'Tomorrow',
      );

      await pumpFeed(
        tester,
        messages: [...completedTurn, livePrompt, liveAnswer(1)],
        trailing: [question],
      );
      await pumpFeed(
        tester,
        messages: [..._longTranscript(100, 3), ...completedTurn, livePrompt],
        trailing: [question],
      );
      final submit = find.byKey(const ValueKey('question-submit-req-1'));
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await tester.pump();

      expect(submitted!.single.freeformText, 'Tomorrow');
    });
  });

  group('watcher messages (CAN-4432)', () {
    Finder watcherIconIn(String messageId) => find.descendant(
      of: find.byKey(ValueKey('message-$messageId')),
      matching: find.byWidgetPredicate(
        (widget) => widget is ChatIcon && widget.glyph == ChatGlyph.watcher,
      ),
    );

    testWidgets('a cloud watcher message shows its title, never the '
        'instruction block', (tester) async {
      await pumpFeed(
        tester,
        messages: _cloudWatcherTranscript(
          _cloudWatcherText('Chat completion: Plan the mobile launch'),
          watcherFired: const ChatWatcherFiredInfo(
            kind: 'Chat completion: Plan the mobile launch',
          ),
        ),
      );

      for (final hidden in [
        '<system_instruction>',
        '_watcher_event>',
        _watcherSentinel,
        '"watcherId"',
      ]) {
        expect(
          find.textContaining(hidden, findRichText: true),
          findsNothing,
          reason: hidden,
        );
      }
      expect(
        find.textContaining('Canopy watcher fired.', findRichText: true),
        findsWidgets,
      );
      expect(
        find.text('Chat completion: Plan the mobile launch watcher has fired'),
        findsOneWidget,
      );
      expect(watcherIconIn('u-w'), findsOneWidget);
    });

    testWidgets('a Remote Control watcher row shows the watcher title, '
        'icon and info tint', (tester) async {
      await pumpFeed(
        tester,
        messages: [
          _remoteUserRow(
            'w-1',
            'Canopy watcher fired.\n'
                'Worktree pipeline completion: Code Review',
            watcherFired: {'kind': 'Pipeline completion (Code Review)'},
          ),
        ],
      );

      expect(
        find.text('Pipeline completion (Code Review) watcher has fired'),
        findsOneWidget,
      );
      expect(watcherIconIn('w-1'), findsOneWidget);
      final decoration = decorationUnder(
        tester,
        find.byKey(const ValueKey('message-w-1')),
      );
      expect(
        decoration?.color,
        StatusColors.light.unread.withValues(alpha: 0.16),
      );
    });

    const mergedMarker = {
      'kind': 'Multiple watchers fired (2)',
      'combinedWatchers': [
        {
          'kind': 'Pipeline completion (Deploy)',
          'text': 'Canopy watcher fired.\nWorktree pipeline completion: Deploy',
        },
        {
          'kind': 'Chat completion: Release notes',
          'text': 'Canopy watcher fired.\nChat completion: Release notes',
        },
      ],
    };

    RemoteChatMessage mergedRow() => _remoteUserRow(
      'merged',
      'Two watchers fired.',
      parts: [
        {
          'kind': 'prompt_source',
          'data': {'source': 'automated', 'watcherFired': mergedMarker},
        },
      ],
    );

    testWidgets('the dark theme uses the dark info ink and tint', (
      tester,
    ) async {
      await pumpFeed(
        tester,
        dark: true,
        messages: [
          _remoteUserRow(
            'w-1',
            'Canopy watcher fired.',
            watcherFired: {'kind': 'Pipeline completion (Deploy)'},
          ),
        ],
      );
      final bubble = find.byKey(const ValueKey('watcher-bubble-w-1'));
      final decoration = decorationUnder(tester, bubble);
      expect(
        decoration?.color,
        StatusColors.dark.unread.withValues(alpha: 0.16),
      );
      expect(decoration?.border?.top.color, AppColors.dark['line-primary']);
      expect(decoration?.borderRadius, BorderRadius.circular(AppRadii.xl));
      final title = tester.widget<Text>(
        find.text('Pipeline completion (Deploy) watcher has fired'),
      );
      expect(title.style?.color, StatusColors.dark.unread);
      final icon = tester.widget<ChatIcon>(watcherIconIn('w-1'));
      expect(icon.color, StatusColors.dark.unread);
      // Same place and width as a user bubble.
      final feed = tester.getRect(find.byType(ChatFeed));
      expect(tester.getRect(bubble).width, greaterThan(feed.width * 0.9));
    });

    testWidgets('a single watcher title is one label and not a button', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await pumpFeed(
        tester,
        messages: [
          _remoteUserRow(
            'w-1',
            'Canopy watcher fired.',
            watcherFired: {'kind': 'Pipeline completion (Deploy)'},
          ),
        ],
      );
      final title = find.byKey(const ValueKey('watcher-title-w-1'));
      expect(
        tester.getSemantics(title),
        matchesSemantics(
          label: 'Pipeline completion (Deploy) watcher has fired',
        ),
      );
      await tester.tap(title);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('watcher-details-sheet')), findsNothing);
      semantics.dispose();
    });

    testWidgets('a merged title is a 48dp button that lists each watcher, '
        'and closing it keeps the transcript in place', (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = ScrollController();
      addTearDown(controller.dispose);
      final messages = [
        ..._longTranscript(0, 10),
        mergedRow(),
        ..._longTranscript(10, 10),
      ];
      await pumpFeed(tester, messages: messages, controller: controller);
      final title = find.byKey(const ValueKey('watcher-title-merged'));
      // The feed opens on the newest rows and builds older ones lazily.
      await tester.scrollUntilVisible(
        title,
        -200,
        scrollable: find
            .descendant(
              of: find.byKey(const ValueKey('remote-chat-transcript')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();

      expect(find.text('Multiple watchers fired (2)'), findsOneWidget);
      expect(find.textContaining('watcher has fired'), findsNothing);
      expect(
        tester.getSemantics(title),
        matchesSemantics(
          label: 'Multiple watchers fired (2)',
          isButton: true,
          hasTapAction: true,
        ),
      );
      final hit = tester.getRect(title);
      expect(hit.height, greaterThanOrEqualTo(48));
      expect(hit.width, greaterThanOrEqualTo(48));

      final offset = controller.offset;
      final row = tester.getRect(find.byKey(const ValueKey('message-merged')));
      for (final dismiss in ['barrier', 'back']) {
        await tester.tap(title);
        await tester.pumpAndSettle();
        final sheet = find.byKey(const ValueKey('watcher-details-sheet'));
        expect(sheet, findsOneWidget);
        expect(
          [
            for (final index in [0, 1])
              find
                  .descendant(
                    of: find.byKey(ValueKey('watcher-details-entry-$index')),
                    matching: find.byType(Text),
                  )
                  .evaluate()
                  .map((element) => (element.widget as Text).data)
                  .toList(),
          ],
          [
            [
              'Pipeline completion (Deploy) watcher has fired',
              'Canopy watcher fired.\nWorktree pipeline completion: Deploy',
            ],
            [
              'Chat completion: Release notes watcher has fired',
              'Canopy watcher fired.\nChat completion: Release notes',
            ],
          ],
        );
        expect(
          find.byKey(const ValueKey('watcher-details-entry-2')),
          findsNothing,
        );
        if (dismiss == 'barrier') {
          await tester.tapAt(const Offset(195, 20));
        } else {
          await tester.binding.handlePopRoute();
        }
        await tester.pumpAndSettle();
        expect(sheet, findsNothing, reason: dismiss);
        expect(controller.offset, offset, reason: dismiss);
        expect(
          tester.getRect(find.byKey(const ValueKey('message-merged'))),
          row,
          reason: dismiss,
        );
      }
      semantics.dispose();
    });

    testWidgets('rows without a valid marker keep the plain user bubble', (
      tester,
    ) async {
      await pumpFeed(
        tester,
        messages: [
          // An older desktop: watcher-like text, no marker.
          _remoteUserRow(
            'legacy',
            'Canopy watcher fired.\nWorktree pipeline completion: Lint',
          ),
          _remoteUserRow(
            'malformed',
            'Automated, malformed marker',
            watcherFired: {'kind': 3},
          ),
          _remoteUserRow('continue', 'Continue'),
          ..._transcript,
        ],
      );
      for (final id in ['legacy', 'malformed', 'continue', 'u-1']) {
        expect(find.byKey(ValueKey('user-bubble-$id')), findsOneWidget);
        expect(find.byKey(ValueKey('watcher-bubble-$id')), findsNothing);
        expect(
          decorationUnder(
            tester,
            find.byKey(ValueKey('user-bubble-$id')),
          )?.color,
          AppColors.light['bg-quaternary'],
        );
      }
      expect(find.textContaining('watcher has fired'), findsNothing);
      expect(
        find.byWidgetPredicate(
          (widget) => widget is ChatIcon && widget.glyph == ChatGlyph.watcher,
        ),
        findsNothing,
      );
    });

    testWidgets('a marker without a visible notice still shows its title', (
      tester,
    ) async {
      await pumpFeed(
        tester,
        messages: [
          _remoteUserRow(
            'empty',
            '',
            watcherFired: {'kind': 'Pipeline completion (Deploy)'},
          ),
        ],
      );
      expect(
        find.text('Pipeline completion (Deploy) watcher has fired'),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('watcher-bubble-empty')),
        findsOneWidget,
      );
    });

    for (final scale in [2.0, 3.2]) {
      testWidgets('long watcher titles wrap at 390px and ${scale}x text', (
        tester,
      ) async {
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        await pumpFeed(
          tester,
          messages: [
            _remoteUserRow(
              'long',
              'Canopy watcher fired.\n'
                  'Worktree pipeline completion: ${'Very long pipeline ' * 6}',
              watcherFired: {
                'kind': 'Pipeline completion (${'Very long pipeline ' * 6})',
              },
            ),
            mergedRow(),
          ],
        );
        expect(tester.takeException(), isNull);
        final title = find.byKey(const ValueKey('watcher-title-merged'));
        await tester.ensureVisible(title);
        await tester.pumpAndSettle();
        await tester.tap(title);
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('watcher-details-sheet')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });
    }
  });
}
