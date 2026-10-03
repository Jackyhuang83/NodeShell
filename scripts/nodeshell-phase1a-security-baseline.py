#!/usr/bin/env python3
from pathlib import Path
import json,re,sys
R=Path(sys.argv[1])
def rd(f): return (R/f).read_text()
def wr(f,s): (R/f).write_text(s)
def rep(f,a,b,n=1):
 s=rd(f); c=s.count(a)
 if c!=n: raise SystemExit(f'{f}: anchor count {c}, expected {n}')
 wr(f,s.replace(a,b,n))

# bundled surface + local-only compose
wr('docker/bundled-plugins.json',json.dumps({'plugins':[{'id':x,'source':'workspace'} for x in ['file-manager','host-metrics','ssh-terminal','totp','tunnels','webauthn']]},indent=2)+'\n')
wr('docker/docker-compose.yml','''services:\n  nodeshell:\n    image: ghcr.io/jackyhuang83/nodeshell:latest\n    container_name: nodeshell\n    restart: unless-stopped\n    ports:\n      - "127.0.0.1:8080:8080"\n    volumes:\n      - nodeshell-data:/app/data\n      - /etc/nodeshell/secrets:/run/secrets/nodeshell:ro\n    environment:\n      PORT: "8080"\n      TERMIX_REQUIRE_EXTERNAL_SECRETS: "true"\n      JWT_SECRET_FILE: "/run/secrets/nodeshell/jwt_secret"\n      DATABASE_KEY_FILE: "/run/secrets/nodeshell/database_key"\n      ENCRYPTION_KEY_FILE: "/run/secrets/nodeshell/encryption_key"\n      INTERNAL_AUTH_TOKEN_FILE: "/run/secrets/nodeshell/internal_auth_token"\nvolumes:\n  nodeshell-data:\n    driver: local\n''')

# host-key verification: SHA-256, no fail-open, no jump-host auto accept
f='src/backend/hosts/host-key-verifier.ts'; s=rd(f)
s=s.replace('import { pluginEvents, TOPICS } from "../plugins/events.js";','import crypto from "node:crypto";\nimport { pluginEvents, TOPICS } from "../plugins/events.js";',1)
s=s.replace('const fingerprint = hostkey.toString("hex");','const fingerprint = `SHA256:${crypto.createHash("sha256").update(hostkey).digest("base64").replace(/=+$/, "")}`;',1)
s,n=re.subn(r'          if \(!hostId\) \{[\s\S]*?            verify\(true\);\n            return;\n          \}\n','''          if (!hostId) {\n            if (!ws) { verify(false); return; }\n            const accepted = await this.promptUserForNewKey(ws, ip, port, undefined, fingerprint, keyType, algorithm);\n            verify(accepted);\n            return;\n          }\n''',s,count=1)
if n!=1: raise SystemExit(f'{f}: quick-connect block')
s,n=re.subn(r'(          if \(!host\) \{[\s\S]*?operation: "host_key_no_host"[\s\S]*?)verify\(true\);',r'\1verify(false);',s,count=1)
if n!=1: raise SystemExit(f'{f}: missing-host block')
for pat,label in [(r'\n            if \(isJumpHost\) \{[\s\S]*?Jump host key auto-accepted and stored[\s\S]*?verify\(true\);\n              return;\n            \}\n','jump first'),(r'\n          if \(isJumpHost\) \{[\s\S]*?Jump host key changed - auto-accepted[\s\S]*?verify\(true\);\n            return;\n          \}\n','jump changed')]:
 s,n=re.subn(pat,'\n',s,count=1)
 if n!=1: raise SystemExit(f'{f}: {label}')
s,n=re.subn(r'(No WebSocket available for host key verification prompt[\s\S]*?)verify\(true\);',r'\1verify(false);',s,count=1)
if n!=1: raise SystemExit(f'{f}: no-ws block')
s=s.replace('    isJumpHost: boolean = false,','    _isJumpHost: boolean = false,',1); wr(f,s)

# CORS: no Electron bypass, unconfigured means same-origin only
f='src/backend/utils/cors-config.ts'; s=rd(f)
s=s.replace('const ELECTRON_FILE_ORIGIN = "file://";\n','')
s=s.replace('  if (origin.startsWith(ELECTRON_FILE_ORIGIN)) return true;\n','')
s=s.replace('  if (configured.length === 0) return true;','  if (configured.length === 0) return origin === getRequestOrigin(req);',1)
wr(f,s)

# tunnels loopback only
rep('plugins/tunnels/src/backend/utils.ts','return tunnelConfig.bindHost || "127.0.0.1";','return "127.0.0.1";')

# command history off
f='plugins/ssh-terminal/manifest.json'; s=rd(f); s,n=re.subn(r'("key": "enableCommandHistory"[\s\S]{0,300}?"default": )true',r'\1false',s,count=1)
if n!=1: raise SystemExit(f'{f}: history'); wr(f,s)

# unsigned user plugins disabled
rep('src/backend/plugins/trust.ts','return process.env.TERMIX_REQUIRE_SIGNED_PLUGINS === "true";','return true;')

# SFTP cannot inherit sudo password
rep('plugins/file-manager/src/backend/index.ts','sudoPassword: resolvedHost.sudoPassword as string | undefined,','sudoPassword: undefined,')
rep('plugins/file-manager/src/backend/index.ts','sudoPassword: resolvedCredentials.sudoPassword,','sudoPassword: undefined,')

# metrics: remove manager routes
f='plugins/host-metrics/src/backend/routes.ts'; s=rd(f)
for x in ['import { registerManagerRoutes } from "./managers/index.js";\n','import { AccessDeniedError } from "./managers/route-helpers.js";\n','import { sudoPasswordOf } from "./helpers.js";\n']:
 if x not in s: raise SystemExit(f'{f}: import'); s=s.replace(x,'',1)
a=s.rfind('\n  registerManagerRoutes(router, {'); b=s.rfind('\n}')
if a<0 or b<=a: raise SystemExit(f'{f}: manager block')
wr(f,s[:a]+s[b:])

# modern SSH crypto only unless explicit compatibility flag
rep('src/backend/hosts/connect/build-connect-config.ts','algorithms: buildSSHAlgorithms(sshOptions?.allowLegacyAlgorithms !== false),','algorithms: buildSSHAlgorithms(sshOptions?.allowLegacyAlgorithms === true),')
f='src/backend/utils/ssh-algorithms.ts'; s=rd(f)
for x in ['    "aes256-cbc",\n','    "aes192-cbc",\n','    "aes128-cbc",\n']:
 if s.count(x)!=1: raise SystemExit(f'{f}: CBC'); s=s.replace(x,'',1)
wr(f,s)

# block browser secret-read/export paths + saved-credential Quick Connect
f='src/backend/database/routes/host.ts'; s=rd(f)
a='const router = express.Router();\nrouter.use(rejectSharedCopyWrites("host", /^\\/db\\/host\\/(\\d+)$/));\n'
b=a+'''router.use((req, res, next) => {\n  const blocked = req.method === "GET" && (/^\\/db\\/host\\/\\d+\\/password$/.test(req.path) || /^\\/db\\/host\\/\\d+\\/export$/.test(req.path) || req.path === "/db/hosts/export");\n  if (blocked) return res.status(404).json({ error: "Not found" });\n  next();\n});\n'''
if s.count(a)!=1: raise SystemExit(f'{f}: guard'); s=s.replace(a,b,1)
a='    try {\n      let resolvedPassword = password;'
b='''    if (authType === "credential") {\n      return res.status(400).json({ error: "Saved credentials are disabled in Quick Connect until backend-only references are complete." });\n    }\n\n    try {\n      let resolvedPassword = password;'''
if s.count(a)!=1: raise SystemExit(f'{f}: quick'); s=s.replace(a,b,1); wr(f,s)

# credential detail metadata only
f='src/backend/database/routes/credentials.ts'; s=rd(f)
old='''      if (credential.password) {\n        output.password = credential.password;\n      }\n      output.hasKey = !!credential.key;\n      output.hasKeyPassword = !!credential.keyPassword;\n      if (credential.publicKey) {\n        output.publicKey = credential.publicKey;\n      }\n      if (credential.certPublicKey) {\n        output.certPublicKey = credential.certPublicKey;\n      }\n      if (credential.keyPassword) {\n        output.keyPassword = credential.keyPassword;\n      }\n'''
new='''      output.hasPassword = !!credential.password;\n      output.hasKey = !!credential.key;\n      output.hasKeyPassword = !!credential.keyPassword;\n      if (credential.publicKey) output.publicKey = credential.publicKey;\n      if (credential.certPublicKey) output.certPublicKey = credential.certPublicKey;\n'''
if s.count(old)!=1: raise SystemExit(f'{f}: secret detail'); s=s.replace(old,new,1); wr(f,s)

# local secret file perms + strict cookies
rep('src/backend/utils/system-crypto.ts','      await fs.writeFile(envPath, envContent);','      await fs.writeFile(envPath, envContent, { mode: 0o600 });\n      await fs.chmod(envPath, 0o600);')
rep('src/backend/utils/auth-manager.ts','      sameSite: "lax" as const,','      sameSite: "strict" as const,',2)
print('NodeShell Phase 1A applied')
