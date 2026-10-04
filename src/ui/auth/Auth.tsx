import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, User } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import {
  getSetupRequired,
  getUserInfo,
  loginUser,
} from "@/main-axios";

const STORAGE_KEY = "nodeshell_auth";

export function getStoredAuth(): {
  loggedIn: boolean;
  username: string;
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearStoredAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("jwt");
}

function storeAuth(username: string): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ loggedIn: true, username }),
  );
}

function PasswordInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="current-password"
        disabled={disabled}
        className="pr-10 font-mono"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={show ? "Hide password" : "Show password"}
        onClick={() => setShow((current) => !current)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function Auth({
  onLogin,
}: {
  onLogin: (username: string, userId?: string, isAdmin?: boolean) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(() => {
    try {
      return localStorage.getItem("nodeshell_remember_me") === "true";
    } catch {
      return false;
    }
  });
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);

  useEffect(() => {
    let cancelled = false;

    Promise.allSettled([getUserInfo(), getSetupRequired()]).then((results) => {
      if (cancelled) return;

      const session = results[0];
      if (session.status === "fulfilled" && session.value?.username) {
        storeAuth(session.value.username);
        onLogin(
          session.value.username,
          session.value.userId || undefined,
          !!session.value.is_admin,
        );
        return;
      }

      const setup = results[1];
      if (setup.status === "fulfilled") {
        setSetupRequired(!!setup.value?.setup_required);
      }
      setChecking(false);
    });

    return () => {
      cancelled = true;
    };
  }, [onLogin]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "nodeshell_remember_me",
        rememberMe ? "true" : "false",
      );
    } catch {
      // Remember-me is only a convenience preference.
    }
  }, [rememberMe]);

  async function handleLogin(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const name = username.trim();

    if (!name || !password) {
      toast.error("Username and password are required.");
      return;
    }

    setLoading(true);
    try {
      const result = await loginUser(name, password, rememberMe);
      if (!result?.success) {
        throw new Error("Login failed");
      }
      if (result.requires_totp) {
        throw new Error(
          "This account still requires a removed second-factor configuration.",
        );
      }

      const me = await getUserInfo();
      const resolvedName = me.username || result.username || name;
      storeAuth(resolvedName);
      onLogin(resolvedName, me.userId || undefined, !!me.is_admin);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "Login failed.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="size-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm border border-border bg-card p-6 shadow-sm">
        <div className="mb-6">
          <div className="text-xl font-bold tracking-tight">NodeShell</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Self-hosted SSH & server manager
          </p>
        </div>

        {setupRequired ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound className="size-4" />
              First Owner required
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Browser registration is disabled. Create the Owner locally on the
              NodeShell server:
            </p>
            <code className="block break-all border border-border bg-muted p-3 text-[11px]">
              docker exec -it nodeshell nodeshell admin create-owner --username admin
            </code>
          </div>
        ) : (
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Username
              </label>
              <div className="relative">
                <User className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoFocus
                  disabled={loading}
                  className="pl-9"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Password
              </label>
              <PasswordInput
                value={password}
                onChange={setPassword}
                disabled={loading}
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
                disabled={loading}
              />
              Keep me signed in on this browser
            </label>

            <Button type="submit" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
