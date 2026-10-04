# NodeShell

**Privacy-first, self-hosted SSH & server manager.**

NodeShell is an independent project derived from
[Termix](https://github.com/Termix-SSH/Termix). The initial audited baseline is
pinned to upstream commit
`5786eaccbb6134d77a567d4abfb876953730d07a`.

> **Status:** `0.1.0-alpha.2` security-baseline development. This is not yet
> a production release. Do not expose the NodeShell management port directly
> to the public Internet.

## v0.1 scope

- SSH terminal
- SFTP without automatic sudo escalation
- SSH tunnels bound to loopback
- read-only server metrics
- TOTP
- WebAuthn / passkeys

## Security baseline

NodeShell v0.1 deliberately uses a smaller trust boundary than upstream:

- WebUI binds to `127.0.0.1` by default
- browser registration is permanently disabled
- the first Owner is created only through a local operator CLI
- browser password-recovery endpoints are removed
- Owner password recovery is local CLI only
- saved SSH passwords/private keys are usable by the backend but are not
  readable back through browser APIs
- Quick Connect resolves saved credentials only in backend memory
- SSH Host Key verification fails closed and Jump Host key changes are never
  auto-accepted
- legacy SSH algorithms require explicit per-host opt-in
- terminal command history and session persistence are off by default
- stored-password prompt autofill is off by default
- SFTP never receives a sudo password
- tunnel listeners are loopback-only
- server metrics are read-only
- session JWTs are stored only as keyed digests, so the database does not hold
  replayable browser tokens
- TOTP backup codes are stored as salted scrypt hashes
- unsafe browser requests require same-origin CSRF validation
- plugin WebSockets enforce trusted Origin and authentication
- browser database import/export/restore is disabled
- multi-user administration Web routes are not mounted in v0.1
- third-party plugins remain disabled until NodeShell has a reviewed signing
  trust root
- external secret files live outside the application data volume

No passwords, SSH private keys, setup tokens, API keys, or service tokens belong
in this repository.

## First Owner setup

Build NodeShell, create a password file locally on the NodeShell server, and
restrict it to the current operating-system user:

```bash
printf '%s\n' 'replace-with-a-strong-password' > /tmp/nodeshell-owner-password
chmod 600 /tmp/nodeshell-owner-password
npm run admin:create-owner -- --username owner --password-file /tmp/nodeshell-owner-password
rm -f /tmp/nodeshell-owner-password
```

The CLI refuses plaintext `--password` arguments and refuses password files
that are group/world accessible or symbolic links. It only succeeds while the
database has no existing account.

## Local Owner password recovery

Recovery is deliberately unavailable from the browser. On the NodeShell server:

```bash
printf '%s\n' 'replace-with-a-new-strong-password' > /tmp/nodeshell-new-password
chmod 600 /tmp/nodeshell-new-password
npm run admin:reset-password -- --username owner --password-file /tmp/nodeshell-new-password
rm -f /tmp/nodeshell-new-password
```

If an old pre-migration password-wrapped encryption key cannot be recovered,
the CLI refuses destructive recovery unless the operator explicitly adds
`--confirm-data-wipe`.

## Recommended access path

```text
iPhone / iPad / Mac
        |
        v
Cloudflare Access / private VPN
        |
        v
Cloudflare Tunnel / trusted reverse proxy
        |
        v
127.0.0.1:8080
        |
        v
NodeShell
        |
        v
SSH -> managed servers
```

## Development branches

- `security-baseline` — audited Phase 1A baseline plus security fixes that were
  developed in parallel
- `phase1b-final` — final Phase 1B authentication/session/credential
  hardening for `0.1.0-alpha.2`

## Upstream and license

NodeShell contains code derived from Termix, Copyright 2025 Luke Gustafson,
licensed under Apache License 2.0. See [LICENSE](LICENSE) and
[UPSTREAM.md](UPSTREAM.md).

NodeShell is an independent project and is not an official Termix project.
