"use client";

import { useEffect, useRef, useState } from "react";
import { useAuthenticatedViewer } from "./AuthUserProvider";

type WorkspaceUser = {
  name: string;
  username: string;
  role: "admin" | "member";
};

export default function AccountMenu() {
  const { viewer, chatGPTSignOutPath } = useAuthenticatedViewer();
  const [user, setUser] = useState<WorkspaceUser | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (
          response.ok &&
          response.headers.get("content-type")?.includes("application/json")
        ) {
          const data = (await response.json()) as { user: WorkspaceUser };
          if (alive) setUser(data.user);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  async function logout() {
    setError("");
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (response.ok) {
        window.location.assign("/login");
        return;
      }
      if (response.status === 404 || response.status === 405) {
        window.location.assign(chatGPTSignOutPath);
        return;
      }
      throw new Error("退出失败，请重试");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "退出失败");
    }
  }

  const name = user?.name || viewer.name;
  const role = user
    ? user.role === "admin"
      ? "管理员"
      : "团队成员"
    : "已验证账号";

  return (
    <div className="profile" ref={root}>
      <div>{name.slice(0, 1)}</div>
      <span>
        <b>{name}</b>
        <small>{role}</small>
      </span>
      <button
        type="button"
        aria-label="个人账号菜单"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "⌃" : "⌄"}
      </button>
      {open && (
        <section className="account-panel" aria-label="个人账号面板">
          <header>
            <div className="account-avatar">{name.slice(0, 1)}</div>
            <div>
              <h2>{name}</h2>
              <p>{role} · Lumina 工作区</p>
              <small>{user?.username || viewer.email}</small>
            </div>
          </header>
          <div className="account-section">
            <h3>账号与安全</h3>
            {user && (
              <button type="button" onClick={() => window.location.assign("/account")}>
                <span>
                  <b>{user.role === "admin" ? "账号与成员管理" : "账号设置"}</b>
                  <small>
                    修改密码{user.role === "admin" ? "、审核注册账号" : ""}
                  </small>
                </span>
                <em>›</em>
              </button>
            )}
            <button type="button" onClick={logout}>
              <span>
                <b>退出登录</b>
                <small>保留当前浏览器中的创作草稿</small>
              </span>
              <em>›</em>
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </section>
      )}
    </div>
  );
}
