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

Set the HTTPS URL users will actually open. WebAuthn/passkeys use this as the
fixed Origin and RP-ID security boundary:

```bash
export NODESHELL_PUBLIC_URL="https://ssh.example.com"
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

A password file can be used for non-interactive administration:

```bash
docker exec -it nodeshell nodeshell admin create-owner \
  --username admin \
  --password-file /path/inside/container/owner-password
```

Password files must be regular, non-symlink files and inaccessible to
group/others (mode `0600` or stricter).

## Local Owner password recovery

Recovery is deliberately unavailable from the browser. Use the local container
command:

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

- `security-baseline` — CI-green finalized Phase 1B baseline
- `phase1b-hardening` — final operator-channel, secret-handoff and WebAuthn
  hardening candidate for `0.1.0-alpha.2`

## Upstream and license

NodeShell contains code derived from Termix, Copyright 2025 Luke Gustafson,
licensed under Apache License 2.0. See [LICENSE](LICENSE) and
[UPSTREAM.md](UPSTREAM.md).

NodeShell is an independent project and is not an official Termix project.
