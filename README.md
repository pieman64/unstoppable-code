<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
    <img src=".github/assets/logo-light.svg" alt="Unstoppable Code" width="320">
  </picture>
</p>

<h1 align="center">Unstoppable Code</h1>

<p align="center">
  Run Claude, Codex, and local models side by side on your own projects.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20iOS%20%7C%20Android-lightgrey" alt="Platforms: macOS, Windows, iOS, and Android">
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/hero-dark.png">
  <img src=".github/assets/hero-light.png" alt="The Unstoppable Code desktop app with an agent chat open and three projects in the sidebar">
</picture>

## What it is

Unstoppable Code is an app for working with AI coding agents, available for
[desktop](https://unstoppable.ai/download),
[iOS](https://apps.apple.com/us/app/unstoppable-ai/id6786961568), and
[Android](https://unstoppable.ai/download). Bring your own agents: sign in to
Claude or Codex, run a local model, or use AI credits from your account.

## Download

| Platform              | Download                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon) | [Download for Apple Silicon](https://unstoppable.ai/download/started?platform=macArm64&source=github) |
| macOS (Intel)         | [Download for Intel](https://unstoppable.ai/download/started?platform=macIntel&source=github)         |
| Windows (x64)         | [Download for Windows](https://unstoppable.ai/download/started?platform=windowsX64&source=github)     |

- **Phone or tablet:** get the app on the
  [App Store](https://apps.apple.com/us/app/unstoppable-ai/id6786961568), or
  find the Google Play link on the [download page](https://unstoppable.ai/download).
- **Every option** is on [unstoppable.ai/download](https://unstoppable.ai/download).
- **Linux** isn't available yet.
- **Not sure which Mac you have?** See
  [Install the desktop app](https://unstoppable.ai/support/getting-started/install-the-app).

> [!NOTE]
> Agents need a model to run. Connect Claude, Codex, or a local model, or turn
> on free daily AI credits in your account. See
> [Connect Claude, Codex, or a local model](https://unstoppable.ai/support/agents-and-models/connect-claude-codex-or-a-local-model).

## Why is the source here?

We publish client source under the MIT License with every release and as
development snapshots from main, so you can read it, audit it, build it, and
fork it. Snapshots can be synced manually or daily. They may be stale when
syncs are disabled, delayed, or failed.

This repository holds the desktop and mobile apps only. Our hosted services,
like accounts and cloud features, stay closed source. See each client's build
instructions for service configuration. We don't take pull requests here: we
build every fix ourselves, so a clear issue is the best way to help.

## Documentation

The [help centre](https://unstoppable.ai/support) covers the app in depth. New
here? Start with
[How Unstoppable Code works](https://unstoppable.ai/support/getting-started/how-unstoppable-code-works).

- [Getting started](https://unstoppable.ai/support/getting-started)
- [Agents and models](https://unstoppable.ai/support/agents-and-models)
- [Accounts and billing](https://unstoppable.ai/support/accounts-and-billing)
- [Work without code](https://unstoppable.ai/support/work-without-code)
- [Troubleshooting](https://unstoppable.ai/support/troubleshooting)

## What's in this repository

- [`clients/desktop/`](clients/desktop/README.md): the desktop app for macOS and Windows
- [`clients/mobile/`](clients/mobile/README.md): the iOS and Android app

Each folder holds its latest exported source, which may be a development
snapshot rather than a release. Snapshots are ordinary commits without a tag
or GitHub release. Tags named `source-desktop/<version>` and
`source-mobile/<version>` identify releases. The two folders update independently
and can represent different revisions. Mobile source may appear before its first
release tag.

## Building from source

Each client builds on its own from a clone of this repository. Follow the README
in [`clients/desktop`](clients/desktop/README.md) or
[`clients/mobile`](clients/mobile/README.md) for what to install and which
commands to run.

Desktop builds use stable hosted service defaults. Mobile connectivity depends
on generated brand configuration and build settings. Follow each client's README
for configuration; a successful build alone does not verify sign-in or cloud
features.

## Getting help

- **Questions and how-to:** search the [help centre](https://unstoppable.ai/support)
  or [contact support](https://unstoppable.ai/support/troubleshooting/contact-support).
- **Bugs and ideas:** [open an issue](https://github.com/unstoppable-si/unstoppable-code/issues/new/choose).
  See [CONTRIBUTING.md](CONTRIBUTING.md) for what helps us most.
- **Security issues:** don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

The first-party client source is licensed under the MIT License. See [LICENSE](LICENSE).
Third-party code and assets retain their own licenses and restrictions; see each
client's `THIRD_PARTY_NOTICES.txt` and accompanying license files.
