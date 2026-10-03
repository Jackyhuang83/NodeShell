#!/usr/bin/env python3
# NodeShell Phase 1A security-baseline patcher.
# Audited upstream commit:
# 5786eaccbb6134d77a567d4abfb876953730d07a

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

EXPECTED_UPSTREAM = "5786eaccbb6134d77a567d4abfb876953730d07a"

CORE_PLUGINS = [
    "file-manager",
    "host-metrics",
    "ssh-terminal",
    "totp",
    "tunnels",
    "webauthn",
]

COMPOSE = '''services:
  nodeshell:
    image: ghcr.io/jackyhuang83/nodeshell:latest
    container_name: nodeshell
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - nodeshell-data:/app/data
      - /etc/nodeshell/secrets:/run/secrets/nodeshell:ro
    environment:
      PORT: "8080"

      # Temporary upstream-compatible variable names.
      # Secrets are intentionally outside /app/data.
      TERMIX_REQUIRE_EXTERNAL_SECRETS: "true"
      JWT_SECRET_FILE: "/run/secrets/nodeshell/jwt_secret"
      DATABASE_KEY_FILE: "/run/secrets/nodeshell/database_key"
      ENCRYPTION_KEY_FILE: "/run/secrets/nodeshell/encryption_key"
      INTERNAL_AUTH_TOKEN_FILE: "/run/secrets/nodeshell/internal_auth_token"

volumes:
  nodeshell-data:
    driver: local
'''


def die(message: str) -> None:
    raise SystemExit(f"[NodeShell Phase 1A] {message}")


def read(root: Path, rel: str) -> str:
    path = root / rel
    if not path.exists():
        die(f"missing expected file: {rel}")
    return path.read_text(encoding="utf-8")


def write(root: Path, rel: str, content: str) -> None:
    (root / rel).write_text(content, encoding="utf-8")


def replace_exact(root: Path, rel: str, old: str, new: str, expected_count: int = 1) -> None:
    content = read(root, rel)
    count = content.count(old)
    if count != expected_count:
        die(f"{rel}: expected {expected_count} patch anchor(s), found {count}")
    write(root, rel, content.replace(old, new, expected_count))


def check_upstream(root: Path, force: bool) -> None:
    try:
        head = subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        if force:
            return
        die("not a Git checkout; use --force only after manual review")

    if head != EXPECTED_UPSTREAM and not force:
        die(
            f"unexpected upstream commit {head}; expected {EXPECTED_UPSTREAM}. "
            "Refusing to patch unverified source."
        )


def patch_bundled_plugins(root: Path) -> None:
    payload = {
        "plugins": [{"id": plugin_id, "source": "workspace"} for plugin_id in CORE_PLUGINS]
    }
    write(root, "docker/bundled-plugins.json", json.dumps(payload, indent=2) + "\n")


def patch_compose(root: Path) -> None:
    write(root, "docker/docker-compose.yml", COMPOSE)


def patch_host_key_verifier(root: Path) -> None:
    rel = "src/backend/hosts/host-key-verifier.ts"
    content = read(root, rel)

    if 'import crypto from "node:crypto";' not in content:
        content = content.replace(
            'import { pluginEvents, TOPICS } from "../plugins/events.js";',
            'import crypto from "node:crypto";\n'
            'import { pluginEvents, TOPICS } from "../plugins/events.js";',
            1,
        )

    content = content.replace(
        'const fingerprint = hostkey.toString("hex");',
        'const fingerprint = `SHA256:${crypto.createHash("sha256")'
        '.update(hostkey).digest("base64").replace(/=+$/, "")}`;',
        1,
    )

    quick_pattern = re.compile(
        r'          if \(!hostId\) \{\n[\s\S]*?            verify\(true\);\n            return;\n          \}\n'
    )
    quick_replacement = '''          if (!hostId) {
            if (!ws) {
              sshLogger.warn(
                "Quick Connect rejected: no WebSocket available for host key verification",
                {
                  operation: "host_key_no_ws_reject",
                  ip,
                  port,
                  fingerprint,
                  keyType,
                  userId,
                },
              );
              verify(false);
              return;
            }

            const accepted = await this.promptUserForNewKey(
              ws,
              ip,
              port,
              undefined,
              fingerprint,
              keyType,
              algorithm,
            );

            sshLogger.warn("Quick Connect used one-time host key verification", {
              operation: accepted
                ? "host_key_ephemeral_accept"
                : "host_key_ephemeral_reject",
              ip,
              port,
              fingerprint,
              keyType,
              userId,
            });
            verify(accepted);
            return;
          }
'''
    content, count = quick_pattern.subn(quick_replacement, content, count=1)
    if count != 1:
        die(f"{rel}: quick-connect host-key block did not match")

    host_missing_pattern = re.compile(
        r'(          if \(!host\) \{[\s\S]*?operation: "host_key_no_host"[\s\S]*?)verify\(true\);'
    )
    content, count = host_missing_pattern.subn(r"\1verify(false);", content, count=1)
    if count != 1:
        die(f"{rel}: host-not-found fail-open block did not match")

    content, count = re.subn(
        r'\n            if \(isJumpHost\) \{[\s\S]*?Jump host key auto-accepted and stored[\s\S]*?verify\(true\);\n              return;\n            \}\n',
        "\n",
        content,
        count=1,
    )
    if count != 1:
        die(f"{rel}: jump-host first-use auto-accept block did not match")

    content, count = re.subn(
        r'(No WebSocket available for host key verification prompt[\s\S]*?)verify\(true\);',
        r"\1verify(false);",
        content,
        count=1,
    )
    if count != 1:
        die(f"{rel}: new-key no-WebSocket fail-open block did not match")

    content, count = re.subn(
        r'\n          if \(isJumpHost\) \{[\s\S]*?Jump host key changed - auto-accepted[\s\S]*?verify\(true\);\n            return;\n          \}\n',
        "\n",
        content,
        count=1,
    )
    if count != 1:
        die(f"{rel}: jump-host changed-key auto-accept block did not match")

    content = content.replace(
        "    isJumpHost: boolean = false,",
        "    _isJumpHost: boolean = false,",
        1,
    )

    write(root, rel, content)


def patch_cors(root: Path) -> None:
    rel = "src/backend/utils/cors-config.ts"
    content = '''import cors from "cors";
import type { Request, Response, NextFunction } from "express";
import { getRequestOrigin } from "./request-origin.js";

const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function getAllowedOrigins(): string[] {
  const envOrigins =
    process.env.NODESHELL_ALLOWED_ORIGINS ?? process.env.CORS_ALLOWED_ORIGINS;
  if (!envOrigins) return [];
  return envOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isCorsOriginAllowed(
  req: Request,
  origin: string | undefined,
): boolean {
  if (!origin) return true;

  if (
    process.env.NODE_ENV === "development" &&
    DEV_ORIGINS.includes(origin)
  ) {
    return true;
  }

  if (origin === getRequestOrigin(req)) return true;

  const configured = getAllowedOrigins();
  return configured.includes(origin);
}

export function createCorsMiddleware(
  methods: string[] = ["GET", "POST", "PUT"²È="24É°ôÁ±Õ¥¹Ì½ÍÍ µÑÉµ¥¹°½µ¹¥ÍÐ¹©Í½¸(½¹Ñ¹ÐôÉ¡É½½Ð°É°¤(ÁÑÑÉ¸ôÉ¹½µÁ¥±¡È ­äè¹±½µµ¹!¥ÍÑ½ÉämqÍqMuìÀ°ÌÀÁôüÕ±Ðè¥ÑÉÕ¤(½¹Ñ¹Ð°½Õ¹ÐôÁÑÑÉ¸¹ÍÕ¸¡ÈpÅ±Í°½¹Ñ¹Ð°½Õ¹ÐôÄ¤(¥½Õ¹ÐôÄè(¥¡íÉ±ôè½µµ¹µ¡¥ÍÑ½ÉäÕ±Ð¹¡½È¥¹½ÐµÑ ¤(ÝÉ¥Ñ¡É½½Ð°É°°½¹Ñ¹Ð¤(()ÁÑ¡}ÕÍÉ}Á±Õ¥¹Ì¡É½½ÐèAÑ ¤´ø9½¹è(ÉÁ±}áÐ (É½½Ð°(ÍÉ½­¹½Á±Õ¥¹Ì½ÑÉÕÍÐ¹ÑÌ°(¼¨¨QI5%a}IEU%I}M%9}A1U%9LõÑÉÕ±½­ÌÕ¹Í¥¹ÕÍÈÁ±Õ¥¹Ì¸¨¼)áÁ½ÉÐÕ¹Ñ¥½¸ÉÅÕ¥ÉM¥¹A±Õ¥¹Ì ¤è½½±¸ì(ÉÑÕÉ¸ÁÉ½ÍÌ¹¹Ø¹QI5%a}IEU%I}M%9}A1U%9LôôôÑÉÕì)ô°(¼¨¨(¨9½M¡±°ØÀ¸ÄÉÅÕ¥ÉÌÍ¥¹ÑÕÉÌ½ÈÙÉäÕÍÈÁ±Õ¥¸¸(¨QIUMQ}A1U%9}-eL¥Ì¥¹Ñ¹Ñ¥½¹±±äµÁÑäÕÉ¥¹A¡ÍÅ°Í¼ÕÍÈ(¨Á±Õ¥¹ÌÉµ¥¸¥Í±Õ¹Ñ¥°9½M¡±°Í¡¥ÁÌÁ¥¹¹Í¥¹¥¹­ä¸(¨¼)áÁ½ÉÐÕ¹Ñ¥½¸ÉÅÕ¥ÉM¥¹A±Õ¥¹Ì ¤è½½±¸ì(ÉÑÕÉ¸ÑÉÕì)ô°(¤(()ÁÑ¡}¥±}µ¹É}¹½}ÍÕ¼¡É½½ÐèAÑ ¤´ø9½¹è(É°ôÁ±Õ¥¹Ì½¥±µµ¹È½ÍÉ½­¹½¥¹à¹ÑÌ(ÉÁ±}áÐ (É½½Ð°(É°°(ÍÕ½AÍÍÝ½ÉèÉÍ½±Ù!½ÍÐ¹ÍÕ½AÍÍÝ½ÉÌÍÑÉ¥¹ðÕ¹¥¹°°(ÍÕ½AÍÍÝ½ÉèÕ¹¥¹°°(¤(ÉÁ±}áÐ (É½½Ð°(É°°(ÍÕ½AÍÍÝ½ÉèÉÍ½±ÙÉ¹Ñ¥±Ì¹ÍÕ½AÍÍÝ½É°°(ÍÕ½AÍÍÝ½ÉèÕ¹¥¹°°(¤(()ÁÑ¡}µÑÉ¥Í}É}½¹±ä¡É½½ÐèAÑ ¤´ø9½¹è(É°ôÁ±Õ¥¹Ì½¡½ÍÐµµÑÉ¥Ì½ÍÉ½­¹½É½ÕÑÌ¹ÑÌ(½¹Ñ¹ÐôÉ¡É½½Ð°É°¤((½È±¥¹¥¸ (¥µÁ½ÉÐìÉ¥ÍÑÉ5¹ÉI½ÕÑÌôÉ½´¸½µ¹ÉÌ½¥¹à¹©Ìíq¸°(¥µÁ½ÉÐìÍÍ¹¥ÉÉ½ÈôÉ½´¸½µ¹ÉÌ½É½ÕÑµ¡±ÁÉÌ¹©Ìíq¸°(¥µÁ½ÉÐìÍÕ½AÍÍÝ½É=ôÉ½´¸½¡±ÁÉÌ¹©Ìíq¸°(¤è(¥±¥¹¹½Ð¥¸½¹Ñ¹Ðè(¥¡íÉ±ôèµ¥ÍÍ¥¹áÁÑ¥µÁ½ÉÐí±¥¹¹ÍÑÉ¥À ¥ô¤(½¹Ñ¹Ðô½¹Ñ¹Ð¹ÉÁ±¡±¥¹°°Ä¤((µÉ­Èôq¸É¥ÍÑÉ5¹ÉI½ÕÑÌ¡É½ÕÑÈ°ì(ÍÑÉÐô½¹Ñ¹Ð¹É¥¹¡µÉ­È¤(¥ÍÑÉÐôô´Äè(¥¡íÉ±ôèµ¹ÈµÉ½ÕÑ±½¬¹½Ð½Õ¹¤((¥¹±}±½Íô½¹Ñ¹Ð¹É¥¹ q¹ô¤(¥¥¹±}±½ÍðôÍÑÉÐè(¥¡íÉ±ôè½Õ±¹½Ð±½ÑÉ¥ÍÑÉI½ÕÑÌ±½Í¥¹É¤((½¹Ñ¹Ðô½¹Ñ¹ÑléÍÑÉÑt¬½¹Ñ¹Ñm¥¹±}±½Íét(ÝÉ¥Ñ¡É½½Ð°É°°½¹Ñ¹Ð¤(()ÁÑ¡}ÍÍ¡}±½É¥Ñ¡µÌ¡É½½ÐèAÑ ¤´ø9½¹è(ÉÁ±}áÐ (É½½Ð°(ÍÉ½­¹½¡½ÍÑÌ½½¹¹Ð½Õ¥±µ½¹¹Ðµ½¹¥¹ÑÌ°(±½É¥Ñ¡µÌèÕ¥±MM!±½É¥Ñ¡µÌ¡ÍÍ¡=ÁÑ¥½¹Ìü¹±±½Ý1å±½É¥Ñ¡µÌôô±Í¤°°(±½É¥Ñ¡µÌèÕ¥±MM!±½É¥Ñ¡µÌ¡ÍÍ¡=ÁÑ¥½¹Ìü¹±±½Ý1å±½É¥Ñ¡µÌôôôÑÉÕ¤°°(¤((É°ôÍÉ½­¹½ÕÑ¥±Ì½ÍÍ µ±½É¥Ñ¡µÌ¹ÑÌ(½¹Ñ¹ÐôÉ¡É½½Ð°É°¤(½È±¥¹¥¸ (ÌÈÔØµ±q¸°(ÌÄäÈµ±q¸°(ÌÄÈàµ±q¸°(¤è(¥½¹Ñ¹Ð¹½Õ¹Ð¡±¥¹¤ôÄè(¥¡íÉ±ôèáÁÑ½¹	¹ÑÉäèí±¥¹¹ÍÑÉ¥À ¥ô¤(½¹Ñ¹Ðô½¹Ñ¹Ð¹ÉÁ±¡±¥¹°°Ä¤(ÝÉ¥Ñ¡É½½Ð°É°°½¹Ñ¹Ð¤(()ÁÑ¡}¡½ÍÑ}ÍÉÑ}Á¥Ì¡É½½ÐèAÑ ¤´ø9½¹è(É°ôÍÉ½­¹½ÑÍ½É½ÕÑÌ½¡½ÍÐ¹ÑÌ(½¹Ñ¹ÐôÉ¡É½½Ð°É°¤((¹¡½Èô½¹ÍÐÉ½ÕÑÈôáÁÉÍÌ¹I½ÕÑÈ ¤ì)É½ÕÑÈ¹ÕÍ¡É©ÑM¡É½Áå]É¥ÑÌ ¡½ÍÐ°½yqp½qp½¡½ÍÑqp¼¡qq¬¤¼¤¤ì((ÕÉô½¹ÍÐÉ½ÕÑÈôáÁÉÍÌ¹I½ÕÑÈ ¤ì)É½ÕÑÈ¹ÕÍ¡É©ÑM¡É½Áå]É¥ÑÌ ¡½ÍÐ°½yqp½qp½¡½ÍÑqp¼¡qq¬¤¼¤¤ì((¼¼MÑ½ÉÉ¹Ñ¥±ÌÉÕÍ±äÑ¡­¹°¹½ÐÉ±äÑ¡É½ÝÍÈ¸)É½ÕÑÈ¹ÕÍ ¡ÉÄ°ÉÌ°¹áÐ¤ôøì(½¹ÍÐ±½­MÉÑIô(ÉÄ¹µÑ¡½ôôôP( (½yqp½qp½¡½ÍÑqp½qq­qp½ÁÍÍÝ½É¼¹ÑÍÐ¡ÉÄ¹ÁÑ ¤ñð(½yqp½qp½¡½ÍÑqp½qq­qp½áÁ½ÉÐ¼¹ÑÍÐ¡ÉÄ¹ÁÑ ¤ñð(ÉÄ¹ÁÑ ôôô½½¡½ÍÑÌ½áÁ½ÉÐ(¤ì((¥¡±½­MÉÑI¤ì(ÉÑÕÉ¸ÉÌ¹ÍÑÑÕÌ ÐÀÐ¤¹©Í½¸¡ìÉÉ½Èè9½Ð½Õ¹ô¤ì(ô((¹áÐ ¤ì)ô¤ì((¥½¹Ñ¹Ð¹½Õ¹Ð¡¹¡½È¤ôÄè(¥¡íÉ±ôèÉ½ÕÑÈÍÕÉ¥ÑäµÕÉ¹¡½È¥¹½ÐµÑ ¤(½¹Ñ¹Ðô½¹Ñ¹Ð¹ÉÁ±¡¹¡½È°ÕÉ°Ä¤((ÅÕ¥­}¹¡½ÈôÑÉäì(±ÐÉÍ½±ÙAÍÍÝ½ÉôÁÍÍÝ½Éì(ÅÕ¥­}ÕÉô¥¡ÕÑ¡QåÁôôôÉ¹Ñ¥°¤ì(ÉÑÕÉ¸ÉÌ¹ÍÑÑÕÌ ÐÀÀ¤¹©Í½¸¡ì(ÉÉ½Èè(MÙÉ¹Ñ¥±ÌÉÑµÁ½ÉÉ¥±ä¥Í±¥¸EÕ¥¬½¹¹Ð¸UÍÍÙ!½ÍÐ½È¹ÑÈ¸Á¡µÉ°É¹Ñ¥°½ÈÑ¡¥ÌÍÍÍ¥½¸¸°(ô¤ì(ô((ÑÉäì(±ÐÉÍ½±ÙAÍÍÝ½ÉôÁÍÍÝ½Éì(¥½¹Ñ¹Ð¹½Õ¹Ð¡ÅÕ¥­}¹¡½È¤ôÄè(¥¡íÉ±ôèEÕ¥¬½¹¹ÐÁÑ ¹¡½È¥¹½ÐµÑ ¤(½¹Ñ¹Ðô½¹Ñ¹Ð¹ÉÁ±¡ÅÕ¥­}¹¡½È°ÅÕ¥­}ÕÉ°Ä¤((ÝÉ¥Ñ¡É½½Ð°É°°½¹Ñ¹Ð¤(()ÁÑ¡}É¹Ñ¥±}Ñ¥°¡É½½ÐèAÑ ¤´ø9½¹è(É°ôÍÉ½­¹½ÑÍ½É½ÕÑÌ½É¹Ñ¥±Ì¹ÑÌ(½¹Ñ¹ÐôÉ¡É½½Ð°É°¤((½¹Ñ¹Ðô½¹Ñ¹Ð¹ÉÁ± (ÍÉ¥ÁÑ¥½¸èIÑÉ¥ÙÌÍÁ¥¥É¹Ñ¥°ä¥ÑÌ%°¥¹±Õ¥¹ÍÉÑÌ¸°(ÍÉ¥ÁÑ¥½¸èIÑÉ¥ÙÌÉ¹Ñ¥°µÑÑ¸MÑ½ÉÍÉÑÌÉ¹ÙÈÉÑÕÉ¹¸°(Ä°(¤((½±ô¥¡É¹Ñ¥°¹ÁÍÍÝ½É¤ì(½ÕÑÁÕÐ¹ÁÍÍÝ½ÉôÉ¹Ñ¥°¹ÁÍÍÝ½Éì(ô(½ÕÑÁÕÐ¹¡Í-äôÉ¹Ñ¥°¹­äì(½ÕÑÁÕÐ¹¡Í-åAÍÍÝ½ÉôÉ¹Ñ¥°¹­åAÍÍÝ½Éì(¥¡É¹Ñ¥°¹ÁÕ±¥-ä¤ì(½ÕÑÁÕÐ¹ÁÕ±¥-äôÉ¹Ñ¥°¹ÁÕ±¥-äì(ô(¥¡É¹Ñ¥°¹ÉÑAÕ±¥-ä¤ì(½ÕÑÁÕÐ¹ÉÑAÕ±¥-äôÉ¹Ñ¥°¹ÉÑAÕ±¥-äì(ô(¥¡É¹Ñ¥°¹­åAÍÍÝ½É¤ì(½ÕÑÁÕÐ¹­åAÍÍÝ½ÉôÉ¹Ñ¥°¹­åAÍÍÝ½Éì(ô((¹Üô½ÕÑÁÕÐ¹¡ÍAÍÍÝ½ÉôÉ¹Ñ¥°¹ÁÍÍÝ½Éì(½ÕÑÁÕÐ¹¡Í-äôÉ¹Ñ¥°¹­äì(½ÕÑÁÕÐ¹¡Í-åAÍÍÝ½ÉôÉ¹Ñ¥°¹­åAÍÍÝ½Éì(¥¡É¹Ñ¥°¹ÁÕ±¥-ä¤ì(½ÕÑÁÕÐ¹ÁÕ±¥-äôÉ¹Ñ¥°¹ÁÕ±¥-äì(ô(¥¡É¹Ñ¥°¹ÉÑAÕ±¥-ä¤ì(½ÕÑÁÕÐ¹ÉÑAÕ±¥-äôÉ¹Ñ¥°¹ÉÑAÕ±¥-äì(ô((¥½¹Ñ¹Ð¹½Õ¹Ð¡½±¤ôÄè(¥¡íÉ±ôèÉ¹Ñ¥°ÍÉÐµÉÑÕÉ¸±½¬¥¹½ÐµÑ ¤(½¹Ñ¹Ðô½¹Ñ¹Ð¹ÉÁ±¡½±°¹Ü°Ä¤(ÝÉ¥Ñ¡É½½Ð°É°°½¹Ñ¹Ð¤(()ÁÑ¡}ÍÉÑ}¥±}ÁÉµ¥ÍÍ¥½¹Ì¡É½½ÐèAÑ ¤´ø9½¹è(ÉÁ±}áÐ (É½½Ð°(ÍÉ½­¹½ÕÑ¥±Ì½ÍåÍÑ´µÉåÁÑ¼¹ÑÌ°(Ý¥ÐÌ¹ÝÉ¥Ñ¥±¡¹ÙAÑ °¹Ù½¹Ñ¹Ð¤ì°(Ý¥ÐÌ¹ÝÉ¥Ñ¥±¡¹ÙAÑ °¹Ù½¹Ñ¹Ð°ìµ½èÁ¼ØÀÀô¤ì(Ý¥ÐÌ¹¡µ½¡¹ÙAÑ °Á¼ØÀÀ¤ì°(¤(()ÁÑ¡}½½­¥}Á½±¥ä¡É½½ÐèAÑ ¤´ø9½¹è(ÉÁ±}áÐ (É½½Ð°(ÍÉ½­¹½ÕÑ¥±Ì½ÕÑ µµ¹È¹ÑÌ°(ÍµM¥Ñè±àÌ½¹ÍÐ°°(ÍµM¥ÑèÍÑÉ¥ÐÌ½¹ÍÐ°°(áÁÑ}½Õ¹ÐôÈ°(¤(()µ¥¸ ¤´ø9½¹è(ÁÉÍÈôÉÁÉÍ¹ÉÕµ¹ÑAÉÍÈ ¤(ÁÉÍÈ¹}ÉÕµ¹Ð ÉÁ¼°ÑåÁõAÑ °¡±ÀôAÑ Ñ¼±¸QÉµ¥à¡­½ÕÐ¤(ÁÉÍÈ¹}ÉÕµ¹Ð (´µ½É°(Ñ¥½¸ôÍÑ½É}ÑÉÕ°(¡±ÀôÁÁ±äÙ¸Ý¡¸!¥Ì¹½ÐÑ¡Õ¥ÑÕÁÍÑÉ´½µµ¥Ð°(¤(ÉÌôÁÉÍÈ¹ÁÉÍ}ÉÌ ¤((É½½ÐôÉÌ¹ÉÁ¼¹ÉÍ½±Ù ¤(¡­}ÕÁÍÑÉ´¡É½½Ð°ÉÌ¹½É¤((ÁÑ¡}Õ¹±}Á±Õ¥¹Ì¡É½½Ð¤(ÁÑ¡}½µÁ½Í¡É½½Ð¤(ÁÑ¡}¡½ÍÑ}­å}ÙÉ¥¥È¡É½½Ð¤(ÁÑ¡}½ÉÌ¡É½½Ð¤(ÁÑ¡}ÑÕ¹¹±}±½½Á¬¡É½½Ð¤(ÁÑ¡}½µµ¹}¡¥ÍÑ½Éä¡É½½Ð¤(ÁÑ¡}ÕÍÉ}Á±Õ¥¹Ì¡É½½Ð¤(ÁÑ¡}¥±}µ¹É}¹½}ÍÕ¼¡É½½Ð¤(ÁÑ¡}µÑÉ¥Í}É}½¹±ä¡É½½Ð¤(ÁÑ¡}ÍÍ¡}±½É¥Ñ¡µÌ¡É½½Ð¤(ÁÑ¡}¡½ÍÑ}ÍÉÑ}Á¥Ì¡É½½Ð¤(ÁÑ¡}É¹Ñ¥±}Ñ¥°¡É½½Ð¤(ÁÑ¡}ÍÉÑ}¥±}ÁÉµ¥ÍÍ¥½¹Ì¡É½½Ð¤(ÁÑ¡}½½­¥}Á½±¥ä¡É½½Ð¤((ÁÉ¥¹Ð m9½M¡±°A¡ÍÅtÁÁ±¥ÍÕÍÍÕ±±ä¤(ÁÉ¥¹Ð m9½M¡±°A¡ÍÅtÉÕ¸±¥¹Ð½ÑåÁ¡¬½ÑÍÑÌ½É½µµ¥ÑÑ¥¹¤(()¥}}¹µ}|ôô}}µ¥¹}|è(µ¥¸ ¤(