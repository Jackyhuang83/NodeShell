import { useEffect, useState } from "react";
import { Monitor, Moon, Shield, Sun, User } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { useTheme } from "@/components/theme-provider";
import {
  changePassword,
  getSessions,
  getVersionInfo,
  revokeSession,
} from "@/main-axios";

type SessionRow = Awaited<ReturnType<typeof getSessions>>["sessions"][number];

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        {icon}
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function UserProfilePanel({
  username,
  onLogout,
}: {
  username?: string;
  onLogout?: () => void;
  userPrefs?: unknown;
  onPrefsChange?: (updates: Record<string, unknown>) => void;
}) {
  const { theme, setTheme } = useTheme();
  const [version, setVersion] = useState("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    void getVersionInfo()
      .then((info) => setVersion(info.localVersion || ""))
      .catch(() => {});
    void refreshSessions();
  }, []);

  async function refreshSessions(): Promise<void> {
    try {
      const result = await getSessions();
      setSessions(result.sessions ?? []);
    } catch {
      setSessions([]);
    }
  }

  async function handlePasswordChange(): Promise<void> {
    if (!oldPassword || !newPassword) {
      toast.error("Current and new password are required.");
      return;
    }
    if (newPassword.length < 12) {
      toast.error("New password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match.");
      return;
    }

    setChangingPassword(true);
    try {
      await changePassword(oldPassword, newPassword);
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password changed.");
    } catch {
      toast.error("Password change failed.");
    } finally {
      setChangingPassword(false);
    }
  }

  async function handleRevoke(session: SessionRow): Promise<void> {
    if (session.isCurrentSession) return;
    try {
      await revokeSession(session.id);
      await refreshSessions();
      toast.success("Session revoked.");
    } catch {
      toast.error("Could not revoke session.");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-3">
      <Section title="Owner" icon={<User className="size-4" />}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{username || "Owner"}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Single-owner NodeShell account
              {version ? ` · v${version}` : ""}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => onLogout?.()}>
            Sign out
          </Button>
        </div>
      </Section>

      <Section title="Password" icon={<Shield className="size-4" />}>
        <div className="grid gap-3">
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            value={oldPassword}
            onChange={(event) => setOldPassword(event.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          <Button
            className="justify-self-start"
            size="sm"
            disabled={changingPassword}
            onClick={() => void handlePasswordChange()}
          >
            {changingPassword ? "Changing…" : "Change password"}
          </Button>
        </div>
      </Section>

      <Section title="Sessions" icon={<Monitor className="size-4" />}>
        <div className="flex flex-col divide-y divide-border">
          {sessions.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No active sessions found.
            </div>
          ) : (
            sessions.map((session) => (
              <div
                key={session.id}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">
                    {session.deviceInfo || session.deviceType || "Browser"}
                    {session.isCurrentSession ? " · Current" : ""}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    Last active {new Date(session.lastActiveAt).toLocaleString()}
                  </div>
                </div>
                {!session.isCurrentSession && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRevoke(session)}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </Section>

      <Section title="Appearance" icon={<Sun className="size-4" />}>
        <div className="flex gap-2">
          {[
            { id: "light", label: "Light", icon: Sun },
            { id: "dark", label: "Dark", icon: Moon },
            { id: "system", label: "System", icon: Monitor },
          ].map((option) => {
            const Icon = option.icon;
            return (
              <Button
                key={option.id}
                variant={theme === option.id ? "default" : "outline"}
                size="sm"
                onClick={() => setTheme(option.id as "light" | "dark" | "system")}
              >
                <Icon className="size-3.5" />
                {option.label}
              </Button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
