# Native browser-profile clear fixture

Run `run.mjs` through the repository's normal E2E guard. The fixture uses its
own temporary Electron user-data root, loopback servers and synthetic data.
`PROFILE_CLEAR_ELECTRON` optionally selects the CI-downloaded, lockfile-pinned
Electron executable; local runs resolve the installed Electron package.

The `localhost-test` certificate and private key are public test fixtures, not
credentials. They authenticate only this probe's local HTTPS server. The isolated
Electron process maps the three reserved `.test` hosts to loopback. Its synthetic
Session accepts only this exact certificate and those hostnames. No global TLS
verification override is used. Certificate comparison normalizes only PEM line
endings so Windows CRLF checkouts remain equivalent to Electron's LF certificate.
The product partition test always supplies CRLF to cover this on macOS too.
The fixture never contacts a real account/site.

Native capability evidence does not establish product authorization, crash
recovery or UI behavior. The workflow in the planning package is a template;
Windows success must be recorded from an actual run.

`windows-ownership-diagnostic.mjs` records bounded PowerShell process-enumeration
attempts on Windows when the test supervisor cannot establish an owned process
identity. It retains errors/timings and never bypasses the supervisor gate.
