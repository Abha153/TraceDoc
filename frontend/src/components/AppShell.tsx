import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { apiBase } from "../config";
import { LAST_VIEWED_EVENT, readLastViewed } from "../lib/lastViewed";
import type { LastViewed } from "../lib/lastViewed";
import { tabIndex, transitionKey } from "../lib/routes";
import { Icon } from "./ui";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("TraceDocs view failed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal-error" role="alert">
          <div className="brand-mark"><Icon name="shield" size={16} /></div>
          <p className="eyebrow">TraceDocs workspace</p>
          <h1>This view couldn’t be displayed</h1>
          <p>{this.state.error.message}</p>
          <button className="button button-secondary" onClick={() => window.location.reload()}>Reload workspace</button>
        </main>
      );
    }
    return this.props.children;
  }
}

const navItems: Array<{ label: string; to: string; icon: string; end?: boolean }> = [
  { label: "Overview", to: "/", icon: "overview", end: true },
  { label: "Document Scanner", to: "/scanner", icon: "scanner" },
  { label: "Investigation", to: "/cases/", icon: "investigation" },
  { label: "Documents", to: "/documents", icon: "documents" },
  { label: "Findings", to: "/findings", icon: "findings" },
  { label: "Entities and Graph", to: "/entities", icon: "entities" },
  { label: "Cases", to: "/cases", icon: "cases", end: true },
  { label: "Reports", to: "/reports", icon: "reports" },
];

type SystemState = "online" | "offline";

function useSystemStatus(mockMode: boolean): SystemState {
  const query = useQuery({
    queryKey: ["system-health"],
    enabled: !mockMode,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      const response = await fetch(`${apiBase}/health`, { credentials: "include" });
      if (!response.ok) throw new Error("unhealthy");
      return true;
    },
  });
  if (mockMode) return "online";
  return query.isError ? "offline" : "online";
}

function useLastViewed(): LastViewed | null {
  const [value, setValue] = useState<LastViewed | null>(() => readLastViewed());
  useEffect(() => {
    const refresh = () => setValue(readLastViewed());
    window.addEventListener(LAST_VIEWED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(LAST_VIEWED_EVENT, refresh); window.removeEventListener("storage", refresh); };
  }, []);
  return value;
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const summaries = useQuery({ queryKey: ["case-summaries"], queryFn: api.listCaseSummaries, staleTime: 30_000 });
  const items = (summaries.data ?? []).flatMap((summary) => summary.jobs
    .filter((job) => job.status === "FAILED" || job.status === "PARTIAL")
    .map((job) => ({ job, caseId: summary.case.caseId })));
  return (
    <div style={{ position: "relative" }}>
      <button type="button" className="topbar-button" aria-label={`Notifications${items.length ? `, ${items.length} need attention` : ""}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="bell" size={16} />
        {items.length > 0 && <span className="notice-count" aria-hidden="true">{items.length}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <h2 className="label">Needs attention</h2>
          {items.length === 0 ? <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>No partial or failed analyses.</p> : (
            <ul>
              {items.map(({ job, caseId }) => (
                <li key={job.jobId}>
                  <Link to={`/documents/${job.docId}/overview`} onClick={() => setOpen(false)}>{job.docId} · {job.status === "FAILED" ? "Analysis failed" : "Partial results"}</Link>
                  <small>{caseId} · some analyzers did not run, so absence of findings is not a clean result.</small>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function AppShell({ children, mockMode }: { children: ReactNode; mockMode: boolean }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousPath = useRef<string>("");
  const location = useLocation();
  const navigate = useNavigate();
  const displayName = readDisplayName();
  const initials = displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const system = useSystemStatus(mockMode);
  const lastViewed = useLastViewed();

  const direction = useMemo(() => {
    const from = tabIndex(previousPath.current);
    const to = tabIndex(location.pathname);
    return from !== null && to !== null && from !== to ? (to > from ? "forward" : "back") : "none";
  }, [location.pathname]);
  useEffect(() => { previousPath.current = location.pathname; }, [location.pathname]);

  useEffect(() => {
    if (!sidebarOpen) return;
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSidebarOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      menuButtonRef.current?.focus();
    };
  }, [sidebarOpen]);

  async function logout() {
    try {
      await api.logout();
    } finally {
      localStorage.removeItem("tracedocs.session");
      navigate("/login");
    }
  }

  function isActive(item: (typeof navItems)[number]): boolean {
    const path = location.pathname;
    if (item.label === "Investigation") return /^\/cases\/[^/]+/.test(path) && !/\/(findings|report)/.test(path);
    if (item.label === "Documents") return path.startsWith("/documents");
    if (item.label === "Document Scanner") return path.startsWith("/scanner") || path.startsWith("/upload");
    if (item.end) return path === item.to;
    return path.startsWith(item.to);
  }
  const investigationTarget = lastViewed?.caseId ? `/cases/${encodeURIComponent(lastViewed.caseId)}` : "/cases";

  return (
    <div className="app-frame">
      {sidebarOpen && <button className="mobile-scrim" aria-label="Dismiss navigation overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`} id="primary-sidebar">
        <div className="brand">
          <span className="brand-mark"><Icon name="shield" size={16} /></span>
          <span><strong>TraceDocs</strong><small>Forensics console</small></span>
          <button ref={closeButtonRef} className="mobile-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><Icon name="close" /></button>
        </div>
        <div className="nav-section-label">Investigation</div>
        <nav className="primary-nav" aria-label="Primary">
          {navItems.map((item) => (
            <NavLink
              key={item.label}
              to={item.label === "Investigation" ? investigationTarget : item.to}
              onClick={() => setSidebarOpen(false)}
              className={() => `nav-link ${isActive(item) ? "nav-link-active" : ""}`}
              aria-current={isActive(item) ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="system-status">
            <span className={`status-dot ${system === "online" ? "" : "status-dot-red"}`} aria-hidden="true" />
            <div>
              <strong>{system === "online" ? "System online" : "Backend unreachable"}</strong>
              <small>{mockMode ? "Fixture mode · recorded data" : "Live backend"}</small>
            </div>
          </div>
          <div className="engine-line mono" aria-hidden="true"><span>MODE {mockMode ? "FIXTURE" : "LIVE"}</span><span>{mockMode ? "DATA RECORDED" : "DATA LIVE"}</span></div>
        </div>
      </aside>
      <section className="main-column">
        <header className="topbar">
          <button ref={menuButtonRef} className="menu-button" aria-label="Open navigation" aria-expanded={sidebarOpen} aria-controls="primary-sidebar" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
          {lastViewed ? (
            <Link className="last-viewed" to={lastViewed.path} title="Resume where you left off">
              <span className="label">Last viewed</span><Icon name="chevron" size={12} /><strong>{lastViewed.label}</strong>
            </Link>
          ) : (
            <span className="last-viewed last-viewed-empty"><span className="label">No document viewed yet</span><span>Open any document to begin</span></span>
          )}
          <form className="topbar-search" role="search" onSubmit={(event) => { event.preventDefault(); navigate(search.trim() ? `/?q=${encodeURIComponent(search.trim())}` : "/"); }}>
            <label htmlFor="topbar-search-input" className="topbar-search-icon" title="Search documents and cases"><Icon name="search" size={15} /></label>
            <input id="topbar-search-input" type="search" aria-label="Search documents and cases" placeholder="Search filename, hash or case" value={search} onChange={(event) => setSearch(event.target.value)} />
          </form>
          <div className="topbar-right">
            <Notifications />
            <div className="analyst-chip">
              <span className="topbar-avatar" aria-hidden="true">{initials || "SA"}</span>
              <div><strong>{displayName}</strong><small>Analyst</small></div>
              <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={logout}><Icon name="logout" size={16} /></button>
            </div>
          </div>
        </header>
        <div className={`mock-banner ${mockMode ? "" : "backend-banner"}`} role="note">
          <strong>{mockMode ? "Fixture mode" : "Backend mode"}</strong>
          <span>{mockMode ? "Recorded synthetic outputs only. The bundled sample documents are analysed from recordings; other files receive no analysis." : "Live backend. Observations are potential anomalies for human review, never verdicts."}</span>
        </div>
        <main className="main-content">
          <div className="route-view" key={transitionKey(location.pathname)} data-direction={direction}>
            <ErrorBoundary>{children}</ErrorBoundary>
          </div>
        </main>
      </section>
    </div>
  );
}

function readDisplayName(): string {
  const serialized = localStorage.getItem("tracedocs.session");
  if (!serialized) return "Sample Analyst";
  try {
    const session: unknown = JSON.parse(serialized);
    if (
      typeof session === "object" &&
      session !== null &&
      "displayName" in session &&
      typeof session.displayName === "string" &&
      session.displayName.trim()
    ) {
      return session.displayName.trim();
    }
  } catch (error) {
    console.error("TraceDocs session could not be read", error);
    localStorage.removeItem("tracedocs.session");
    return "Sample Analyst";
  }
  console.error("TraceDocs session is missing a valid display name");
  localStorage.removeItem("tracedocs.session");
  return "Sample Analyst";
}
