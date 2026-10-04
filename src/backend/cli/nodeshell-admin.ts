import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline/promises";

const INTERNAL_URL =
  process.env.NODESHELL_INTERNAL_URL?.trim() || "http://127.0.0.1:30001";

function usage(): never {
  console.error(`Usage:
  nodeshell admin status
  nodeshell admin create-owner --username <name> [--password-file <path>]
  nodeshell admin reset-password --username <name> [--password-file <path>] [--confirm-data-wipe]

Passwords are never accepted as command-line arguments. Without
--password-file, NodeShell prompts on the attached TTY.`);
  process.exit(2);
}

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function readInternalToken(): Promise<string> {
  const direct = process.env.INTERNAL_AUTH_TOKEN?.trim();
  if (direct) return direct;

  const file = process.env.INTERNAL_AUTH_TOKEN_FILE?.trim();
  if (!file) {
    throw new Error(
      "INTERNAL_AUTH_TOKEN_FILE is not configured inside the NodeShell container",
    );
  }

  const token = (await fs.readFile(file, "utf8")).trim();
  if (!token) throw new Error("Internal auth token file is empty");
  return token;
}

async function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "No interactive TTY. Use --password-file with a root-readable file.",
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(label);
  let echoDisabled = false;
  try {
    execFileSync("stty", ["-echo"], {
      stdio: ["inherit", "ignore", "inherit"],
    });
    echoDisabled = true;
    return await rl.question("");
  } finally {
    if (echoDisabled) {
      try {
        execFileSync("stty", ["echo"], {
          stdio: ["inherit", "ignore", "inherit"],
        });
      } catch {
        // Best effort: the TTY may already have been detached.
      }
    }
    rl.close();
    process.stdout.write("\n");
  }
}

async function readNewPassword(args: string[]): Promise<string> {
  if (args.includes("--password")) {
    throw new Error(
      "Refusing --password because command-line arguments can leak through shell history and process listings",
    );
  }

  const passwordFile = flag(args, "--password-file");
  if (passwordFile) {
    const password = (await fs.readFile(passwordFile, "utf8")).replace(
      /[\r\n]+$/,
      "",
    );
    if (!password) throw new Error("Password file is empty");
    return password;
  }

  const first = await hiddenPrompt("New password: ");
  const second = await hiddenPrompt("Confirm password: ");
  if (first !== second) throw new Error("Passwords do not match");
  return first;
}

async function request(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const token = await readInternalToken();
  const response = await fetch(`${INTERNAL_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { ok: response.ok, status: response.status, data };
}

function errorMessage(result: {
  status: number;
  data: Record<string, unknown>;
}): string {
  const message =
    typeof result.data.error === "string"
      ? result.data.error
      : `Request failed with HTTP ${result.status}`;
  return message;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "admin" || !args[1]) usage();

  const command = args[1];

  if (command === "status") {
    const result = await request("/internal/admin/status");
    if (!result.ok) throw new Error(errorMessage(result));
    console.log(
      result.data.initialized
        ? `NodeShell initialized. Owner: ${(result.data.owner as { username?: string } | null)?.username ?? "unknown"}`
        : "NodeShell is not initialized.",
    );
    return;
  }

  const username = flag(args, "--username")?.trim();
  if (!username) throw new Error("--username is required");

  if (command === "create-owner") {
    const password = await readNewPassword(args);
    const result = await request("/internal/admin/create-owner", {
      method: "POST",
      body: { username, password },
    });
    if (!result.ok) throw new Error(errorMessage(result));
    console.log(`Owner "${username}" created successfully.`);
    return;
  }

  if (command === "reset-password") {
    const newPassword = await readNewPassword(args);
    const confirmDataWipe = args.includes("--confirm-data-wipe");
    const result = await request("/internal/admin/reset-password", {
      method: "POST",
      body: { username, newPassword, confirmDataWipe },
    });

    if (!result.ok) {
      if (result.status === 409 && result.data.requiresDataWipe === true) {
        throw new Error(
          "The legacy encrypted data key cannot be recovered without the old password. " +
            "No data was changed. Re-run with --confirm-data-wipe only if you accept deleting that user's encrypted NodeShell data.",
        );
      }
      throw new Error(errorMessage(result));
    }

    console.log(
      result.data.dataWiped === true
        ? `Password reset for "${username}". Encrypted user data was wiped as explicitly confirmed.`
        : `Password reset for "${username}" with encrypted data preserved.`,
    );
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(
    `NodeShell admin error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
