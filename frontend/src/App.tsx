import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Breadcrumbs, LoadingState, PageHeader } from "./components/ui";
import { mockMode as MOCK_MODE } from "./config";

const CaseDetailPage = lazy(() => import("./pages/Cases").then((module) => ({ default: module.CaseDetailPage })));
const CasesPage = lazy(() => import("./pages/Cases").then((module) => ({ default: module.CasesPage })));
const ComparePage = lazy(() => import("./pages/Findings").then((module) => ({ default: module.ComparePage })));
const FindingDetailPage = lazy(() => import("./pages/Findings").then((module) => ({ default: module.FindingDetailPage })));
const FindingsPage = lazy(() => import("./pages/Findings").then((module) => ({ default: module.FindingsPage })));
const EntitiesPage = lazy(() => import("./pages/Entities").then((module) => ({ default: module.EntitiesPage })));
const LoginPage = lazy(() => import("./pages/Login").then((module) => ({ default: module.LoginPage })));
const ReportsPage = lazy(() => import("./pages/Reports").then((module) => ({ default: module.ReportsPage })));
const HomePage = lazy(() => import("./pages/Home").then((module) => ({ default: module.HomePage })));
const ScannerPage = lazy(() => import("./pages/Scanner").then((module) => ({ default: module.ScannerPage })));
const DocumentWorkspace = lazy(() => import("./pages/workspace/DocumentWorkspace").then((module) => ({ default: module.DocumentWorkspace })));
const DocumentIndexRedirect = lazy(() => import("./pages/workspace/DocumentWorkspace").then((module) => ({ default: module.DocumentIndexRedirect })));

function ProtectedLayout() {
  const location = useLocation();
  const authenticated = Boolean(localStorage.getItem("tracedocs.session"));
  if (!authenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  return <AppShell mockMode={MOCK_MODE}><Outlet /></AppShell>;
}

function BackendUnavailablePage({ feature, endpoints }: { feature: string; endpoints: string[] }) {
  return (
    <>
      <Breadcrumbs items={[{ label: feature }]} />
      <PageHeader
        eyebrow="Live integration unavailable"
        title={feature}
        description="The shared API contract describes this view, but the current backend does not mount the required routes."
      />
      <section className="panel integration-gap" role="status">
        <h2>Not available from the configured backend</h2>
        <p>No request was sent for this view. Use fixture mode to inspect the recorded examples.</p>
        <ul>{endpoints.map((endpoint) => <li key={endpoint}><code>{endpoint}</code></li>)}</ul>
      </section>
    </>
  );
}

export function App() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<LoadingState label="Loading workspace view" />}>
          <Routes>
            <Route path="/login" element={<LoginPage mockMode={MOCK_MODE} />} />
            <Route element={<ProtectedLayout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/scanner" element={<ScannerPage />} />
              <Route path="/documents" element={<Navigate to="/" replace />} />
              <Route path="/cases" element={<CasesPage mockMode={MOCK_MODE} />} />
              <Route path="/cases/:caseId" element={<CaseDetailPage />} />
              <Route path="/upload" element={<Navigate to="/scanner" replace />} />
              <Route path="/documents/:docId" element={<DocumentIndexRedirect />} />
              <Route path="/documents/:docId/:tab" element={<DocumentWorkspace />} />
              <Route path="/findings" element={<FindingsPage />} />
              <Route path="/findings/:findingId" element={<FindingDetailPage />} />
              <Route path="/compare/:findingId" element={<ComparePage />} />
              <Route path="/entities" element={<EntitiesPage />} />
              <Route path="/reports" element={MOCK_MODE ? <ReportsPage /> : <BackendUnavailablePage feature="Reports" endpoints={["GET /cases/{caseId}/dossier", "GET /cases/{caseId}/events", "GET /cases/{caseId}/integrity"]} />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
