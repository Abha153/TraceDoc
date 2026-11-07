import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FindingDetail, ReviewRequest } from "../../../contracts/api";
import { api } from "../api/client";
import { StatusBadge, Button, Icon } from "./ui";
import { Timeline } from "./Timeline";
import { reviewErrorMessage, validateReview } from "../lib/review";

/**
 * Analyst review. Nothing is optimistic: the panel waits for the server and shows the review status the server derived.
 * The machine observation status is displayed unchanged next to it and is never edited by a review.
 */
export function ReviewPanel({ detail }: { detail: FindingDetail }) {
  const queryClient = useQueryClient();
  const findingId = detail.finding.findingId;
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [message, setMessage] = useState("");
  const [lastAction, setLastAction] = useState<ReviewRequest["action"]>("CONFIRM");

  const mutation = useMutation({
    mutationFn: (body: ReviewRequest) => api.review(findingId, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(["finding", findingId], updated);
      setReason("");
      setComment("");
      setMessage("");
    },
    onError: (error) => {
      setMessage(reviewErrorMessage(error, lastAction));
      void queryClient.invalidateQueries({ queryKey: ["finding", findingId] });
    },
    onSettled: async () => {
      await Promise.all(["findings", "events", "dossier", "case-summaries"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });

  function submit(body: ReviewRequest) {
    setMessage("");
    const problem = validateReview(body);
    if (problem) { setMessage(problem); return; }
    setLastAction(body.action);
    mutation.mutate(body);
  }
  const busy = mutation.isPending;
  return (
    <section className="panel review-panel" aria-label="Analyst review">
      <div className="review-panel-heading"><span className="review-heading-icon"><Icon name="user" /></span><div><h2>Analyst review</h2><p>Recorded separately from the machine observation, which never changes.</p></div></div>
      <div className="review-status-pair">
        <div><small>Machine observation</small><StatusBadge status={detail.finding.observationStatus} /></div>
        <div><small>Review state (from server)</small><StatusBadge status={detail.reviewStatus} /></div>
      </div>
      <div className="review-actions">
        <Button onClick={() => submit({ action: "CONFIRM" })} disabled={busy}><Icon name="check" size={16} /> Confirm observation</Button>
        <Button variant="secondary" onClick={() => submit({ action: "INCONCLUSIVE" })} disabled={busy}>Mark inconclusive</Button>
        <label className="field-label" htmlFor={`dismiss-${findingId}`}>Reason for dismissal</label>
        <textarea id={`dismiss-${findingId}`} className="text-input textarea" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} placeholder="Required to dismiss" />
        <Button variant="danger" onClick={() => submit({ action: "DISMISS", reason })} disabled={busy}>Dismiss with reason</Button>
        {detail.reviewStatus !== "UNREVIEWED" && <Button variant="quiet" onClick={() => submit({ action: "REOPEN" })} disabled={busy}>Reopen review</Button>}
      </div>
      <div className="comment-box">
        <label className="field-label" htmlFor={`comment-${findingId}`}>Add a comment</label>
        <textarea id={`comment-${findingId}`} className="text-input textarea" value={comment} onChange={(event) => setComment(event.target.value)} rows={2} />
        <Button variant="secondary" onClick={() => submit({ action: "COMMENT", comment })} disabled={busy}>Post comment</Button>
      </div>
      {busy && <p className="muted-text" role="status">Saving to the server…</p>}
      {message && <p className="form-error" role="alert">{message}</p>}
      <div className="review-history">
        <div className="section-line"><h3>Review history</h3><span className="muted-text">{detail.reviewHistory.length} events</span></div>
        <Timeline events={detail.reviewHistory} empty="No review activity recorded yet." />
      </div>
    </section>
  );
}
