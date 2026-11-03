# Unstoppable Code mobile app

This folder is the source for the Unstoppable Code iOS and Android app at one
released version. It builds on its own: you don't need any other part of this
repository, an account, or any credentials.

## What you need

- [Flutter](https://docs.flutter.dev/get-started/install) 3.44.4 (stable
  channel), which includes the matching Dart SDK
- Node.js 24, to check the generated API bindings
- For Android: Java 17 and the Android SDK
- For iOS: a Mac with Xcode, plus [Rust](https://rustup.rs). The first iOS build
  compiles a Rust dependency and needs network access.

## Build and test

Run these from this folder (the one with this README):

```sh
# Check that the generated API bindings match their published digests
node scripts/public-export/check-mobile-protocol.mjs --check

cd apps/mobile
flutter pub get --enforce-lockfile
flutter analyze
flutter test

# Android debug build
flutter build apk --debug

# iOS simulator build (macOS only)
flutter build ios --simulator --no-codesign
```

To try the app, start an emulator or simulator and run `flutter run` from
`apps/mobile`.

## What to expect

- **Sample data:** without an API address the app uses built-in sample data, so
  you can explore it without an account or network service.
- **No analytics or crash reporting:** Firebase stays off unless you add your
  own `google-services.json` or `GoogleService-Info.plist`.
- **Not for distribution:** these are debug and simulator builds. Release
  signing, store uploads, and our app identifiers aren't included, so use your
  own if you publish a fork.

## License

See `LICENSE`. Third-party code keeps its own license, including the vendored
`speech_to_text` package in `apps/mobile/third_party/`.
