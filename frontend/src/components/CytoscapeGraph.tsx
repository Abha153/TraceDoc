import { useEffect, useRef, useState } from "react";
import type { GraphNode, GraphResponse } from "../../../contracts/api";
import type { Core } from "cytoscape";

export function CytoscapeGraph({
  graph,
  onSelectNode,
}: {
  graph: GraphResponse;
  onSelectNode: (node: GraphNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectNodeRef = useRef(onSelectNode);
  const graphRef = useRef<Core | null>(null);
  const [loadError, setLoadError] = useState("");
  selectNodeRef.current = onSelectNode;

  useEffect(() => {
    let disposed = false;
    setLoadError("");
    void import("cytoscape").then(({ default: cytoscape }) => {
      if (disposed || !containerRef.current) return;
      const cy = cytoscape({
        container: containerRef.current,
        elements: [
          ...graph.nodes.map((node) => ({
            group: "nodes" as const,
            data: { ...node },
          })),
          ...graph.edges.map((edge) => ({
            group: "edges" as const,
            data: { ...edge },
          })),
        ],
        layout: { name: "cose", animate: false, randomize: false, padding: 32 },
        style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "text-wrap": "wrap",
            "text-max-width": "130px",
            "text-valign": "center",
            "text-halign": "center",
            color: "#f7f8fa",
            "font-size": 11,
            "font-weight": 600,
            width: 150,
            height: 58,
            shape: "round-rectangle",
            "background-color": "#263b52",
            "border-width": 2,
            "border-color": "#55718e",
          },
        },
        {
          selector: 'node[kind = "document"]',
          style: { "background-color": "#1b746d", "border-color": "#57b6a7" },
        },
        {
          selector: 'node[kind = "entity"]',
          style: { "background-color": "#564a83", "border-color": "#9b8bc7" },
        },
        {
          selector: 'node[resolution = "SUGGESTED"]',
          style: { "border-color": "#e8b65d", "border-style": "dashed" },
        },
        {
          selector: 'node[resolution = "UNRESOLVED"]',
          style: { "border-color": "#ef7a73", "border-width": 4 },
        },
        {
          selector: "node:selected",
          style: { "border-color": "#ffffff", "border-width": 4 },
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "line-color": "#75879b",
            "target-arrow-color": "#75879b",
          },
        },
        {
          selector: 'edge[kind = "suggested"]',
          style: { "line-style": "dashed", "line-color": "#d69a37", "target-arrow-color": "#d69a37" },
        },
        {
          selector: 'edge[kind = "conflict"]',
          style: { "line-color": "#d36f65", "target-arrow-color": "#d36f65", width: 3 },
        },
        {
          selector: 'edge[kind = "match"]',
          style: { "line-color": "#46a89a", "target-arrow-color": "#46a89a" },
        },
        ],
      });
      graphRef.current = cy;
      cy.on("tap", "node", (event) => {
        const selected = graph.nodes.find((node) => node.id === event.target.id());
        if (selected) selectNodeRef.current(selected);
      });
    }).catch((error: unknown) => {
      if (!disposed) setLoadError(error instanceof Error ? error.message : "The relationship graph could not be loaded.");
    });
    return () => {
      disposed = true;
      graphRef.current?.destroy();
      graphRef.current = null;
    };
  }, [graph]);

  return (
    <>
      <div ref={containerRef} className="cytoscape-graph" role="img" aria-label="Interactive document and entity relationship graph" />
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
    </>
  );
}
