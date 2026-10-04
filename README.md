# NodeShell

**Privacy-first, self-hosted SSH & server manager.**

NodeShell is an independent project derived from
[Termix](https://github.com/Termix-SSH/Termix). The initial audited baseline is
pinned to upstream commit
`5786eaccbb6134d77a567d4abfb876953730d07a`.

> **Status:** early `0.1.0-alpha` development. Do not expose the NodeShell
> management port directly to the public Internet.

## v0.1 scope

NodeShell v0.1 intentionally stays small:

- saved VPS / host management
- SSH terminal
- encrypted Credential Vault
- SFTP with the remote SSH account's normal permissions, never automatic sudo
- SSH **Local Forward** bound to `127.0.0.1`
- single Owner account and session security

The following upstream features are intentionally **not part of v0.1**:
Quick Connect, server metrics, TOTP, WebAuthn/passkeys, Remote Forward,
dynamic/SOCKS tunnels, client tunnel presets, tunnel auto-start, session
sharing/recording, telemetry, Docker/server administration, and third-party
plugins.

The normal workflow is deliberately simple:

```text
Add host -> choose saved credential -> SSH / Files / Local Forward
```

## Security baseline

NodeShell v0.1 deliberately uses a smaller trust boundary than upstream:

- WebUI binds to `127.0.0.1` by default
- browser registration is permanently disabled
- the first Owner is created only through a local operator CLI
- browser password recovery is removed; Owner recovery is local CLI only
- saved SSH passwords/private keys are usable by the backend but are not
  readable back through browser APIs
- Quick Connect is removed; a host must be saved before it can be connected
- SSH Host Key verification fails closed and Jump Host key changes are never
  auto-accepted
- legacy SSH algorithms require explicit compatibility opt-in
- terminal command history and session persistence are off by default
- SFTP never receives a sudo password
- Local Forward listeners are forced to loopback
- session JWTs are stored only as keyed digests, so the database does not hold
  replayable browser tokens
- unsafe browser requests require same-origin CSRF validation
- plugin WebSockets enforce trusted Origin and authentication
- browser database import/export/restore is disabled
- multi-user administration Web routes are not mounted in v0.1
- third-party plugins remain disabled until NodeShell has a reviewed signing
  trust root
- external secret files live outside the application data volume

No passwords, SSH private keys, setup tokens, API keys, or service tokens belong
in this repository.

## First secure initialization

NodeShell does not expose browser registration or browser password recovery.

Create the four installation secrets on the NodeShell server. They remain
`root:root` and mode `0600` on the host:

```bash
sudo install -d -m 700 /etc/nodeshell/secrets
for name in jwt_secret database_key encryption_key internal_auth_token; do
  openssl rand -hex 32 | sudo tee "/etc/nodeshell/secrets/$name" >/dev/null
  sudo chown root:root "/etc/nodeshell/secrets/$name"
  sudo chmod 600 "/etc/nodeshell/secrets/$name"
done
```

Start NodeShell:

```bash
docker compose -f docker/docker-compose.yml up -d
```

The management port remains bound to `127.0.0.1:8080`.

Create the first Owner from inside the running container. The password is
prompted with terminal echo disabled and is never accepted as a plaintext
command-line argument:

```bash
docker exec -it nodeshell nodeshell admin create-owner --username admin
```

Check initialization state:

```bash
docker exec -it nodeshell nodeshell admin status
```

A password file can be used for non-interactive administration. Password files
must be regular, non-symlink files and inaccessible to group/others (mode
`0600` or stricter).

## Local Owner password recovery

Recovery is deliberately unavailable from the browser:

```bash
docker exec -it nodeshell nodeshell admin reset-password --username admin
```

For current v3 system-wrapped data keys, this preserves encrypted user data.
A legacy password-wrapped key fails closed. NodeShell will not erase encrypted
user data unless the operator deliberately repeats the command with
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

- `security-baseline` — audited security baseline
- `phase1b-hardening` — hardened Owner/admin and secret handling
- `v0.1-slim` — reduced first-release feature surface

## Upstream and license

NodeShell contains code derived from Termix, Copyright 2025 Luke Gustafson,
licensed under Apache License 2.0. See [LICENSE](LICENSE) and
[UPSTREAM.md](UPSTREAM.md).

NodeShell is an independent project and is not an official Termix project.
