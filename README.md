# NodeShell

**Privacy-first, self-hosted SSH & server manager.**

NodeShell is an independent project derived from
[Termix](https://github.com/Termix-SSH/Termix). The initial audited baseline is
pinned to upstream commit
`5786eaccbb6134d77a567d4abfb876953730d07a`.

> **Status:** `0.1.0-alpha.2` security-baseline development. This branch is
> not yet a production release. Do not expose the NodeShell management port
> directly to the public Internet.

## v0.1 scope

- SSH terminal
- SFTP without automatic sudo escalation
- SSH tunnels bound to loopback
- read-only server metrics
- TOTP
- WebAuthn / passkeys

## Security baseline

NodeShell v0.1 deliberately uses a smaller trust boundary than upstream:

- the WebUI binds to `127.0.0.1` by default
- public browser registration is disabled
- the first Owner is created through a local operator CLI
- browser password-recovery endpoints are disabled
- stored SSH passwords/private keys are **usable by the backend, not readable
  back through the browser**
- Quick Connect resolves saved credentials in backend memory
- SSH Host Key verification is fail-closed; Jump Host key changes are never
  auto-accepted
- legacy SSH algorithms require explicit opt-in
- command history and stored-password prompt autofill are off by default
- SFTP never receives a sudo password
- tunnels listen on loopback only
- server metrics are read-only
- session tokens are stored only as keyed digests, not replayable JWTs
- TOTP backup codes are stored as one-way hashes
- state-changing browser requests are protected by same-origin CSRF checks
- browser database/credential plaintext exports are disabled
- multi-user administration Web routes are not mounted in v0.1
- third-party plugins are disabled until a reviewed signing trust root exists

External secret files are expected to live outside the application data volume.
No passwords, SSH private keys or service tokens belong in this repository.

## First secure initialization

NodeShell does not expose browser registration or browser password recovery.

1. Create root-only host secrets:

   ```bash
   sudo install -d -m 700 /etc/nodeshell/secrets
   for name in jwt_secret database_key encryption_key internal_auth_token; do
     openssl rand -hex 32 | sudo tee "/etc/nodeshell/secrets/$name" >/dev/null
     sudo chown root:root "/etc/nodeshell/secrets/$name"
     sudo chmod 600 "/etc/nodeshell/secrets/$name"
   done
   ```

2. Set the HTTPS URL users will actually open. WebAuthn/passkeys use this as
   the fixed Origin and RP-ID security boundary:

   ```bash
   export NODESHELL_PUBLIC_URL="https://ssh.example.com"
   ```

3. Start NodeShell. The management port remains loopback-only:

   ```bash
   docker compose -f docker/docker-compose.yml up -d
   ```

4. Create the first Owner from inside the container. The password is prompted
   on the TTY and is never accepted as a command-line argument:

   ```bash
   docker exec -it nodeshell nodeshell admin create-owner --username admin
   ```

   Check initialization state at any time:

   ```bash
   docker exec -it nodeshell nodeshell admin status
   ```

For local password recovery:

```bash
docker exec -it nodeshell nodeshell admin reset-password --username admin
```

For current v3 system-wrapped data keys, this preserves encrypted user data.
A legacy password-wrapped key fails closed. NodeShell will not erase data unless
the operator deliberately repeats the command with `--confirm-data-wipe`.

## Development branches

- `security-baseline` — audited Phase 1A baseline
- `phase1b-security` — authentication/session/credential hardening for
  `0.1.0-alpha.2`

## Upstream and license

NodeShell contains code derived from Termix, Copyright 2025 Luke Gustafson,
licensed under Apache License 2.0. See [LICENSE](LICENSE) and
[UPSTREAM.md](UPSTREAM.md).

NodeShell is an independent project and is not an official Termix project.
