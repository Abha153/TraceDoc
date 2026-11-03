import { Component, useEffect, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Icon } from "./ui";

const navItems = [
  { label: "Cases", to: "/cases", icon: "cases" },
  { label: "Upload", to: "/upload", icon: "upload" },
  { label: "Findings", to: "/findings", icon: "findings" },
  { label: "Entities", to: "/entities", icon: "entities" },
  { label: "Reports", to: "/reports", icon: "reports" },
];

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
          <div className="brand-mark">T</div>
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

export function AppShell({ children, mockMode }: { children: ReactNode; mockMode: boolean }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const displayName = readDisplayName();
  const initials = displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

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

  return (
    <div className="app-frame">
      {sidebarOpen && <button className="mobile-scrim" aria-label="Dismiss navigation overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`} id="primary-sidebar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <span><strong>TraceDocs</strong><small>Evidence workspace</small></span>
          <button ref={closeButtonRef} className="mobile-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><Icon name="close" /></button>
        </div>
        <div className="nav-section-label">Workspace</div>
        <nav className="primary-nav" aria-label="Primary">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) => `nav-link ${isActive ? "nav-link-active" : ""}`}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="sidebar-note-icon"><Icon name="shield" size={16} /></span>
            <div><strong>{mockMode ? "Fixture workspace" : "Backend workspace"}</strong><small>{mockMode ? "Recorded synthetic evidence" : "Configured backend records"}</small></div>
          </div>
          <div className="sidebar-profile">
            <span className="avatar">{initials || "SA"}</span>
            <div className="profile-copy"><strong>{displayName}</strong><small>Analyst · local demo</small></div>
            <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={logout}><Icon name="logout" size={17} /></button>
          </div>
        </div>
      </aside>
      <section className="main-column">
        <header className="topbar">
          <button ref={menuButtonRef} className="menu-button" aria-label="Open navigation" aria-expanded={sidebarOpen} aria-controls="primary-sidebar" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
          <div className="topbar-crumb">
            <span>TraceDocs</span><span className="breadcrumb-separator">/</span>
            <span>{navItems.find((item) => location.pathname.startsWith(item.to))?.label ?? "Workspace"}</span>
          </div>
          <div className="topbar-right">
            <span className="mock-indicator"><span className="pulse-dot" /> {mockMode ? "Fixture mode" : "Backend mode"}</span>
            <span className="topbar-avatar" aria-label={displayName}>{initials || "SA"}</span>
          </div>
        </header>
        <div className={`mock-banner ${mockMode ? "" : "backend-banner"}`} role="note">
          <strong>{mockMode ? "Fixture mode" : "Backend mode"}</strong>
          <span>{mockMode ? "Recorded synthetic outputs only. Uploads are not analyzed and do not produce new findings." : "Live backend. The integrity check and dossier export routes are not built yet, so those views are composed or marked unavailable. Analysis runs on recorded fixtures until the Python service is connected."}</span>
        </div>
        <main className="main-content"><ErrorBoundary>{children}</ErrorBoundary></main>
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
