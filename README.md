# Unstoppable Code

This repository has the source code for the Unstoppable Code desktop and mobile
apps. We publish it with each release so you can read, audit, and build the
clients yourself.

## What's here

- `clients/desktop/`: the desktop app for macOS and Windows
- `clients/mobile/`: the iOS and Android app

Each folder is a snapshot of a released version. Tags named
`source-desktop/<version>` and `source-mobile/<version>` mark each release. The
two apps ship on their own schedules, so their folders can be at different
versions.

## Building

Each client builds on its own from a clone of this repository. Follow the README
in [`clients/desktop`](clients/desktop/README.md) or
[`clients/mobile`](clients/mobile/README.md) for what to install and which
commands to run.

Hosted services aren't included. Builds from this source aren't connected to
them, so features that need an account or cloud services won't work.

## Contributing

We don't accept pull requests here, but issues are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to report bugs, share ideas, and
report security issues.

## License

The first-party client source is licensed under the MIT License. See [LICENSE](LICENSE).
Third-party code and assets retain their own licenses and restrictions; see each
client's `THIRD_PARTY_NOTICES.txt` and accompanying license files.
