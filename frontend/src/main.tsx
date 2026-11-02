import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/AppShell";
import "./styles.css";

async function start() {
  if (import.meta.env.VITE_USE_MOCKS !== "false") {
    const { worker } = await import("./mocks/browser");
    await worker.start({
      onUnhandledRequest: "warn",
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary><App /></ErrorBoundary>
    </React.StrictMode>,
  );
}

void start();
