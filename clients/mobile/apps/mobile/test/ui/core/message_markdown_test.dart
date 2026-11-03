import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';

void main() {
  testWidgets('renders code and emphasis with the shared font hierarchy', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: const Scaffold(
          body: MessageMarkdown(
            text:
                'Use **care** and *italics* with `inline_code`.\n```dart\nfinal ready = true;\n```',
          ),
        ),
      ),
    );
    final code = tester.widget<Text>(find.text('final ready = true;'));
    expect(code.style?.fontFamily, 'JetBrainsMono');
    expect(code.style?.fontSize, 13);
    expect(code.style?.fontVariations?.single.value, 400);
    final spans = <TextSpan>[];
    void collect(InlineSpan span) {
      if (span is TextSpan) {
        spans.add(span);
        for (final child in span.children ?? <InlineSpan>[]) {
          collect(child);
        }
      }
    }

    for (final text in tester.widgetList<RichText>(find.byType(RichText))) {
      collect(text.text);
    }
    expect(
      spans
          .firstWhere((span) => span.text == 'care')
          .style
          ?.fontVariations
          ?.single
          .value,
      450,
    );
    expect(
      spans.firstWhere((span) => span.text == 'italics').style?.fontStyle,
      FontStyle.italic,
    );
    expect(
      spans.firstWhere((span) => span.text == 'inline_code').style?.fontFamily,
      'JetBrainsMono',
    );
    expect(tester.takeException(), isNull);
  });

  group('parseMessageMarkdown', () {
    test('image syntax is not parsed as a link', () {
      final block = parseMessageMarkdown('![Preview](./x.png)').single;
      final spans = (block as MessageParagraph).spans;
      expect(spans.map((span) => span.text).join(), 'Preview');
      expect(spans.every((span) => span.linkHref == null), isTrue);
      expect(messageIsPlainText([block]), isFalse);
    });

    test('block and inline images retain source, alt and optional title', () {
      final blocks = parseMessageMarkdown(
        '![Preview](./x.png "Full preview")\n\nBefore ![Inline](./y.png) after ![](./z.png)',
      );
      final image =
          (blocks.first as MessageParagraph).spans.single as MessageImage;
      expect(image.text, 'Preview');
      expect(image.source, './x.png');
      expect(image.title, 'Full preview');
      final inline = (blocks.last as MessageParagraph).spans;
      expect(inline.map((span) => span.text).join(), 'Before Inline after ');
      expect(inline.whereType<MessageImage>().map((image) => image.source), [
        './y.png',
        './z.png',
      ]);
      expect(inline.whereType<MessageImage>().last.text, isEmpty);
    });

    test('table images are nodes in both header and body cells', () {
      final table =
          parseMessageMarkdown(
                '| Theme | ![Before](./before.png "Before") | After |\n'
                '|---|---|---|\n| Light | ![Old](./old.png) | Text ![New](./new.png) |',
              ).single
              as MessageTable;
      expect((table.header[1].single as MessageImage).title, 'Before');
      expect((table.rows.single[1].single as MessageImage).source, './old.png');
      expect(
        table.rows.single[2].whereType<MessageImage>().single.source,
        './new.png',
      );
    });

    test('links containing exclamations stay links and code stays literal', () {
      final spans = parseMessageSpans(
        '[Look!](https://example.com/!) `![Code](./x.png)`',
      );
      expect(spans.whereType<MessageImage>(), isEmpty);
      expect(spans.first.linkHref, 'https://example.com/!');
      expect(spans.first.text, 'Look!');
      expect(spans.last.code, isTrue);
      expect(spans.last.text, '![Code](./x.png)');
    });

    test('malformed image syntax remains literal', () {
      for (final text in [
        '![alt](./x.png',
        '![alt](./x.png "unfinished)',
        '![]( )',
        '![alt]',
      ]) {
        final spans = parseMessageSpans(text);
        expect(spans.whereType<MessageImage>(), isEmpty);
        expect(spans.map((span) => span.text).join(), text);
      }
    });

    test('plain prose stays one plain paragraph (fast path)', () {
      final blocks = parseMessageMarkdown('Just a normal sentence.');
      expect(messageIsPlainText(blocks), isTrue);
    });

    test('snake_case identifiers do not trigger emphasis', () {
      final blocks = parseMessageMarkdown(
        'Renamed remote_chat_screen.dart and set thinking_level.',
      );
      expect(messageIsPlainText(blocks), isTrue);
    });

    test('fenced code blocks parse, including unclosed streaming fences', () {
      final blocks = parseMessageMarkdown(
        'Before\n```dart\nfinal x = 1;\n```\nAfter',
      );
      expect(blocks, hasLength(3));
      final code = blocks[1];
      code as MessageCodeBlock;
      expect(code.code, 'final x = 1;');
      expect(code.language, 'dart');

      final streaming = parseMessageMarkdown('```\npartial output');
      final open = streaming.single;
      open as MessageCodeBlock;
      expect(open.code, 'partial output');
    });

    test('long fences preserve shorter fences and language-bearing lines', () {
      final blocks = parseMessageMarkdown(
        '````text\na\n```\nb\n````dart\nc\n`````\nAfter',
      );
      expect(blocks, hasLength(2));
      final code = blocks.first as MessageCodeBlock;
      expect(code.language, 'text');
      expect(code.code, 'a\n```\nb\n````dart\nc');
      expect(blocks.last, isA<MessageParagraph>());
    });

    test('headings, bullets, numbered lists, and quotes parse', () {
      final blocks = parseMessageMarkdown(
        '## Plan\n- first\n- second\n1. one\n> note',
      );
      expect(blocks, hasLength(5));
      expect((blocks[0] as MessageHeading).level, 2);
      expect((blocks[1] as MessageListItem).marker, '•');
      expect((blocks[3] as MessageListItem).marker, '1.');
      expect(blocks[4], isA<MessageQuote>());
    });

    test('inline code, bold, italic, and links parse in one line', () {
      final spans = parseMessageSpans(
        'Run `npm test` with **care** and *speed* via [docs](https://a.io)',
      );
      expect(spans.firstWhere((s) => s.code).text, 'npm test');
      expect(spans.firstWhere((s) => s.bold).text, 'care');
      expect(spans.firstWhere((s) => s.italic).text, 'speed');
      final link = spans.firstWhere((s) => s.linkHref != null);
      expect(link.text, 'docs');
      expect(link.linkNavigable, isTrue);
    });

    test('a GFM table parses into header, alignments, and rows', () {
      final blocks = parseMessageMarkdown(
        'Tally:\n'
        '| Shape | Result | Count |\n'
        '|:--|:-:|--:|\n'
        '| 2 questions, `free-form` | Arrived as **Additional** | 1 |\n'
        '| 3 questions, dismissed | Discarded | 2 |\n'
        '\n'
        'After the table.',
      );
      expect(blocks, hasLength(3));
      expect(blocks[0], isA<MessageParagraph>());
      final table = blocks[1];
      table as MessageTable;
      expect(table.header.map((c) => c.single.text), [
        'Shape',
        'Result',
        'Count',
      ]);
      expect(table.alignments, [
        TextAlign.left,
        TextAlign.center,
        TextAlign.right,
      ]);
      expect(table.rows, hasLength(2));
      // Inline markdown still applies inside cells.
      expect(table.rows[0][0].firstWhere((s) => s.code).text, 'free-form');
      expect(table.rows[0][1].firstWhere((s) => s.bold).text, 'Additional');
      expect(table.rows[1][2].single.text, '2');
      expect(blocks[2], isA<MessageParagraph>());
    });

    test('table rows are normalized to the header cell count', () {
      final table =
          parseMessageMarkdown(
                '| a | b |\n|---|---|\n| only |\n| x | y | extra |',
              ).single
              as MessageTable;
      expect(table.rows, hasLength(2));
      expect(table.rows[0], hasLength(2));
      expect(table.rows[0][1], isEmpty);
      expect(table.rows[1], hasLength(2));
      expect(table.rows[1][1].single.text, 'y');
    });

    test(
      'tables accept pipes without leading/trailing bars and escaped pipes',
      () {
        final table =
            parseMessageMarkdown('a | b\n--- | ---\n`x \\| y` | z').single
                as MessageTable;
        expect(table.header.map((c) => c.single.text), ['a', 'b']);
        expect(table.rows.single[0].single.text, 'x | y');
        expect(table.rows.single[1].single.text, 'z');
      },
    );

    test('a pipe line without a delimiter row stays a paragraph', () {
      // A streaming message cut after the header, or prose that merely
      // contains pipes, must not become a half table.
      final blocks = parseMessageMarkdown('| Shape | Result |');
      expect(blocks.single, isA<MessageParagraph>());
      final prose = parseMessageMarkdown('use a | b for alternation');
      expect(messageIsPlainText(prose), isTrue);
    });

    test('the transcript link policy keeps unsafe targets inert', () {
      MessageSpan linkFor(String href) =>
          parseMessageSpans('[x]($href)').firstWhere((s) => s.linkHref != null);
      expect(linkFor('https://example.com/pr/1').linkNavigable, isTrue);
      expect(linkFor('http://example.com/pr/1').linkNavigable, isTrue);
      expect(linkFor('mailto:team@example.com').linkNavigable, isTrue);
      // Filesystem paths and exotic schemes must never become tappable.
      expect(linkFor('lib/ui/core/theme.dart').linkNavigable, isFalse);
      expect(linkFor('file:///etc/passwd').linkNavigable, isFalse);
      expect(linkFor('javascript:alert(1)').linkNavigable, isFalse);
    });
  });

  group('MessageMarkdown widget', () {
    Widget host(String text) => MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(body: MessageMarkdown(text: text)),
    );

    testWidgets('plain messages render as a single plain Text', (tester) async {
      await tester.pumpWidget(host('Deploy finished cleanly.'));
      await tester.pump();
      // find.text (non-rich) only matches a plain Text — the fast path that
      // keeps existing transcript assertions working.
      expect(find.text('Deploy finished cleanly.'), findsOneWidget);
    });

    testWidgets('markdown messages render structure', (tester) async {
      await tester.pumpWidget(
        host('## Result\nAll `42` tests **passed**\n```\nnpm test\n```'),
      );
      await tester.pump();
      expect(find.textContaining('Result', findRichText: true), findsWidgets);
      expect(find.text('npm test'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('recognizers keep their identity across a same-text rebuild', (
      tester,
    ) async {
      // Regression: recognizers used to be disposed/recreated in build(), so
      // a tap whose pointer-down straddled a streaming rebuild was silently
      // swallowed. Identity across unrelated rebuilds is the fix's contract.
      TapGestureRecognizer? recognizerOf(WidgetTester tester) {
        final richText = tester.widget<Text>(find.byType(Text).first);
        TapGestureRecognizer? found;
        (richText.textSpan as TextSpan?)?.visitChildren((span) {
          if (span is TextSpan && span.recognizer is TapGestureRecognizer) {
            found = span.recognizer as TapGestureRecognizer?;
            return false;
          }
          return true;
        });
        return found;
      }

      late StateSetter rebuild;
      var pad = 0.0;
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                rebuild = setState;
                return Padding(
                  padding: EdgeInsets.all(pad),
                  child: const MessageMarkdown(
                    text: 'see [site](https://example.com)',
                  ),
                );
              },
            ),
          ),
        ),
      );
      await tester.pump();
      final before = recognizerOf(tester);
      expect(before, isNotNull);

      // Unrelated ancestor rebuild — the text is unchanged.
      rebuild(() => pad = 1);
      await tester.pump();
      final after = recognizerOf(tester);
      expect(identical(before, after), isTrue);
    });

    test('a pathological unmatched-bracket line parses in bounded time', () {
      // Regression: the unbounded label scan backtracked quadratically —
      // 6,000 chars (the wire cap) took ~0.5s PER PARSE. The bounded scans
      // keep it linear; the generous budget only catches a regression back
      // to unbounded quantifiers.
      final pathological = '[' * 6000;
      final stopwatch = Stopwatch()..start();
      final blocks = parseMessageMarkdown(pathological);
      stopwatch.stop();
      expect(blocks, isNotEmpty);
      expect(stopwatch.elapsedMilliseconds, lessThan(250));
    });

    test('pathological tables cannot expand beyond the cell budget', () {
      final header = List.generate(8, (index) => 'column$index').join(' | ');
      final delimiter = List.filled(8, '---').join(' | ');
      final rows = List.generate(100, (index) => '| row$index |').join('\n');

      final blocks = parseMessageMarkdown('$header\n$delimiter\n$rows');
      final table = blocks.whereType<MessageTable>().single;

      expect(table.header.length * table.rows.length, lessThanOrEqualTo(512));
      expect(table.rows.length, lessThan(100));
      expect(blocks.whereType<MessageParagraph>(), isNotEmpty);
    });

    test(
      'a wire-sized wide table falls back to plain text in bounded time',
      () {
        // 5,999 characters: a 1,000-column header and delimiter followed by
        // 1,000 minimal rows. Without the column guard this expands to one
        // million parsed cells before the renderer even builds widgets.
        final header = List.filled(1000, 'h').join('|');
        final delimiter = List.filled(1000, '-').join('|');
        final rows = List.filled(1000, '|').join('\n');
        final stopwatch = Stopwatch()..start();
        final blocks = parseMessageMarkdown('$header\n$delimiter\n$rows');
        stopwatch.stop();

        expect(blocks.whereType<MessageTable>(), isEmpty);
        expect(messageIsPlainText(blocks), isTrue);
        expect(stopwatch.elapsedMilliseconds, lessThan(250));
      },
    );

    group('tables', () {
      // The test font renders every glyph 14px wide, so a real phone column
      // (390) keeps the longest words of a wrapped two-column table in range.
      const column = 390.0;
      Widget phone(String text) => MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: column,
              child: MessageMarkdown(text: text),
            ),
          ),
        ),
      );
      RichText cell(WidgetTester tester, String containing) =>
          tester.widget<RichText>(
            find.textContaining(containing, findRichText: true).first,
          );

      testWidgets('render as a Table with an emphasised header row', (
        tester,
      ) async {
        await tester.pumpWidget(
          phone('| Shape | Result |\n|---|---|\n| one | two |'),
        );
        await tester.pump();
        expect(find.byType(MessageTableGrid), findsOneWidget);
        expect(
          cell(tester, 'Shape').text.style?.fontVariations?.single.value,
          450,
        );
        expect(
          cell(tester, 'two').text.style?.fontVariations?.single.value,
          isNot(450),
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('long cells wrap so a two-column table fits the column', (
        tester,
      ) async {
        await tester.pumpWidget(
          phone(
            '| Shape | Result |\n'
            '|---|---|\n'
            '| 2 questions, free-form on one | Free-form arrived as "Additional", no option |\n'
            '| 1 question, ~100-char labels | Returned verbatim, no truncation |',
          ),
        );
        await tester.pump();
        expect(tester.getSize(find.byType(MessageTableGrid)).width, column);
        expect(tester.takeException(), isNull);
      });

      testWidgets('columns shrink in proportion to their content, like HTML', (
        tester,
      ) async {
        // Flutter's Table shrinks flexible columns by equal pixel amounts,
        // which pins a short column at one word per line while a long column
        // keeps slack. The CSS auto algorithm shares the deficit in
        // proportion to content instead. In the 14px-per-glyph test font the
        // short column's min width is 86; Flutter's Table leaves it there,
        // while the CSS algorithm lands it around 137.
        await tester.pumpWidget(
          phone(
            '| a | b |\n'
            '|---|---|\n'
            '| one two three four five | alpha beta gamma delta epsilon zeta eta theta iota kappa |',
          ),
        );
        await tester.pump();
        final shortCell = find
            .ancestor(
              of: find.textContaining('one two', findRichText: true),
              matching: find.byType(Padding),
            )
            .first;
        expect(tester.getSize(shortCell).width, greaterThan(110));
        expect(tester.getSize(find.byType(MessageTableGrid)).width, column);
      });

      testWidgets('an unbreakably wide table scrolls horizontally in place', (
        tester,
      ) async {
        await tester.pumpWidget(
          phone(
            '| a | b | c | d |\n'
            '|---|---|---|---|\n'
            '| 0123456789abcdef0123456789 | 0123456789abcdef0123456789 | 0123456789abcdef0123456789 | 0123456789abcdef0123456789 |',
          ),
        );
        await tester.pump();
        final scroller = find.byWidgetPredicate(
          (w) =>
              w is SingleChildScrollView &&
              w.scrollDirection == Axis.horizontal,
        );
        expect(scroller, findsOneWidget);
        expect(
          tester.getSize(find.byType(MessageTableGrid)).width,
          greaterThan(column),
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('a selectable table still scrolls horizontally on Android', (
        tester,
      ) async {
        debugDefaultTargetPlatformOverride = TargetPlatform.android;
        try {
          await tester.pumpWidget(
            MaterialApp(
              theme: AppTheme.light,
              home: const Scaffold(
                body: Align(
                  alignment: Alignment.topLeft,
                  child: SizedBox(
                    width: column,
                    child: MessageMarkdown(
                      selectable: true,
                      text:
                          '| a | b | c | d |\n'
                          '|---|---|---|---|\n'
                          '| 0123456789abcdef0123456789 | 0123456789abcdef0123456789 | 0123456789abcdef0123456789 | 0123456789abcdef0123456789 |',
                    ),
                  ),
                ),
              ),
            ),
          );
          await tester.pump();

          final scroller = find.byWidgetPredicate(
            (w) =>
                w is SingleChildScrollView &&
                w.scrollDirection == Axis.horizontal,
          );
          final position = tester
              .state<ScrollableState>(
                find.descendant(
                  of: scroller,
                  matching: find.byWidgetPredicate(
                    (w) =>
                        w is Scrollable &&
                        w.physics is! NeverScrollableScrollPhysics,
                  ),
                ),
              )
              .position;
          expect(position.pixels, 0);

          final cell = find
              .textContaining('0123456789abcdef', findRichText: true)
              .first;
          final gesture = await tester.startGesture(tester.getCenter(cell));
          await gesture.moveBy(const Offset(-20, 0));
          await tester.pump();
          await gesture.moveBy(const Offset(-180, 0));
          await gesture.up();
          await tester.pumpAndSettle();

          expect(position.pixels, greaterThan(0));
          expect(tester.takeException(), isNull);
        } finally {
          debugDefaultTargetPlatformOverride = null;
        }
      });

      testWidgets('a scrolling table keeps short cells on one line', (
        tester,
      ) async {
        // Once the table must scroll anyway, wrapping "0.4 ms" into two
        // lines helps nothing; cells keep their natural width (capped at the
        // column width so a prose cell cannot become one endless line).
        await tester.pumpWidget(
          phone(
            '| a | b | c |\n'
            '|---|---|---|\n'
            '| 0123456789abcdef0123456789 | 0123456789abcdef0123456789 | 0.4 ms |',
          ),
        );
        await tester.pump();
        expect(
          tester.getSize(find.byType(MessageTableGrid)).width,
          greaterThan(column),
        );
        final oneLine = tester.getSize(
          find.textContaining('0123', findRichText: true).first,
        );
        final short = tester.getSize(
          find.textContaining('0.4 ms', findRichText: true),
        );
        expect(short.height, oneLine.height);
      });

      testWidgets('delimiter alignment is applied to cell text', (
        tester,
      ) async {
        await tester.pumpWidget(phone('| n | v |\n|--:|:-:|\n| 1 | mid |'));
        await tester.pump();
        expect(cell(tester, '1').textAlign, TextAlign.right);
        expect(cell(tester, 'mid').textAlign, TextAlign.center);
      });
    });

    testWidgets('navigable links get a tap recognizer, paths stay inert', (
      tester,
    ) async {
      await tester.pumpWidget(
        host('[site](https://example.com) and [file](lib/a.dart)'),
      );
      await tester.pump();

      final richText = tester.widget<Text>(find.byType(Text).first);
      final spans = <TextSpan>[];
      (richText.textSpan as TextSpan?)?.visitChildren((span) {
        if (span is TextSpan) spans.add(span);
        return true;
      });
      final site = spans.firstWhere((s) => s.text == 'site');
      final file = spans.firstWhere((s) => s.text == 'file');
      expect(site.recognizer, isA<TapGestureRecognizer>());
      expect(file.recognizer, isNull);
      expect(file.style?.decorationStyle, TextDecorationStyle.dotted);
    });
  });

  group('Markdown images', () {
    late Uint8List imageBytes;
    setUpAll(() async {
      final recorder = ui.PictureRecorder();
      Canvas(recorder).drawColor(const Color(0xff336699), BlendMode.src);
      final picture = recorder.endRecording();
      final image = await picture.toImage(600, 300);
      imageBytes = (await image.toByteData(
        format: ui.ImageByteFormat.png,
      ))!.buffer.asUint8List();
      image.dispose();
      picture.dispose();
    });

    Widget phone({
      String text = '![Preview](./x.png)',
      MessageImageResolver? resolver,
      MessageImageTap? onTap,
      bool selectable = false,
    }) => MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: 390,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: MessageMarkdown(
                text: text,
                imageResolver: resolver,
                onImageTap: onTap,
                selectable: selectable,
              ),
            ),
          ),
        ),
      ),
    );

    Future<void> decode(WidgetTester tester) async {
      await tester.runAsync(() async {
        await precacheImage(
          MemoryImage(imageBytes),
          tester.element(find.byType(MessageMarkdown)),
        );
      });
      await tester.pumpAndSettle();
    }

    testWidgets('no resolver renders inert alt text for every source', (
      tester,
    ) async {
      await tester.pumpWidget(
        phone(
          text:
              '![Local](./x.png) ![Remote](https://example.invalid/x.png) ![File](file:///x.png)',
          selectable: true,
        ),
      );
      final text = tester.widget<SelectableText>(find.byType(SelectableText));
      expect(text.textSpan!.toPlainText(), 'Local Remote File');
      expect(find.byType(Image), findsNothing);
      expect(find.byType(GestureDetector), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('empty-alt images stay visible without a resolver', (
      tester,
    ) async {
      for (final selectable in [false, true]) {
        for (final entry in {
          '![](./x.png)': 'Image',
          'See ![](./shot.png)': 'See Image',
          '| Preview |\n|---|\n| ![](./x.png) |': 'Image',
        }.entries) {
          await tester.pumpWidget(
            phone(text: entry.key, selectable: selectable),
          );
          expect(
            find.text(entry.value, findRichText: true),
            findsWidgets,
            reason: entry.key,
          );
          expect(find.byType(Image), findsNothing);
          expect(tester.takeException(), isNull);
        }
      }
    });

    testWidgets(
      'pending resolver reserves space then shows a delayed skeleton',
      (tester) async {
        final pending = Completer<Uint8List>();
        await tester.pumpWidget(phone(resolver: (_) => pending.future));
        expect(find.textContaining('Loading image'), findsNothing);
        final placeholder = find.bySemanticsLabel('Preview');
        final reserved = tester.getSize(placeholder);
        expect(reserved.width, greaterThan(0));
        expect(reserved.height, greaterThan(0));
        expect(
          find.descendant(
            of: find.byType(MessageMarkdown),
            matching: find.byType(FadeTransition),
          ),
          findsNothing,
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 199));
        expect(
          find.descendant(
            of: find.byType(MessageMarkdown),
            matching: find.byType(FadeTransition),
          ),
          findsNothing,
        );
        await tester.pump(const Duration(milliseconds: 2));
        expect(
          find.descendant(
            of: find.byType(MessageMarkdown),
            matching: find.byType(FadeTransition),
          ),
          findsOneWidget,
        );
        expect(tester.getSize(placeholder), reserved);
        expect(find.byType(Image), findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump(const Duration(seconds: 1));
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('image decoding keeps the resolver loading phase', (
      tester,
    ) async {
      final pending = Completer<Uint8List>();
      await tester.pumpWidget(phone(resolver: (_) => pending.future));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 201));
      final placeholder = find.bySemanticsLabel('Preview');
      final reserved = tester.getSize(placeholder);
      pending.complete(imageBytes);
      await tester.pump();
      await tester.pump();
      expect(find.byType(Image), findsOneWidget);
      expect(find.textContaining('Loading image'), findsNothing);
      // The real codec is still pending in the test's fake async zone.
      expect(find.byType(RawImage), findsNothing);
      expect(tester.getSize(placeholder), reserved);
      expect(
        find.descendant(
          of: find.byType(MessageMarkdown),
          matching: find.byType(FadeTransition),
        ),
        findsOneWidget,
      );
      await decode(tester);
      expect(tester.widget<RawImage>(find.byType(RawImage)).image, isNotNull);
      expect(tester.takeException(), isNull);
    });

    testWidgets('reduced motion keeps the delayed skeleton still', (
      tester,
    ) async {
      final pending = Completer<Uint8List>();
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: MessageMarkdown(
              text: '![Preview](./x.png)',
              imageResolver: (_) => pending.future,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 201));
      final pulse = find.descendant(
        of: find.byType(MessageMarkdown),
        matching: find.byType(FadeTransition),
      );
      final opacity = tester.widget<FadeTransition>(pulse).opacity.value;
      await tester.pump(const Duration(seconds: 1));
      expect(tester.widget<FadeTransition>(pulse).opacity.value, opacity);
      expect(tester.binding.hasScheduledFrame, isFalse);
      await tester.pumpWidget(const SizedBox.shrink());
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'loaded image fits column, preserves aspect and opens with its bytes',
      (tester) async {
        String? tappedSource;
        Uint8List? tappedBytes;
        await tester.pumpWidget(
          phone(
            resolver: (_) async => imageBytes,
            onTap: (source, bytes) {
              tappedSource = source;
              tappedBytes = bytes;
            },
          ),
        );
        await decode(tester);
        expect(find.byType(Image), findsOneWidget);
        final size = tester.getSize(find.byType(RawImage));
        expect(size.width, 358);
        expect(size.width / size.height, closeTo(2, 0.01));
        expect(find.bySemanticsLabel('Open Preview'), findsOneWidget);
        await tester.tap(find.byType(RawImage));
        expect(tappedSource, './x.png');
        expect(tappedBytes, same(imageBytes));
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('screen readers open a loaded image once with its bytes', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      final opened = <(String, Uint8List)>[];
      await tester.pumpWidget(
        phone(
          resolver: (_) async => imageBytes,
          onTap: (source, bytes) => opened.add((source, bytes)),
        ),
      );
      await decode(tester);

      tester.semantics.tap(find.semantics.byLabel('Open Preview'));
      await tester.pump();
      expect(opened, hasLength(1));
      expect(opened.single.$1, './x.png');
      expect(opened.single.$2, same(imageBytes));

      await tester.tap(find.byType(RawImage));
      expect(opened, hasLength(2));
      semantics.dispose();
      expect(tester.takeException(), isNull);
    });

    testWidgets('images that cannot open expose no tap action', (tester) async {
      final semantics = tester.ensureSemantics();
      var opened = false;
      void open(String _, Uint8List _) => opened = true;
      final tapAction = find.semantics.byAction(ui.SemanticsAction.tap);

      await tester.pumpWidget(phone(resolver: (_) async => imageBytes));
      await decode(tester);
      expect(find.byType(RawImage), findsOneWidget);
      expect(tapAction, findsNothing, reason: 'no callback');

      final pending = Completer<Uint8List>();
      await tester.pumpWidget(
        phone(resolver: (_) => pending.future, onTap: open),
      );
      await tester.pump(const Duration(milliseconds: 201));
      expect(tapAction, findsNothing, reason: 'loading');
      // Uncached bytes keep the real codec pending in fake async.
      pending.complete(Uint8List.fromList(imageBytes));
      await tester.pump();
      await tester.pump();
      expect(find.byType(RawImage), findsNothing);
      expect(tapAction, findsNothing, reason: 'decoding');

      await tester.pumpWidget(
        phone(
          resolver: (_) => Future.error(MessageImageFailure.notFound),
          onTap: open,
        ),
      );
      await tester.pumpAndSettle();
      expect(tapAction, findsNothing, reason: 'failed read');

      await tester.pumpWidget(
        phone(
          resolver: (_) async => Uint8List.fromList([1, 2, 3]),
          onTap: open,
        ),
      );
      await tester.runAsync(() async => tester.pump());
      await tester.pumpAndSettle();
      expect(find.text('Preview · Unsupported image'), findsOneWidget);
      expect(tapAction, findsNothing, reason: 'unsupported bytes');
      expect(opened, isFalse);
      semantics.dispose();
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'failure reasons are short and arbitrary exceptions stay private',
      (tester) async {
        for (final failure in MessageImageFailure.values) {
          await tester.pumpWidget(
            phone(resolver: (_) => Future.error(failure)),
          );
          await tester.pumpAndSettle();
          expect(find.text('Preview · ${failure.label}'), findsOneWidget);
        }
        await tester.pumpWidget(
          phone(resolver: (_) => throw StateError('secret/path?token=private')),
        );
        await tester.pumpAndSettle();
        expect(find.text("Preview · Couldn't load image"), findsOneWidget);
        expect(find.textContaining('secret'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('invalid image bytes show a reason and cannot be opened', (
      tester,
    ) async {
      var opened = false;
      await tester.pumpWidget(
        phone(
          resolver: (_) async => Uint8List.fromList([1, 2, 3]),
          onTap: (_, _) => opened = true,
        ),
      );
      await tester.runAsync(() async {
        // Let the real image codec report its failure.
        await tester.pump();
      });
      await tester.pumpAndSettle();
      expect(find.text('Preview · Unsupported image'), findsOneWidget);
      await tester.tap(find.text('Preview · Unsupported image'));
      expect(opened, isFalse);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'same resolver is reused on rebuild and source changes resolve afresh',
      (tester) async {
        final sources = <String>[];
        Future<Uint8List> resolve(String source) async {
          sources.add(source);
          return imageBytes;
        }

        await tester.pumpWidget(phone(resolver: resolve));
        await decode(tester);
        await tester.pumpWidget(phone(resolver: resolve));
        await tester.pumpAndSettle();
        expect(sources, ['./x.png']);
        await tester.pumpWidget(
          phone(text: '![Other](./other.png)', resolver: resolve),
        );
        await decode(tester);
        expect(sources, ['./x.png', './other.png']);
        expect(tester.widget<Image>(find.byType(Image)).semanticLabel, 'Other');
      },
    );

    testWidgets(
      'changing resolver hides old bytes and ignores stale completions',
      (tester) async {
        final stale = Completer<Uint8List>();
        final current = Completer<Uint8List>();
        await tester.pumpWidget(phone(resolver: (_) => stale.future));
        await tester.pumpWidget(phone(resolver: (_) => current.future));
        stale.complete(imageBytes);
        await tester.pump();
        expect(find.byType(Image), findsNothing);
        current.complete(imageBytes);
        await decode(tester);
        expect(find.byType(Image), findsOneWidget);
        final next = Completer<Uint8List>();
        await tester.pumpWidget(phone(resolver: (_) => next.future));
        await tester.pump();
        expect(find.byType(Image), findsNothing);
        expect(find.textContaining('Loading image'), findsNothing);
        await tester.pumpWidget(phone());
        next.complete(imageBytes);
        await tester.pumpAndSettle();
        expect(find.byType(Image), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'Theme Before After report thumbnails fit 390pt and remain tappable',
      (tester) async {
        var taps = 0;
        await tester.pumpWidget(
          phone(
            text:
                '| Theme | Before | After |\n|---|---|---|\n'
                '| Light | ![Before](./before.png) | ![After](./after.png "After") |',
            resolver: (_) async => imageBytes,
            onTap: (_, _) => taps++,
          ),
        );
        await decode(tester);
        expect(find.byType(Image), findsNWidgets(2));
        expect(tester.getSize(find.byType(MessageTableGrid)).width, 358);
        for (final image in find.byType(RawImage).evaluate()) {
          final finder = find.byWidget(image.widget);
          final size = tester.getSize(finder);
          expect(size.width, lessThanOrEqualTo(96));
          expect(size.height, lessThanOrEqualTo(96));
          expect(size.width / size.height, closeTo(2, 0.01));
          await tester.tap(finder);
        }
        expect(taps, 2);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('selectable prose supports inline images', (tester) async {
      await tester.pumpWidget(
        phone(
          text: 'Before ![Preview](./x.png) after',
          resolver: (_) async => imageBytes,
          selectable: true,
        ),
      );
      await decode(tester);
      expect(find.byType(Image), findsOneWidget);
      expect(find.textContaining('Before', findRichText: true), findsWidgets);
      expect(find.textContaining('after', findRichText: true), findsWidgets);
      expect(tester.takeException(), isNull);
    });
  });
}
