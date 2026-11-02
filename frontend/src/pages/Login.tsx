import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Button, Icon } from "../components/ui";

export function LoginPage({ mockMode }: { mockMode: boolean }) {
  const [username, setUsername] = useState("analyst@tracedocs.local");
  const [password, setPassword] = useState("demo-access");
  const [visible, setVisible] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const stored = localStorage.getItem("tracedocs.session");
  const login = useMutation({
    mutationFn: () => api.login({ username: username.trim(), password }),
    onSuccess: (session) => {
      localStorage.setItem("tracedocs.session", JSON.stringify(session));
      const state = location.state as { from?: { pathname?: string } } | null;
      navigate(state?.from?.pathname ?? "/cases", { replace: true });
    },
  });
  if (stored) return <Navigate to="/cases" replace />;
  return (
    <main className="login-layout">
      <section className="login-brand-panel">
        <div className="login-brand"><span className="brand-mark">T</span><strong>TraceDocs</strong></div>
        <div className="login-brand-copy"><p className="eyebrow">Evidence-led review</p><h1>Clarity begins<br />with the record.</h1><p>Inspect document evidence, compare recorded assertions, and keep machine observations separate from analyst review.</p></div>
        <div className="login-footer-copy"><Icon name="shield" size={16} /> Synthetic fixtures · no live analysis</div>
        <div className="login-orbit login-orbit-one" /><div className="login-orbit login-orbit-two" />
      </section>
      <section className="login-form-panel">
        <form className="login-card" onSubmit={(event) => { event.preventDefault(); login.mutate(); }}>
          <div className="login-mobile-brand"><span className="brand-mark">T</span><strong>TraceDocs</strong></div>
          <p className="eyebrow">Analyst workspace</p><h2>Welcome back</h2><p className="login-subtitle">Sign in to continue to the local review workspace.</p>
          <label className="field-label" htmlFor="username">Email or analyst ID</label>
          <input id="username" className="text-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
          <label className="field-label password-label" htmlFor="password">Password</label>
          <div className="password-input"><input id="password" className="text-input" type={visible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /><button type="button" className="password-toggle" onClick={() => setVisible((value) => !value)} aria-label={visible ? "Hide password" : "Show password"}><Icon name="eye" size={18} /></button></div>
          {login.isError && <p className="form-error" role="alert">{login.error instanceof Error ? login.error.message : "Sign-in failed."}</p>}
          <Button type="submit" className="login-submit" disabled={login.isPending}>{login.isPending ? "Signing in…" : "Sign in"} <Icon name="arrow" size={16} /></Button>
          <div className="login-demo-note"><span className="pulse-dot" /><span><strong>{mockMode ? "Mock authentication enabled" : "Backend authentication"}</strong><small>{mockMode ? "Use the pre-filled credentials to enter the fixture workspace." : "Credentials are validated by the configured API."}</small></span></div>
          <p className="login-terms">TraceDocs displays observed inconsistencies and potential anomalies for human review.</p>
        </form>
      </section>
    </main>
  );
}
