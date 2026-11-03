import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import type { EventsResponse, FindingDetail, FindingsResponse } from "@contracts/api";
import type { InvestigationEvent, Job } from "@contracts/types";
import { drain, expectMatchesContract, loggedInAgent, testApp, uploadFixtureDocs } from "./helpers.js";
import { JsonlEventLog, deriveReviewStatus } from "../src/services/eventLog.js";
import { applyOverrides } from "../src/repo/overrides.js";
import type { AnalyzeResponse } from "@contracts/types";

const sha = async (f: string) => createHash("sha256").update(await readFile(f)).digest("hex");
const ev = (type: InvestigationEvent["type"], payload: Record<string, unknown> = {}, targetId = "F-1"): InvestigationEvent => ({
  eventId: "IE-0001", caseId: "C", at: "2026-11-01T09:00:00Z", actor: "analyst", type, targetId, payload,
});
const F1 = "CASE-001-g1-F-0001";
const F2 = "CASE-001-g1-F-0002";

/** CASE-001 analysed and reasoned over (stub mode = recorded fixture output), with a controllable clock for the log. */
async function loaded(over: Record<string, string> = {}) {
  let ms = Date.parse("2026-11-01T09:00:00.000Z");
  const clock = { advance: (s: number) => void (ms += s * 1000) };
  const t = await testApp({ REASONING_MODE: "stub", ...over }, { eventsNow: () => new Date(ms) });
  const agent = await loggedInAgent(t.app);
  await agent.post("/api/v1/cases").send({ title: "Review case" }).expect(201);
  const mapping = await uploadFixtureDocs(t.deps, agent, "CASE-001", ["D-01.png", "D-02.png", "D-03.pdf"]);
  return { ...t, agent, mapping, clock };
}

describe("deriveReviewStatus (replay)", () => {
  it("starts UNREVIEWED and follows REVIEW and REOPEN in order", () => {
    expect(deriveReviewStatus([])).toBe("UNREVIEWED");
    expect(deriveReviewStatus([ev("REVIEW", { status: "CONFIRMED" })])).toBe("CONFIRMED");
    expect(deriveReviewStatus([ev("REVIEW", { status: "DISMISSED", reason: "x" }), ev("REVIEW", { status: "INCONCLUSIVE" })])).toBe("INCONCLUSIVE");
    expect(deriveReviewStatus([ev("REVIEW", { status: "DISMISSED", reason: "x" }), ev("REOPEN")])).toBe("UNREVIEWED");
    expect(deriveReviewStatus([ev("REVIEW", { status: "DISMISSED", reason: "x" }), ev("REOPEN"), ev("REVIEW", { status: "CONFIRMED" })])).toBe("CONFIRMED");
  });
  it("comments, views and unknown statuses change nothing", () => {
    expect(deriveReviewStatus([ev("COMMENT", { text: "hm" }), ev("VIEW"), ev("UPLOAD")])).toBe("UNREVIEWED");
    expect(deriveReviewStatus([ev("REVIEW", { status: "CONFIRMED" }), ev("COMMENT", { text: "hm" }), ev("VIEW")])).toBe("CONFIRMED");
    expect(deriveReviewStatus([ev("REVIEW", { status: "CONFIRMED" }), ev("REVIEW", { status: "FRAUD" })])).toBe("CONFIRMED");
  });
});

describe("JsonlEventLog", () => {
  const mk = async (now = () => new Date("2026-11-01T09:00:00.000Z")) => {
    const dir = await mkdtemp(path.join(tmpdir(), "td-log-"));
    return { dir, log: new JsonlEventLog(dir, now) };
  };

  it("assigns sequential ids and timestamps, one JSON line each, and survives a restart", async () => {
    const { dir, log } = await mk();
    const a = await log.append({ caseId: "C1", actor: "analyst", type: "UPLOAD", targetId: "D-a", payload: { filename: "a.pdf" } });
    const b = await log.append({ caseId: "C1", actor: "analyst", type: "COMMENT", targetId: "F-1", payload: { text: "t" } });
    expect([a.eventId, b.eventId]).toEqual(["IE-0001", "IE-0002"]);
    expect(a.at).toBe("2026-11-01T09:00:00.000Z");
    const lines = (await readFile(log.filePath, "utf8")).trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l).eventId)).toEqual(["IE-0001", "IE-0002"]);
    const again = new JsonlEventLog(dir);
    expect((await again.forCase("C1")).map((e) => e.eventId)).toEqual(["IE-0001", "IE-0002"]);
    expect((await again.append({ caseId: "C1", actor: "a", type: "VIEW", targetId: "x", payload: {} })).eventId).toBe("IE-0003");
  });

  it("is append-only: earlier bytes never change", async () => {
    const { log } = await mk();
    await log.append({ caseId: "C", actor: "a", type: "UPLOAD", targetId: "D-1", payload: {} });
    const before = await readFile(log.filePath, "utf8");
    for (let i = 0; i < 5; i++) await log.append({ caseId: "C", actor: "a", type: "COMMENT", targetId: "F-1", payload: { text: String(i) } });
    expect((await readFile(log.filePath, "utf8")).startsWith(before)).toBe(true);
  });

  it("keeps every event valid and ids unique under concurrent appends", async () => {
    const { log } = await mk();
    const out = await Promise.all(Array.from({ length: 25 }, (_, i) => log.append({ caseId: "C", actor: "a", type: "COMMENT", targetId: "F-1", payload: { i } })));
    expect(new Set(out.map((e) => e.eventId)).size).toBe(25);
    const lines = (await readFile(log.filePath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(25);
    for (const l of lines) JSON.parse(l);
  });

  it("refuses to load a log with a corrupt line in the middle (audit data is never silently dropped)", async () => {
    const { dir, log } = await mk();
    await log.append({ caseId: "C", actor: "a", type: "UPLOAD", targetId: "D-1", payload: {} });
    await appendFile(log.filePath, "{ not json\n");
    await log.append({ caseId: "C", actor: "a", type: "UPLOAD", targetId: "D-2", payload: {} }).catch(() => undefined);
    const fresh = new JsonlEventLog(dir);
    await expect(fresh.forCase("C")).rejects.toThrow(/corrupt at line 2/);
  });

  it("recovers from an unfinished last line (crash mid-write): complete events kept, fragment set aside, file clean again", async () => {
    const { dir, log } = await mk();
    await log.append({ caseId: "C", actor: "a", type: "UPLOAD", targetId: "D-1", payload: {} });
    const complete = await readFile(log.filePath, "utf8");
    const fragment = '{"eventId":"IE-0002","caseId":"C","at":"2026';
    await appendFile(log.filePath, fragment); // no newline: crashed mid-write
    const after = new JsonlEventLog(dir);
    expect((await after.forCase("C")).map((e) => e.eventId)).toEqual(["IE-0001"]);
    expect(await readFile(log.filePath, "utf8")).toBe(complete); // the garbage is gone from the log
    expect(await readFile(path.join(dir, "events.jsonl.discarded"), "utf8")).toBe(fragment + "\n"); // but not lost
    const next = await after.append({ caseId: "C", actor: "a", type: "UPLOAD", targetId: "D-2", payload: {} });
    expect(next.eventId).toBe("IE-0002");
    // a later restart loads everything without complaint
    expect((await new JsonlEventLog(dir).forCase("C")).map((e) => e.targetId)).toEqual(["D-1", "D-2"]);
  });

  it("recovers when the very first event was the one cut off", async () => {
    const { dir, log } = await mk();
    await appendFile(path.join(dir, "events.jsonl"), '{"eventId":"IE-0001"').catch(async () => {
      await writeFile(path.join(dir, "events.jsonl"), '{"eventId":"IE-0001"');
    });
    const fresh = new JsonlEventLog(dir);
    expect(await fresh.forCase("C")).toEqual([]);
    expect(await readFile(log.filePath, "utf8")).toBe("");
    expect((await fresh.append({ caseId: "C", actor: "a", type: "UPLOAD", targetId: "D-1", payload: {} })).eventId).toBe("IE-0001");
  });

  it("dedupes VIEW events within a minute per actor and target", async () => {
    let t = Date.parse("2026-11-01T09:00:00Z");
    const { log } = await mk(() => new Date(t));
    expect(await log.recordView("C", "a", "F-1")).toBeDefined();
    t += 59_000;
    expect(await log.recordView("C", "a", "F-1")).toBeUndefined();
    expect(await log.recordView("C", "a", "F-2")).toBeDefined(); // different target
    expect(await log.recordView("C", "b", "F-1")).toBeDefined(); // different actor
    t += 2_000;
    expect(await log.recordView("C", "a", "F-1")).toBeDefined();
  });
});

describe("POST /findings/:id/review", () => {
  it("requires login", async () => {
    const { app } = await testApp();
    expect((await request(app).post(`/api/v1/findings/${F1}/review`).send({ action: "CONFIRM" })).status).toBe(401);
  });

  it("DISMISS needs a reason: missing, empty and whitespace-only are all 400, and nothing is logged", async () => {
    const { agent, deps } = await loaded();
    for (const body of [{ action: "DISMISS" }, { action: "DISMISS", reason: "" }, { action: "DISMISS", reason: "   " }]) {
      const res = await agent.post(`/api/v1/findings/${F1}/review`).send(body).expect(400);
      expect(res.body.error.code).toBe("REASON_REQUIRED");
    }
    expect((await deps.events.forTarget(F1)).filter((e) => e.type === "REVIEW")).toEqual([]);
    const ok = await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "DISMISS", reason: "Middle name abbreviated" }).expect(200);
    expectMatchesContract("FindingDetail", ok.body);
    expect(ok.body.reviewStatus).toBe("DISMISSED");
    expect(ok.body.reviewHistory).toEqual([
      expect.objectContaining({ type: "REVIEW", actor: "analyst", targetId: F1, payload: { status: "DISMISSED", reason: "Middle name abbreviated" } }),
    ]);
  });

  it("COMMENT needs text and does not change the status", async () => {
    const { agent } = await loaded();
    expect((await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "COMMENT" }).expect(400)).body.error.code).toBe("COMMENT_REQUIRED");
    await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "COMMENT", comment: "  " }).expect(400);
    const res = await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "COMMENT", comment: "Checking the scan" }).expect(200);
    expect(res.body.reviewStatus).toBe("UNREVIEWED");
    expect(res.body.reviewHistory).toEqual([expect.objectContaining({ type: "COMMENT", payload: { text: "Checking the scan" } })]);
  });

  it("CONFIRM and INCONCLUSIVE set the status (reason optional)", async () => {
    const { agent } = await loaded();
    expect((await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "CONFIRM" }).expect(200)).body.reviewStatus).toBe("CONFIRMED");
    const inc = await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "INCONCLUSIVE", reason: "Scan too blurry" }).expect(200);
    expect(inc.body.reviewStatus).toBe("INCONCLUSIVE");
    expect(inc.body.reviewHistory.map((e: InvestigationEvent) => e.payload["status"])).toEqual(["CONFIRMED", "INCONCLUSIVE"]);
  });

  it("REOPEN returns a reviewed finding to UNREVIEWED and keeps the whole history; reopening an unreviewed one is 409", async () => {
    const { agent } = await loaded();
    expect((await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "REOPEN" }).expect(409)).body.error.code).toBe("ALREADY_UNREVIEWED");
    await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "DISMISS", reason: "looks fine" }).expect(200);
    const res = await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "REOPEN", reason: "second look" }).expect(200);
    expect(res.body.reviewStatus).toBe("UNREVIEWED");
    expect(res.body.reviewHistory.map((e: InvestigationEvent) => e.type)).toEqual(["REVIEW", "REOPEN"]);
    expect(res.body.reviewHistory[1].payload).toEqual({ previousStatus: "DISMISSED", reason: "second look" });
    const again = await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "CONFIRM" }).expect(200);
    expect(again.body.reviewStatus).toBe("CONFIRMED");
    expect(again.body.reviewHistory).toHaveLength(3);
  });

  it("the machine observation is unchanged after any review: finding object and the stored generation file", async () => {
    const { agent, deps } = await loaded();
    const file = path.join(deps.storage.recordsDir, "evidence", "CASE-001", "gen-0001.json");
    const before = (await deps.evidence.findFinding(F1))!.finding;
    const fileBefore = await sha(file);
    for (const body of [
      { action: "CONFIRM" }, { action: "COMMENT", comment: "x" }, { action: "DISMISS", reason: "y" },
      { action: "REOPEN" }, { action: "INCONCLUSIVE" },
    ]) await agent.post(`/api/v1/findings/${F1}/review`).send(body).expect(200);
    const detail = (await agent.get(`/api/v1/findings/${F1}`).expect(200)).body as FindingDetail;
    expect(detail.finding).toEqual(before);
    expect(detail.finding.observationStatus).toBe("INCONSISTENT");
    expect(await sha(file)).toBe(fileBefore);
    expect(detail.reviewStatus).toBe("INCONCLUSIVE");
  });

  it("is reflected in the findings list and its reviewStatus filter", async () => {
    const { agent } = await loaded();
    await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "CONFIRM" }).expect(200);
    await agent.post(`/api/v1/findings/${F2}/review`).send({ action: "DISMISS", reason: "same person" }).expect(200);
    const all = (await agent.get("/api/v1/cases/CASE-001/findings").expect(200)).body as FindingsResponse;
    const status = Object.fromEntries(all.findings.map((f) => [f.finding.findingId, f.reviewStatus]));
    expect(status[F1]).toBe("CONFIRMED");
    expect(status[F2]).toBe("DISMISSED");
    expect(Object.values(status).filter((s) => s === "UNREVIEWED")).toHaveLength(all.findings.length - 2);
    const dismissed = (await agent.get("/api/v1/cases/CASE-001/findings?reviewStatus=DISMISSED").expect(200)).body as FindingsResponse;
    expect(dismissed.findings.map((f) => f.finding.findingId)).toEqual([F2]);
    const open = (await agent.get("/api/v1/cases/CASE-001/findings?reviewStatus=UNREVIEWED").expect(200)).body as FindingsResponse;
    expect(open.findings.length).toBe(all.findings.length - 2);
  });

  it("survives a restart: statuses are replayed from the log on disk", async () => {
    const first = await loaded();
    await first.agent.post(`/api/v1/findings/${F1}/review`).send({ action: "DISMISS", reason: "r" }).expect(200);
    await first.agent.post(`/api/v1/findings/${F2}/review`).send({ action: "CONFIRM" }).expect(200);
    const second = await testApp({ DATA_DIR: first.config.dataDir });
    const agent2 = await loggedInAgent(second.app);
    const res = (await agent2.get("/api/v1/cases/CASE-001/findings").expect(200)).body as FindingsResponse;
    expect(res.findings.find((f) => f.finding.findingId === F1)!.reviewStatus).toBe("DISMISSED");
    expect(res.findings.find((f) => f.finding.findingId === F2)!.reviewStatus).toBe("CONFIRMED");
  });

  it("validates the request: unknown action, unknown keys, unknown finding", async () => {
    const { agent } = await loaded();
    await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "APPROVE" }).expect(400);
    await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "CONFIRM", status: "CONFIRMED" }).expect(400);
    await agent.post(`/api/v1/findings/${F1}/review`).send({}).expect(400);
    expect((await agent.post("/api/v1/findings/CASE-001-g1-F-9999/review").send({ action: "CONFIRM" }).expect(404)).body.error.code).toBe("FINDING_NOT_FOUND");
  });

  it("an older generation cannot be reviewed (409); the new generation starts unreviewed", async () => {
    const { agent } = await loaded();
    await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "CONFIRM" }).expect(200);
    await agent.post("/api/v1/cases/CASE-001/recompute").expect(200);
    expect((await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "DISMISS", reason: "r" }).expect(409)).body.error.code).toBe("STALE_GENERATION");
    // the old finding still shows what was decided about it
    expect(((await agent.get(`/api/v1/findings/${F1}`).expect(200)).body as FindingDetail).reviewStatus).toBe("CONFIRMED");
    const fresh = (await agent.get("/api/v1/findings/CASE-001-g2-F-0001").expect(200)).body as FindingDetail;
    expect(fresh.reviewStatus).toBe("UNREVIEWED");
    await agent.post("/api/v1/findings/CASE-001-g2-F-0001/review").send({ action: "CONFIRM" }).expect(200);
  });
});

describe("GET /cases/:id/events and the logging done by the other routes", () => {
  it("lists UPLOAD events (one per document), RERUN and REVIEW events in order", async () => {
    const { agent, mapping } = await loaded();
    await agent.post(`/api/v1/findings/${F1}/review`).send({ action: "CONFIRM" }).expect(200);
    await agent.post("/api/v1/cases/CASE-001/recompute").expect(200);
    const res = await agent.get("/api/v1/cases/CASE-001/events").expect(200);
    expectMatchesContract("EventsResponse", res.body);
    const events = (res.body as EventsResponse).events;
    expect(events.map((e) => e.type)).toEqual(["UPLOAD", "UPLOAD", "UPLOAD", "REVIEW", "RERUN"]);
    expect(events.map((e) => e.eventId)).toEqual(["IE-0001", "IE-0002", "IE-0003", "IE-0004", "IE-0005"]);
    expect(events.slice(0, 3).map((e) => e.targetId)).toEqual([mapping["D-01"], mapping["D-02"], mapping["D-03"]]);
    expect(events[0]!.payload).toMatchObject({ filename: "D-01.png", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), jobId: "JOB-0001" });
    expect(events[4]).toMatchObject({ targetId: "CASE-001", payload: { cause: "recompute", generation: 2 } });
    expect(events.every((e) => e.actor === "analyst" && e.caseId === "CASE-001")).toBe(true);
  });

  it("only returns the events of that case; 404 for an unknown case; 401 without login", async () => {
    const { agent, app } = await loaded();
    await agent.post("/api/v1/cases").send({ title: "other" }).expect(201);
    expect(((await agent.get("/api/v1/cases/CASE-002/events").expect(200)).body as EventsResponse).events).toEqual([]);
    expect((await agent.get("/api/v1/cases/CASE-404/events").expect(404)).body.error.code).toBe("CASE_NOT_FOUND");
    expect((await request(app).get("/api/v1/cases/CASE-001/events")).status).toBe(401);
  });

  it("logs a VIEW when a finding or document is opened, at most once a minute, and keeps VIEW out of the review history", async () => {
    const { agent, clock, mapping } = await loaded();
    const viewsOf = async () => ((await agent.get("/api/v1/cases/CASE-001/events")).body as EventsResponse).events.filter((e) => e.type === "VIEW");
    await agent.get(`/api/v1/findings/${F1}`).expect(200);
    await agent.get(`/api/v1/findings/${F1}`).expect(200);
    expect((await viewsOf()).map((e) => e.targetId)).toEqual([F1]);
    await agent.get(`/api/v1/documents/${mapping["D-01"]}`).expect(200);
    clock.advance(61);
    await agent.get(`/api/v1/findings/${F1}`).expect(200);
    expect((await viewsOf()).map((e) => e.targetId)).toEqual([F1, mapping["D-01"], F1]);
    const detail = (await agent.get(`/api/v1/findings/${F1}`).expect(200)).body as FindingDetail;
    expect(detail.reviewHistory).toEqual([]);
    // lists and renders are not logged
    await agent.get("/api/v1/cases/CASE-001/findings").expect(200);
    await agent.get(`/api/v1/documents/${mapping["D-01"]}/pages/1/render`).expect(200);
    expect((await viewsOf()).length).toBe(3);
  });
});

describe("PATCH /documents/:docId/pages/:n/type (reclassify)", () => {
  const patch = (agent: Awaited<ReturnType<typeof loggedInAgent>>, docId: string, n: number | string, body: object) =>
    agent.patch(`/api/v1/documents/${docId}/pages/${n}/type`).send(body);

  async function real() {
    // default engine mode: reasoning really runs after each re-analysis
    const t = await testApp({}, {});
    const agent = await loggedInAgent(t.app);
    await agent.post("/api/v1/cases").send({ title: "Reclassify" }).expect(201);
    const mapping = await uploadFixtureDocs(t.deps, agent, "CASE-001", ["D-01.png", "D-02.png", "D-03.pdf"]);
    return { ...t, agent, mapping, doc: mapping["D-03"]! };
  }

  it("logs it, stores the correction, queues a forced re-run (202 Job) and re-reasons when it finishes", async () => {
    const { agent, deps, doc } = await real();
    expect((await deps.evidence.latest("CASE-001"))!.generation).toBe(1);

    const res = await patch(agent, doc, 1, { docType: "other", reason: "It is an account summary, not a statement" }).expect(202);
    expectMatchesContract("Job", res.body);
    expect(res.body).toMatchObject({ docId: doc, status: "QUEUED", forced: true });

    const events = (await agent.get("/api/v1/cases/CASE-001/events").expect(200)).body.events as InvestigationEvent[];
    const reclass = events.find((e) => e.type === "RECLASSIFY")!;
    expect(reclass).toMatchObject({
      targetId: doc, actor: "analyst",
      payload: { page: 1, from: "bank_statement", to: "other", machineDocType: "bank_statement", reason: "It is an account summary, not a statement" },
    });
    expect(events.find((e) => e.type === "RERUN" && e.targetId === doc)!.payload).toMatchObject({ jobId: res.body.jobId, cause: "reclassify" });

    await drain(deps);
    expect(((await agent.get(`/api/v1/jobs/${res.body.jobId}`).expect(200)).body as Job).status).toBe("DONE");
    expect((await deps.evidence.latest("CASE-001"))!.generation).toBe(2); // reasoning ran again by itself
  });

  it("the effective page type changes everywhere, while the machine's own output is untouched", async () => {
    const { agent, deps, doc } = await real();
    await patch(agent, doc, 1, { docType: "other" }).expect(202);
    const detail = (await agent.get(`/api/v1/documents/${doc}`).expect(200)).body;
    expect(detail.pages[0]).toMatchObject({ docType: "other", docTypeConfidence: 1 });
    expect((await agent.get("/api/v1/cases/CASE-001/graph").expect(200)).body.nodes.find((n: { id: string }) => n.id === doc)).toMatchObject({ docType: "other" });
    const raw = (await deps.analysis.getRaw(doc))!;
    expect(raw.pages[0]).toMatchObject({ docType: "bank_statement" });
    expect(raw.pages[0]!.docTypeConfidence).toBeLessThan(1);
    expect((await deps.overrides.get(doc))!.pages["1"]).toMatchObject({ docType: "other", machineDocType: "bank_statement", by: "analyst" });
    // and it survives the re-run
    await drain(deps);
    expect(((await agent.get(`/api/v1/documents/${doc}`)).body).pages[0].docType).toBe("other");
    expect((await deps.analysis.getRaw(doc))!.pages[0]!.docType).toBe("bank_statement");
  });

  it("can be changed back; asking for the type the page already has is 400", async () => {
    const { agent, deps, doc } = await real();
    await patch(agent, doc, 1, { docType: "other" }).expect(202);
    await drain(deps);
    expect((await patch(agent, doc, 1, { docType: "other" }).expect(400)).body.error.code).toBe("NO_CHANGE");
    await patch(agent, doc, 1, { docType: "bank_statement" }).expect(202);
    expect((await patch(agent, doc, 1, { docType: "bank_statement" }).expect(400)).body.error.code).toBe("NO_CHANGE");
    expect(((await agent.get(`/api/v1/documents/${doc}`)).body).pages[0].docType).toBe("bank_statement");
  });

  it("while a re-run is already queued the same job is returned, and only one RERUN is logged", async () => {
    const { agent, doc } = await real();
    const a = await patch(agent, doc, 1, { docType: "other" }).expect(202);
    const b = await patch(agent, doc, 1, { docType: "UNKNOWN" }).expect(202);
    expect(b.body.jobId).toBe(a.body.jobId);
    const events = (await agent.get("/api/v1/cases/CASE-001/events")).body.events as InvestigationEvent[];
    expect(events.filter((e) => e.type === "RECLASSIFY")).toHaveLength(2);
    expect(events.filter((e) => e.type === "RERUN" && e.targetId === doc)).toHaveLength(1);
  });

  it("rejects bad input: type, page, document, no analysis yet, and needs login", async () => {
    const { agent, app, mapping, deps } = await real();
    const d = mapping["D-01"]!;
    await patch(agent, d, 1, { docType: "passport" }).expect(400);
    await patch(agent, d, 1, {}).expect(400);
    await patch(agent, d, 1, { docType: "other", extra: 1 }).expect(400);
    await patch(agent, d, 0, { docType: "other" }).expect(400);
    expect((await patch(agent, d, 2, { docType: "other" }).expect(404)).body.error.code).toBe("PAGE_NOT_FOUND");
    expect((await patch(agent, "D-nope", 1, { docType: "other" }).expect(404)).body.error.code).toBe("DOCUMENT_NOT_FOUND");
    const up = await agent.post("/api/v1/cases/CASE-001/documents").attach("files", Buffer.from("%PDF-1.4\nunknown\n%%EOF"), "x.pdf").expect(202);
    await drain(deps);
    expect((await patch(agent, up.body.documents[0].docId, 1, { docType: "other" }).expect(404)).body.error.code).toBe("PAGE_NOT_FOUND");
    expect((await request(app).patch(`/api/v1/documents/${d}/pages/1/type`).send({ docType: "other" })).status).toBe(401);
    // nothing was logged for any of the rejected requests
    const events = (await agent.get("/api/v1/cases/CASE-001/events")).body.events as InvestigationEvent[];
    expect(events.filter((e) => e.type === "RECLASSIFY")).toEqual([]);
  });

  it("applyOverrides is pure and leaves other pages alone", () => {
    const resp = {
      docId: "D", pipelineVersion: "1", fields: [], signals: [], analyzerStatuses: {}, provenance: [],
      pages: [
        { docId: "D", page: 1, renderPath: "x", renderDpi: 150, rotationDeg: 0, deskewDeg: 0, docType: "id_card", docTypeConfidence: 0.8 },
        { docId: "D", page: 2, renderPath: "y", renderDpi: 150, rotationDeg: 0, deskewDeg: 0, docType: "id_card", docTypeConfidence: 0.8 },
      ],
    } as AnalyzeResponse;
    const out = applyOverrides(resp, { docId: "D", pages: { "2": { docType: "other", machineDocType: "id_card", machineConfidence: 0.8, by: "a", at: "t" } } });
    expect(out.pages.map((p) => p.docType)).toEqual(["id_card", "other"]);
    expect(out.pages[1]!.docTypeConfidence).toBe(1);
    expect(resp.pages[1]!.docType).toBe("id_card");
    expect(applyOverrides(resp, undefined)).toBe(resp);
  });
});
