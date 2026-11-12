# Unstoppable Code desktop app

This folder is the source for the Unstoppable Code desktop app at one exported
revision, either a release or a development snapshot from main. Releases have a
`source-desktop/vX.Y.Z` tag; snapshots have no tag. The `version` field in
`package.json` doesn't track app releases. It builds on its own: you don't need
any other part of this repository, an account, or any
credentials.

Just want the app? [Download it](https://unstoppable.ai/download) instead.

## Before you start

A build from this source is for reading, auditing, and changing the app. It
differs from the app you download:

- **No installers:** the commands below compile and launch the app from this
  folder. Packaging installers isn't supported from this source yet.
- **Hosted services:** the build is configured for the same sign-in, cloud,
  and feature-flag services as the released app. It sends the same PostHog
  analytics events, without session replays, and the unpackaged app doesn't
  check for updates. To turn analytics off, set `CANOPY_POSTHOG_ENABLED` to
  `false` before `build:public`. To build without hosted services, set
  `CANOPY_CLOUD_BASE_URL` and `CANOPY_UPDATE_BASE_URL` to a
  local address such as `http://127.0.0.1:1` and set
  `LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID` to an empty value before
  `build:public`. Features that need an account or cloud services won't work
  in that build.
- **Some helpers aren't included:** the bundled command-line tool and the
  native dictation helper are left out of this source.
- **CI platforms:** our CI builds and launches this source on macOS and Ubuntu
  24.04. Windows source builds are experimental; see the Windows instructions
  below.

## Requirements

On every platform:

- Node.js 24
- pnpm, at the version pinned in `package.json`. Run `corepack enable pnpm`
  once to use it.

On macOS, install the Xcode command-line tools for the native modules:

```sh
xcode-select --install
```

On Linux, install a C/C++ toolchain and Python 3 for the native modules. On
Ubuntu, that's `sudo apt-get install build-essential python3`. Ubuntu 24.04 is
the version our CI uses.

## Build on Windows

Windows source builds are experimental and have been verified on Windows 11
with Visual Studio Build Tools 2022. Install the **Desktop development with
C++** workload, an x64 MSVC toolset, a Windows 10 or 11 SDK, and the
**Spectre-mitigated libraries** for the MSVC toolset. The Spectre libraries are
needed to build `node-pty`.

Use Node.js 24.22.1 and the pnpm version pinned in this folder's
`package.json` (12.11.2 in this source snapshot). Open **Developer PowerShell
for VS 2022** or **x64 Native Tools Command Prompt for VS 2022** so MSVC and the
Windows SDK are available in the build environment. Then run these commands
from `clients/desktop`:

```powershell
node --version
corepack enable pnpm
pnpm --version
pnpm install --frozen-lockfile --ignore-scripts
$env:CANOPY_ELECTRON_VITE_MAX_OLD_SPACE_SIZE = '8192'
pnpm run build:public
pnpm run setup:public
pnpm run start:public
```

The version commands should report Node.js `v24.22.1` and pnpm `12.11.2`.
`build:public` compiles the app into `out/`; `setup:public` prepares Electron
and rebuilds native modules for it; `start:public` launches the unpackaged app.
Keep the build heap at 8192 MB: a 4096 MB override ran out of V8 heap during
the Windows build.

This produces a runnable development build, not an installer. The public source
export omits the core daemon (`unstoppable-coded.exe`) and release packaging
helpers, so daemon-dependent file and folder operations may not work in this
build. Code Integrity or Smart App Control can also block unsigned native
modules in an unpackaged build; check the Windows Code Integrity log for the
blocked module if a native feature fails. Do not disable those protections to
build or run the app.

## Run the app

Run these from this folder (the one with this README):

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:public
pnpm run setup:public
pnpm run start:public
```

- The install applies the reviewed dependency patches without running
  lifecycle scripts.
- `build:public` compiles the app into `out/`.
- `setup:public` installs Electron, compiles the native file broker, and
  rebuilds `node-pty` for Electron.
- `start:public` launches the compiled app with the Unstoppable Code brand.
  Arguments after it go to Electron.

## Build and test everything

Run these in this order:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck:public
pnpm run build:public
pnpm run test:public
pnpm run setup:public
pnpm run start:public
```

On an Apple Silicon Mac, `typecheck:public` takes about a minute and a half
and `build:public` about two and a half minutes. `test:public` runs the whole
unit suite and takes much longer.

Our CI runs every step except `test:public` on this source. The same desktop
unit tests run in our main repository's CI before a release.

## What the public test suite covers

`test:public` runs the desktop unit tests that build from this source. Tests
that need private configuration or hosted services are left out; the full list
is in [`PUBLIC_BUILD_SCOPE.json`](PUBLIC_BUILD_SCOPE.json).

## What's in this folder

- `apps/desktop-app/`: the Electron app, with its main process, preload
  scripts, and renderer
- `packages/`: shared code the app is built from, like the UI components, app
  state, and runtime
- `brands/`: the app's name, icons, and logos
- `patches/`: the reviewed dependency patches the install applies
- `scripts/public-build/`: the scripts behind the `*:public` commands
- `PUBLIC_BUILD_SCOPE.json`: what this export includes, leaves out, and tests

## Troubleshooting

- **The app fails to start with a `NODE_MODULE_VERSION` error.** `test:public`
  rebuilds `node-pty` for Node.js. Run `pnpm run setup:public` again, then
  `pnpm run start:public`.
- **Tests run out of memory.** Each Jest worker has a 4 GB heap limit, and two
  workers run at once. Close other apps and run `pnpm run test:public` again.
  Results are saved in `.cache/public-jest-results.json`.

## Reporting issues

See [CONTRIBUTING.md](../../CONTRIBUTING.md). Please say that you built from
source and which public commit or `source-desktop/*` tag you used.

## License

See `LICENSE`. Third-party code and assets keep their own licenses, listed in
`THIRD_PARTY_NOTICES.txt`.
