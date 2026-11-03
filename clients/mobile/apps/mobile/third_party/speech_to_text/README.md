# speech_to_text (vendored)

This directory is [`speech_to_text`](https://pub.dev/packages/speech_to_text)
7.4.0 from pub.dev, with Canopy patches for Android dictation. The upstream license is in
`LICENSE`. Only `lib/`, `android/`, `darwin/`, `LICENSE`, and `pubspec.yaml`
are kept; the stray `android/gradle/local.properties` with the publisher's
host paths was removed.

## Android patch (CAN-3718)

`android/src/main/kotlin/com/csdcorp/speech_to_text/SpeechToTextPlugin.kt`,
`updateResults`, marked `Canopy patch`:

- Partial results append `android.speech.extra.UNSTABLE_TEXT` to each
  alternate. Google's recognizer (Speech Services by Google) puts only the
  stable words in `RESULTS_RECOGNITION` and the rest of the phrase in that
  key. Without it, a partial can drop to `""` while the user is speaking.
- A segment end (`final_result` partial bundle) or final result without
  results is sent with empty words. Upstream drops it, so Dart never sees the
  boundary and makes its own final from the last result after
  `finalTimeout`.
- `resultSent`, which selects `done` or `doneNoResult`, still changes only for
  bundles with results.

`VoiceDictationController` relies on both changes. It treats empty words on a
segment end or final as a boundary that adds no text.

`lib/speech_to_text.dart`, `_onNotifyStatus`, also waits for a final result
after an intermediate result when `stop` has started. An empty segment boundary
can arrive before `stop`; the platform's early `done` or `doneNoResult` must
not discard late final words. The final timeout completes a stopped session if
no final result arrives. Without `stop`, `doneNoResult` still ends a failed
recognition task, including on iOS.

## Upgrading

1. Check if upstream now handles `UNSTABLE_TEXT`, empty boundary bundles, and
   delayed final results after an intermediate result.
   If it does, remove this directory and depend on the pub.dev release.
2. Otherwise copy the new release over this directory, keep the files listed
   above, and apply the `Canopy patch` changes again.
3. Verify dictation on an Android device or emulator with Speech Services by
   Google: stop in the middle of a phrase, pause between two phrases, and stop
   after a pause. Each phrase must appear once.
