import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import type { GraphNode } from "../../../contracts/api";
import type { EntityRole } from "../../../contracts/types";
import { api } from "../api/client";
import { CytoscapeGraph } from "../components/CytoscapeGraph";
import { Breadcrumbs, EmptyState, ErrorState, Icon, LoadingState, PageHeader, StatusBadge } from "../components/ui";

const roleLabel: Record<EntityRole, string> = {
  applicant: "Applicant",
  co_applicant: "Co-applicant",
  guarantor: "Guarantor",
  nominee: "Nominee",
  account_holder: "Account holder",
  unknown: "Unknown role",
};

export function EntitiesPage({ caseId: fixedCaseId, embedded = false }: { caseId?: string; embedded?: boolean } = {}) {
  const [caseId, setCaseId] = useState(fixedCaseId ?? "CASE-001");
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const casesQuery = useQuery({ queryKey: ["cases"], queryFn: api.listCases });
  const cases = casesQuery.data ?? [];
  const activeCaseId = fixedCaseId ?? (cases.some((item) => item.caseId === caseId) ? caseId : cases[0]?.caseId ?? "");
  const entityQuery = useQuery({ queryKey: ["entities", activeCaseId], queryFn: () => api.entities(activeCaseId), enabled: Boolean(activeCaseId) });
  const assertionQuery = useQuery({ queryKey: ["assertions", activeCaseId], queryFn: () => api.assertions(activeCaseId), enabled: Boolean(activeCaseId) });
  const graphQuery = useQuery({ queryKey: ["graph", activeCaseId], queryFn: () => api.graph(activeCaseId), enabled: Boolean(activeCaseId) });
  const entities = entityQuery.data?.entities ?? [];
  const assertions = assertionQuery.data?.assertions ?? [];
  const graph = graphQuery.data;
  const filteredEntities = entities.filter((entity) =>
    `${entity.entityId} ${entity.role} ${entity.resolution} ${entity.basis.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selected = filteredEntities.find((entity) => entity.entityId === selectedEntity) ?? filteredEntities[0];
  const groups = useMemo(() => {
    const related = selected ? assertions.filter((assertion) => selected.assertionIds.includes(assertion.assertionId)) : assertions;
    return related.reduce<Record<string, typeof assertions>>((result, assertion) => {
      (result[assertion.semanticType] ??= []).push(assertion);
      return result;
    }, {});
  }, [assertions, selected]);
  const graphNodes = graph?.nodes ?? [];
  const selectGraphNode = useCallback((node: GraphNode) => {
    if (node.kind === "entity") {
      setSelectedEntity(node.id);
      return;
    }
    const region = assertions.find((assertion) => assertion.docId === node.id)?.region;
    navigate(`/documents/${encodeURIComponent(node.id)}`, { state: { region } });
  }, [assertions, navigate]);

  if (casesQuery.isLoading || entityQuery.isLoading || assertionQuery.isLoading || graphQuery.isLoading) return <LoadingState label="Loading entities and assertions" />;
  const error = casesQuery.error ?? entityQuery.error ?? assertionQuery.error ?? graphQuery.error;
  if (error) return <ErrorState error={error} retry={() => {
    void entityQuery.refetch(); void assertionQuery.refetch(); void graphQuery.refetch();
  }} />;
  if (entities.length === 0) return <EmptyState title="No entities recorded" detail="Entity links appear when fixture assertions are available for this case." />;

  return (
    <>
      {!embedded && <Breadcrumbs items={[{ label: "Entities" }]} />}
      {!embedded && <PageHeader eyebrow="Contextual evidence" title="Entities & assertions" description="Resolved and suggested links stay distinct. Similar names alone do not merge people." actions={<select className="compact-select" value={activeCaseId} onChange={(event) => { setCaseId(event.target.value); setSelectedEntity(null); }} aria-label="Select case">{cases.map((item) => <option key={item.caseId} value={item.caseId}>{item.caseId}</option>)}</select>} />}
      <div className="entity-layout">
        <section className="panel entity-list-panel">
          <div className="section-heading section-heading-tight"><div><h2>Case entities</h2><p>{entities.length} entity records</p></div></div>
          <div className="search-field entity-search"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an entity" aria-label="Find entity" /></div>
          <div className="entity-list">{filteredEntities.length === 0 ? <p className="entity-no-results" role="status">No entities match this search.</p> : filteredEntities.map((entity) => (
            <button className={`entity-card ${selected.entityId === entity.entityId ? "entity-card-selected" : ""}`} key={entity.entityId} onClick={() => setSelectedEntity(entity.entityId)}>
              <span className="entity-avatar">{roleLabel[entity.role]?.[0] ?? "?"}</span>
              <span className="entity-copy"><strong>{roleLabel[entity.role] ?? entity.role}</strong><small>{entity.entityId} · {entity.assertionIds.length} assertions</small></span>
              <StatusBadge status={entity.resolution} />
            </button>
          ))}</div>
          <div className="resolution-key"><p>Resolution states</p><span><i className="resolution-dot resolved" /> Strong identifier match</span><span><i className="resolution-dot suggested" /> Suggested only; not merged</span><span><i className="resolution-dot unresolved" /> Unresolved link</span></div>
        </section>
        <section className="panel graph-panel">
          <div className="section-heading section-heading-tight"><div><h2>Relationship map</h2><p>Click a document node to inspect its recorded page.</p></div></div>
          {graph && <CytoscapeGraph graph={graph} onSelectNode={selectGraphNode} />}
          <div className="graph-legend" aria-label="Relationship map legend"><span><i className="graph-swatch graph-doc-swatch" /> Document</span><span><i className="graph-swatch graph-entity-swatch" /> Entity</span><span><i className="edge-match" /> Match</span><span><i className="edge-conflict" /> Conflict</span><span><i className="edge-dashed" /> Suggested</span></div>
          <div className="graph-node-links" aria-label="Keyboard-accessible graph items">{graphNodes.map((node) => (
            <button type="button" className="graph-node-link" key={node.id} onClick={() => selectGraphNode(node)}>
              <span>{node.kind}: {node.label}</span>
              {node.resolution && <StatusBadge status={node.resolution} />}
              {node.kind === "document" && <span className="text-link">Open recorded region</span>}
            </button>
          ))}</div>
        </section>
      </div>
      {selected ? <section className="panel assertions-panel">
        <div className="section-heading"><div><p className="eyebrow">{selected.entityId} · {roleLabel[selected.role]}</p><h2>Assertions by semantic type</h2><p>Values are extracted claims, not ground truth.</p></div><StatusBadge status={selected.resolution} /></div>
        <div className="assertion-groups">{Object.entries(groups).map(([semanticType, items]) => (
          <div className="assertion-group" key={semanticType}>
            <div className="assertion-type"><strong>{semanticType.replaceAll("_", " ")}</strong><span>{items.length} values</span></div>
            <div className="assertion-rows">{items.map((assertion) => {
              const document = graphNodes.find((node): node is GraphNode & { kind: "document" } => node.kind === "document" && node.id === assertion.docId);
              return (
                <div className="assertion-row" key={assertion.assertionId}>
                  <span className="assertion-doc-icon"><Icon name="file" size={16} /></span>
                  <span className="assertion-value"><strong>{assertion.normalizedValue ?? "Value unavailable"}</strong><small>{assertion.assertionId} · {assertion.entityRole}</small></span>
                  <span className="assertion-confidence">{Math.round(assertion.extractionConfidence * 100)}%<small>extraction</small></span>
                  <Link className="button button-quiet button-small" to={`/documents/${assertion.docId}`} state={{ region: assertion.region }} aria-label={`Open ${document?.label ?? assertion.docId} region`}>View region <Icon name="arrow" size={14} /></Link>
                </div>
              );
            })}</div>
          </div>
        ))}</div>
        {selected.basis.length > 0 && <div className="entity-basis"><strong>Resolution basis</strong>{selected.basis.map((basis) => <span key={basis}>{basis}</span>)}</div>}
      </section> : <EmptyState title="No entity selected" detail="No entity matches this search. Clear the search to review the recorded assertions." />}
    </>
  );
}
