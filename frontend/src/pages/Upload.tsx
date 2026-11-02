import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Job } from "../../../contracts/types";
import { api } from "../api/client";
import { Breadcrumbs, Button, ErrorState, Icon, PageHeader, StatusBadge } from "../components/ui";
import { jobPollIntervalMs, maxUploadMegabytes } from "../config";

const ACCEPTED = new Set(["application/pdf", "image/png", "image/jpeg", "image/tiff"]);
const ACCEPTED_EXTENSIONS = /\.(pdf|png|jpe?g|tiff?)$/i;
const MAX_BYTES = maxUploadMegabytes * 1024 * 1024;

export function UploadPage({ mockMode }: { mockMode: boolean }) {
  const [caseId, setCaseId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [activeJobs, setActiveJobs] = useState<Job[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [creatingCase, setCreatingCase] = useState(false);
  const [newCaseTitle, setNewCaseTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const casesQuery = useQuery({ queryKey: ["cases"], queryFn: api.listCases });
  const createCaseMutation = useMutation({
    mutationFn: () => api.createCase({ title: newCaseTitle.trim() }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["cases"] });
      setCaseId(created.caseId);
      setNewCaseTitle("");
      setCreatingCase(false);
    },
  });
  const uploadMutation = useMutation({
    mutationFn: () => api.upload(caseId, files, ({ percent }) => setUploadProgress(percent)),
    onSuccess: async (result) => {
      setActiveJobs(result.jobs);
      setFiles([]);
      setErrors([]);
      setUploadProgress(null);
      await queryClient.invalidateQueries({ queryKey: ["cases"] });
      await queryClient.invalidateQueries({ queryKey: ["case", caseId] });
    },
    onError: (error) => {
      setUploadProgress(null);
      setErrors([error instanceof Error ? error.message : "Upload could not be completed."]);
    },
  });

  useEffect(() => {
    if (!caseId && casesQuery.data?.[0]) setCaseId(casesQuery.data[0].caseId);
  }, [caseId, casesQuery.data]);

  function validateAndAdd(incoming: FileList | File[]) {
    const accepted: File[] = [];
    const rejected: string[] = [];
    Array.from(incoming).forEach((file) => {
      const supported = ACCEPTED.has(file.type) || ACCEPTED_EXTENSIONS.test(file.name);
      if (!supported) rejected.push(`${file.name}: file type is not supported.`);
      else if (file.size > MAX_BYTES) rejected.push(`${file.name}: exceeds the ${maxUploadMegabytes} MB limit.`);
      else accepted.push(file);
    });
    setFiles((existing) => [...existing, ...accepted.filter((file) => !existing.some((item) => item.name === file.name && item.size === file.size))]);
    setErrors(rejected);
  }

  if (casesQuery.isError) return <ErrorState error={casesQuery.error} retry={() => void casesQuery.refetch()} />;

  return (
    <>
      <Breadcrumbs items={[{ label: "Upload" }]} />
      <PageHeader eyebrow="Evidence intake" title="Upload documents" description={mockMode ? "Add a supported document to a case. Fixture uploads do not run analysis." : "Send supported documents to the configured backend for processing."} />
      <div className="upload-layout">
        <section className="panel upload-panel">
          <div className="section-heading section-heading-tight"><div><h2>Choose files</h2><p>PDF, PNG, JPG or TIFF · up to {maxUploadMegabytes} MB per file</p></div><span className="upload-count">{files.length} selected</span></div>
          <div
            className={`drop-zone ${dragging ? "drop-zone-active" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); validateAndAdd(event.dataTransfer.files); }}
          >
            <span className="drop-icon"><Icon name="upload" size={24} /></span>
            <strong>Drop documents here</strong>
            <span>or choose files from your device</span>
            <Button type="button" variant="secondary" onClick={() => inputRef.current?.click()}>Browse files</Button>
            <input ref={inputRef} type="file" aria-label="Choose documents" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,application/pdf,image/png,image/jpeg,image/tiff" multiple hidden onChange={(event) => event.target.files && validateAndAdd(event.target.files)} />
          </div>
          {errors.length > 0 && <div className="validation-alert" role="alert"><strong>Some files need attention</strong>{errors.map((error) => <p key={error}>{error}</p>)}</div>}
          {files.length > 0 && (
            <div className="selected-files">
              {files.map((file, index) => (
                <div className="selected-file" key={`${file.name}-${file.size}`}>
                  <span className="file-thumb"><Icon name="file" /></span>
                  <span className="selected-file-copy"><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span>
                  <button className="icon-button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((items) => items.filter((_, itemIndex) => itemIndex !== index))}><Icon name="close" size={16} /></button>
                </div>
              ))}
            </div>
          )}
          <div className="upload-case-heading">
            <label className="field-label" htmlFor="target-case">Add to case</label>
            <Button type="button" variant="quiet" onClick={() => setCreatingCase((value) => !value)}>Create case</Button>
          </div>
          <select className="text-input" id="target-case" value={caseId} onChange={(event) => setCaseId(event.target.value)} disabled={casesQuery.isLoading || !casesQuery.data?.length}>
            {(casesQuery.data ?? []).map((item) => <option key={item.caseId} value={item.caseId}>{item.caseId} — {item.title}</option>)}
          </select>
          {creatingCase && (
            <form className="upload-create-case" onSubmit={(event) => {
              event.preventDefault();
              if (newCaseTitle.trim()) createCaseMutation.mutate();
            }}>
              <label className="field-label" htmlFor="upload-case-title">New case title</label>
              <input id="upload-case-title" className="text-input" value={newCaseTitle} onChange={(event) => setNewCaseTitle(event.target.value)} maxLength={200} required />
              {createCaseMutation.isError && <p className="form-error" role="alert">{createCaseMutation.error instanceof Error ? createCaseMutation.error.message : "Could not create case."}</p>}
              <Button type="submit" disabled={createCaseMutation.isPending || !newCaseTitle.trim()}>{createCaseMutation.isPending ? "Creating…" : "Create and select case"}</Button>
            </form>
          )}
          <div className="upload-actions">
            <span className="upload-validation-note"><Icon name="shield" size={15} /> {mockMode ? "Files stay in this local demo." : "Files are sent to the configured backend."}</span>
            <Button disabled={!files.length || !caseId || uploadMutation.isPending} onClick={() => uploadMutation.mutate()}>
              {uploadMutation.isPending ? "Sending…" : `Upload ${files.length || ""} ${files.length === 1 ? "file" : "files"}`}
            </Button>
          </div>
          {uploadMutation.isPending && (
            <div className="upload-transfer" role="status" aria-live="polite">
              <div
                className="upload-transfer-track"
                role="progressbar"
                aria-label="File upload progress"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(uploadProgress === null ? {} : { "aria-valuenow": uploadProgress })}
              >
                <span
                  className={uploadProgress === null ? "upload-transfer-indeterminate" : ""}
                  style={uploadProgress === null ? undefined : { width: `${uploadProgress}%` }}
                />
              </div>
              <span>{uploadProgress === null ? "Sending files…" : uploadProgress === 100 ? "Bytes sent; waiting for server…" : `Uploading files · ${uploadProgress}%`}</span>
            </div>
          )}
          {casesQuery.data?.length === 0 && <p className="form-error">Create a case before uploading files.</p>}
        </section>
        <aside className="upload-aside">
          <div className="notice-card"><span className="notice-icon"><Icon name="shield" /></span><div><h3>{mockMode ? "Fixture-mode behavior" : "Backend processing"}</h3><p>{mockMode ? "This UI validates and accepts files into an in-memory mock only. No OCR, forensic analysis, or new findings are produced." : "Files are sent to the configured backend. Analyzer execution depends on the available server integrations."}</p></div></div>
          <div className="panel upload-guide"><p className="eyebrow">Supported files</p><div><strong>PDF documents</strong><small>Digital or scanned; render preview is available only for recorded fixtures.</small></div><div><strong>Images</strong><small>PNG, JPG, JPEG, TIF and TIFF formats.</small></div><div><strong>Size limit</strong><small>{maxUploadMegabytes} MB maximum per file.</small></div></div>
        </aside>
      </div>
      {activeJobs.length > 0 && (
        <section className="job-panel">
          <div className="section-heading"><div><h2>Upload progress</h2><p>{mockMode ? "Fixture lifecycle only; analysis results are not generated." : "Processing status from the configured backend."}</p></div></div>
          <div className="job-list">{activeJobs.map((job) => <JobProgress key={job.jobId} initialJob={job} onRetry={async () => {
            if (!mockMode) throw new Error("Retry is unavailable because the backend contract does not define a retry endpoint.");
            const { retryFixtureJob } = await import("../mocks/handlers");
            const retried = retryFixtureJob(job.jobId);
            setActiveJobs((items) => items.map((item) => item.jobId === retried.jobId ? retried : item));
          }} mockMode={mockMode} />)}</div>
        </section>
      )}
    </>
  );
}

function JobProgress({ initialJob, onRetry, mockMode }: { initialJob: Job; onRetry: () => Promise<void>; mockMode: boolean }) {
  const queryClient = useQueryClient();
  const jobQuery = useQuery({
    queryKey: ["job", initialJob.jobId],
    queryFn: () => api.getJob(initialJob.jobId),
    initialData: initialJob,
    refetchInterval: (query) => query.state.data?.status === "PARTIAL" || query.state.data?.status === "DONE" || query.state.data?.status === "FAILED" ? false : jobPollIntervalMs,
  });
  const job = jobQuery.data;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  async function retry() {
    setRetryError("");
    setRetrying(true);
    try {
      await onRetry();
      await queryClient.invalidateQueries({ queryKey: ["job", initialJob.jobId] });
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : "The job could not be retried.");
    } finally {
      setRetrying(false);
    }
  }
  const progressWidth = {
    QUEUED: 18,
    RUNNING: 58,
    PARTIAL: 82,
    DONE: 100,
    FAILED: 100,
  }[job?.status ?? "QUEUED"];
  return (
    <article className="job-row">
      <div className="job-row-top"><div><strong>{job?.docId ?? initialJob.docId}</strong><small>{job?.jobId ?? initialJob.jobId} · Attempt {job?.attempts ?? initialJob.attempts} / {job?.maxAttempts ?? initialJob.maxAttempts}</small></div><StatusBadge status={job?.status ?? "QUEUED"} /></div>
      <div className="job-progress-track"><span style={{ width: `${progressWidth}%` }} /></div>
      {mockMode && <p className="job-note">Fixture simulation only. Analyzer outputs are not generated.</p>}
      {mockMode && job?.status === "DONE" && <p className="job-note">The fixture job completed; no new analysis results were produced.</p>}
      {jobQuery.isError && <p className="form-error" role="alert">{jobQuery.error instanceof Error ? jobQuery.error.message : "Job status could not be loaded."}</p>}
      {job?.error && <p className="form-error" role="alert">Job failure: {job.error}</p>}
      <div className="job-analyzers">{job && Object.entries(job.analyzers).map(([name, progress]) => (
        <span key={name} className="job-analyzer">
          <span>{name}</span>
          <span>{progress.state.replaceAll("_", " ")}</span>
          {progress.analyzerStatus && <StatusBadge status={progress.analyzerStatus} />}
          {progress.message && <small>{progress.message}</small>}
        </span>
      ))}</div>
      {retryError && <p className="form-error" role="alert">{retryError}</p>}
      {(job?.status === "PARTIAL" || job?.status === "FAILED") && (mockMode
        ? <Button variant="secondary" onClick={() => void retry()} disabled={retrying || job.attempts >= job.maxAttempts}><Icon name="refresh" size={15} />{retrying ? "Retrying…" : "Retry fixture job"}</Button>
        : <p className="mock-footnote">Retry is unavailable: the backend contract does not define a retry operation.</p>)}
    </article>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
