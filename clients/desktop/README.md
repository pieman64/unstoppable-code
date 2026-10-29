# Unstoppable Code desktop app

This folder is the source for the Unstoppable Code desktop app at one released
version. It builds on its own: you don't need any other part of this repository,
an account, or any credentials.

## What you need

- macOS or Linux
- Node.js 24 and pnpm (the version is pinned in `package.json`)
- A C/C++ compiler and Python for native modules (Xcode command-line tools on macOS)

## Build and test

Run these from this folder (the one with this README):

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck:public
pnpm run build:public
pnpm run test:public
```

`build:public` compiles the app into `out/`.
`test:public` prepares the canonical test brand and rebuilds `node-pty` for the
Node.js test runner. It compiles the native file broker and recycles Jest workers
to bound memory with a 4 GB heap limit per worker; results are saved in `.cache/public-jest-results.json`.
Three private installer configuration tests are explicitly skipped, and hosted
web source audit rows and its registration handler test are omitted. Web font
checks and the mobile label-mirror suite are excluded; the journal audit scans
the exported desktop/package roots. The settings capsule audit scans desktop
and shared sources; the APT copy tests omit only the private publisher config
comparison. Desktop behavior checks remain enabled.
Builds use the Unstoppable Code brand.

To launch the compiled app, run these after testing:

```sh
pnpm run setup:public
pnpm run start:public
```

The install applies the reviewed dependency patches without running lifecycle scripts.
`setup:public` installs Electron,
compiles the native file broker, and rebuilds `node-pty` for Electron. Run it again after `test:public`, which builds
that native module for Node.js instead.

## What to expect

- **Local app:** these commands compile, test, and launch the app. Packaging
  installers isn't supported from this source yet.
- **No hosted services:** the build points at a placeholder local address with
  analytics turned off, so features that need an account or cloud services
  won't work.
- **Some helpers aren't included:** the bundled command-line tool and native
  dictation helper are left out of this source.

## License

See `LICENSE`. Third-party code and assets keep their own licenses, listed in
`THIRD_PARTY_NOTICES.txt`.
