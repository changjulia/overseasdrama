"use client";

import { createContext, useContext, type ReactNode } from "react";

export type AuthenticatedViewer = {
  name: string;
  email: string;
};

type AuthUserContextValue = {
  viewer: AuthenticatedViewer;
  chatGPTSignOutPath: string;
};

const AuthUserContext = createContext<AuthUserContextValue | null>(null);

export function AuthUserProvider({
  children,
  viewer,
  chatGPTSignOutPath,
}: AuthUserContextValue & { children: ReactNode }) {
  return (
    <AuthUserContext.Provider value={{ viewer, chatGPTSignOutPath }}>
      {children}
    </AuthUserContext.Provider>
  );
}

export function useAuthenticatedViewer() {
  const value = useContext(AuthUserContext);
  if (!value) throw new Error("Authenticated viewer context is unavailable");
  return value;
}
