import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mainAxios = vi.hoisted(() => ({
  getSetupRequired: vi.fn(),
  getUserInfo: vi.fn(),
  loginUser: vi.fn(),
}));

vi.mock("@/main-axios", () => mainAxios);
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { Auth } from "../../auth/Auth";

beforeEach(() => {
  localStorage.clear();
  mainAxios.getSetupRequired.mockResolvedValue({ setup_required: false });
  mainAxios.getUserInfo.mockRejectedValue(new Error("no active session"));
  mainAxios.loginUser.mockResolvedValue({
    success: true,
    username: "alice",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Auth", () => {
  it("continues an existing Web session", async () => {
    const onLogin = vi.fn();
    mainAxios.getUserInfo.mockResolvedValue({
      username: "alice",
      userId: "u1",
      is_admin: true,
    });

    render(<Auth onLogin={onLogin} />);

    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith("alice", "u1", true),
    );
  });

  it("shows the local Owner bootstrap instruction on first setup", async () => {
    mainAxios.getSetupRequired.mockResolvedValue({ setup_required: true });

    render(<Auth onLogin={vi.fn()} />);

    expect(await screen.findByText("First Owner required")).toBeTruthy();
    expect(
      screen.getByText(
        "docker exec -it nodeshell nodeshell admin create-owner --username admin",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("logs in with username and password", async () => {
    const onLogin = vi.fn();
    mainAxios.getUserInfo
      .mockRejectedValueOnce(new Error("no active session"))
      .mockResolvedValueOnce({
        username: "alice",
        userId: "u1",
        is_admin: true,
      });

    const { container } = render(<Auth onLogin={onLogin} />);

    await screen.findByRole("button", { name: "Sign in" });
    const username = container.querySelector(
      'input[autocomplete="username"]',
    ) as HTMLInputElement;
    const password = container.querySelector(
      'input[autocomplete="current-password"]',
    ) as HTMLInputElement;

    fireEvent.change(username, { target: { value: "alice" } });
    fireEvent.change(password, { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(mainAxios.loginUser).toHaveBeenCalledWith(
        "alice",
        "secret",
        false,
      ),
    );
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith("alice", "u1", true),
    );
  });

  it("passes remember-me to the login API", async () => {
    mainAxios.getUserInfo
      .mockRejectedValueOnce(new Error("no active session"))
      .mockResolvedValueOnce({
        username: "alice",
        userId: "u1",
        is_admin: false,
      });

    const { container } = render(<Auth onLogin={vi.fn()} />);
    await screen.findByRole("button", { name: "Sign in" });

    fireEvent.change(
      container.querySelector('input[autocomplete="username"]')!,
      { target: { value: "alice" } },
    );
    fireEvent.change(
      container.querySelector('input[autocomplete="current-password"]')!,
      { target: { value: "secret" } },
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(mainAxios.loginUser).toHaveBeenCalledWith(
        "alice",
        "secret",
        true,
      ),
    );
  });
});
