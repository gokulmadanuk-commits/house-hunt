"use client";
// Client-side plumbing: API calls, "who's looking" identity, small UI atoms.

import { createContext, useContext, useEffect, useState } from "react";
import type { ClientConfig } from "@/lib/config";
import type { Property } from "@/lib/types";

export async function api<T = Property>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "content-type": "application/json", ...init?.headers } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export function runOp(id: string, op: string, args: Record<string, unknown> = {}) {
  return api<Property>(`/api/properties/${id}`, { method: "POST", json: { op, args } });
}

export const fileUrl = (rel: string) => `/api/files/${rel.split("/").map(encodeURIComponent).join("/")}`;

interface Ctx {
  config: ClientConfig;
  member: string;
  setMember: (m: string) => void;
}

const AppContext = createContext<Ctx | null>(null);

export function AppProvider({ config, children }: { config: ClientConfig; children: React.ReactNode }) {
  const [member, setMemberState] = useState("");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("hh_member");
      if (saved && config.members.includes(saved)) setMemberState(saved);
    } catch {
      /* storage unavailable */
    }
  }, [config.members]);
  const setMember = (m: string) => {
    setMemberState(m);
    try {
      localStorage.setItem("hh_member", m);
    } catch {
      /* ignore */
    }
  };
  return (
    <AppContext.Provider value={{ config, member: member || config.members[0] || "Us", setMember }}>
      {children}
      {!member && config.members.length > 1 && <WhoPicker members={config.members} onPick={setMember} />}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

function WhoPicker({ members, onPick }: { members: string[]; onPick: (m: string) => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4 backdrop-blur-sm">
      <div className="card w-full max-w-sm p-6 text-center shadow-xl">
        <p className="eyebrow">Welcome</p>
        <h2 className="mt-1 font-display text-2xl">Who&rsquo;s looking?</h2>
        <p className="mt-2 text-sm text-ink-2">Notes and ideas are signed so you can see who thought what.</p>
        <div className="mt-5 flex justify-center gap-3">
          {members.map((m) => (
            <button key={m} className="btn-primary min-w-24" onClick={() => onPick(m)}>
              {m}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MemberSwitch() {
  const { config, member, setMember } = useApp();
  if (config.members.length < 2) return null;
  return (
    <div className="flex items-center gap-1 rounded-full border border-line bg-card p-0.5 text-sm" role="radiogroup" aria-label="Who's looking">
      {config.members.map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={m === member}
          onClick={() => setMember(m)}
          className={`rounded-full px-3 py-1 font-medium transition-colors ${m === member ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"}`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} aria-hidden />;
}

export function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, setError, run };
}

export function ErrorNote({ error, onClose }: { error: string | null; onClose?: () => void }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-3 rounded-md border border-brick/30 bg-brick/5 px-3 py-2 text-sm text-brick-2" role="alert">
      <span className="flex-1">{error}</span>
      {onClose && (
        <button className="text-brick-2/70 hover:text-brick-2" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

export function Stars({ value, onChange, size = "text-lg" }: { value: number; onChange?: (v: number) => void; size?: string }) {
  return (
    <span className={`inline-flex ${size} leading-none`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          onClick={() => onChange?.(n === value ? 0 : n)}
          className={`px-px ${n <= value ? "text-ochre" : "text-line"} ${onChange ? "hover:text-ochre/70" : "cursor-default"}`}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
        >
          ★
        </button>
      ))}
    </span>
  );
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
