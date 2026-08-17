import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setAccessToken } from '../lib/api';
import type { User } from '../lib/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (fullName: string, email: string, password: string, phone?: string) => Promise<User>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * On first load the access token is gone (it lives in memory), but the
   * httpOnly refresh cookie may still be valid — so try to restore the session
   * before deciding the visitor is signed out.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await api.post<{ user: User; accessToken: string }>('/auth/refresh');
        if (cancelled) return;
        setAccessToken(response.data.accessToken);
        setUser(response.data.user);
      } catch {
        if (!cancelled) {
          setAccessToken(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await api.post<{ user: User; accessToken: string }>('/auth/login', {
      email,
      password,
    });
    setAccessToken(response.data.accessToken);
    setUser(response.data.user);
    return response.data.user;
  }, []);

  const register = useCallback(
    async (fullName: string, email: string, password: string, phone?: string) => {
      const response = await api.post<{ user: User; accessToken: string }>('/auth/register', {
        fullName,
        email,
        password,
        ...(phone ? { phone } : {}),
      });
      setAccessToken(response.data.accessToken);
      setUser(response.data.user);
      return response.data.user;
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      // Clear local state even if the network call failed, so the user is not
      // left looking at a signed-in interface.
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const response = await api.get<{ user: User }>('/auth/me');
    setUser(response.data.user);
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, logout, refreshUser }),
    [user, loading, login, register, logout, refreshUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider.');
  return context;
}

/** Where each role lands after signing in. */
export function homePathFor(role: User['role']): string {
  if (role === 'ADMIN') return '/admin';
  if (role === 'AGENT') return '/agent';
  return '/dashboard';
}
