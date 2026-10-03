# NodeShell

**Privacy-first, self-hosted SSH & server manager.**

NodeShell is an independent project derived from
[Termix](https://github.com/Termix-SSH/Termix). The initial security
baseline is pinned to upstream commit
`5786eaccbb6134d77a567d4abfb876953730d07a`.

> **Status:** early security-baseline development. Do not expose this
> build directly to the public Internet.

## v0.1 scope

- SSH terminal
- SFTP without automatic sudo escalation
- SSH tunnels bound to loopback
- read-only server metrics
- TOTP
- WebAuthn / passkeys

Stored SSH credentials are intended to be usable by the backend
without being readable back through the browser.

## Upstream and license

NodeShell contains code derived from Termix, Copyright 2025 Luke
Gustafson, licensed under Apache License 2.0. See [LICENSE](LICENSE)
and [UPSTREAM.md](UPSTREAM.md).
