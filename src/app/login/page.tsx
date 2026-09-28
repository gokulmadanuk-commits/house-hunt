"use client";

import { useState } from "react";

export default function Login() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) });
    if (!res.ok) return setError((await res.json()).error ?? "Try again");
    const next = new URLSearchParams(window.location.search).get("next") || "/";
    window.location.href = next.startsWith("/") ? next : "/";
  };
  return (
    <main className="grid-paper grid min-h-screen place-items-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <p className="eyebrow">House Hunt</p>
        <h1 className="mt-1 font-display text-2xl">Our passcode</h1>
        <input className="input mt-4" type="password" autoFocus value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="Passcode" />
        {error && <p className="mt-2 text-sm text-brick">{error}</p>}
        <button className="btn-primary mt-4 w-full">Come in</button>
      </form>
    </main>
  );
}
