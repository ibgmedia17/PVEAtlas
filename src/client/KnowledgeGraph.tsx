import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';

type Entity = { id: string; kind: string; label: string; parent?: string; status?: string; metadata?: Record<string, unknown> };
type Relation = { id: string; source: string; target: string; kind: string };
type Topology = { generatedAt: string; entities: Entity[]; relations: Relation[] };

const MAX_VISIBLE = 60;

export function KnowledgeGraph({ model, rootId, onSelect, theme }: { model: Topology; rootId: string; onSelect: (entity: Entity) => void; theme: 'atlas' | 'sakura' | 'sakura-dark' }) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const positions = useRef(new Map<string, cytoscape.Position>());
  const [expanded, setExpanded] = useState(() => new Set([rootId]));
  useEffect(() => setExpanded(new Set([rootId])), [rootId]);

  const graph = useMemo(() => {
    const relationIds = new Set(model.relations.map(r => `${r.source}\0${r.target}`));
    const relations = [...model.relations];
    for (const entity of model.entities) if (entity.parent && !relationIds.has(`${entity.parent}\0${entity.id}`)) relations.push({ id: `parent:${entity.parent}:${entity.id}`, source: entity.parent, target: entity.id, kind: 'contains' });
    const neighbors = new Map<string, Set<string>>();
    const add = (a: string, b: string) => { if (!neighbors.has(a)) neighbors.set(a, new Set()); neighbors.get(a)!.add(b); };
    for (const relation of relations) { add(relation.source, relation.target); add(relation.target, relation.source); }
    const visible = new Set([rootId]);
    for (const id of expanded) for (const neighbor of neighbors.get(id) ?? []) { if (visible.size < MAX_VISIBLE) visible.add(neighbor); }
    const entities = model.entities.filter(entity => visible.has(entity.id));
    return { entities, relations: relations.filter(r => visible.has(r.source) && visible.has(r.target)), neighbors, limited: visible.size >= MAX_VISIBLE };
  }, [model, rootId, expanded]);

  useEffect(() => {
    if (!container.current) return;
    const visibleIds = new Set(graph.entities.map(entity => entity.id));
    const elements = [
      ...graph.entities.map(entity => { const hidden = [...(graph.neighbors.get(entity.id) ?? [])].filter(id => !visibleIds.has(id)).length; return { data: { ...entity, displayLabel: hidden ? `${entity.label}  +${hidden}` : entity.label, focused: entity.id === rootId ? 'yes' : 'no', expanded: expanded.has(entity.id) ? 'yes' : 'no' }, position: positions.current.get(entity.id) }; }),
      ...graph.relations.map(relation => ({ data: relation }))
    ];
    const sakura = theme !== 'atlas';
    const sakuraDark = theme === 'sakura-dark';
    const cy = cytoscape({ container: container.current, elements, minZoom: .2, maxZoom: 3, wheelSensitivity: .12, userPanningEnabled: true, userZoomingEnabled: true, autoungrabify: false, boxSelectionEnabled: false, style: [
      { selector: 'node', style: { label: 'data(displayLabel)', width: 38, height: 38, shape: 'ellipse', 'background-color': sakura ? '#d95f88' : '#38bdf8', 'border-width': 2, 'border-color': sakura ? '#a83f67' : '#173946', color: sakuraDark ? '#f8dbe5' : sakura ? '#522539' : '#dce9ef', 'font-size': 10, 'font-weight': 600, 'text-valign': 'bottom', 'text-margin-y': 8, 'text-background-color': sakuraDark ? '#1d1118' : sakura ? '#fff8fb' : '#071219', 'text-background-opacity': .9, 'text-background-padding': 3, 'overlay-opacity': 0 } },
      { selector: 'node[focused="yes"]', style: { width: 58, height: 58, 'border-width': 4, 'border-color': '#e3f1f5', 'font-size': 12 } },
      { selector: 'node[expanded="yes"]', style: { 'border-color': sakura ? '#c74273' : '#2dd4bf' } },
      { selector: 'node[kind="guest"]', style: { 'background-color': sakura ? '#f09ab6' : '#2dd4bf', shape: 'round-rectangle' } },
      { selector: 'node[kind="container"]', style: { 'background-color': '#a78bfa', shape: 'round-rectangle' } },
      { selector: 'node[kind="storage"]', style: { 'background-color': '#38bdf8', shape: 'barrel' } },
      { selector: 'node[kind="network"]', style: { 'background-color': '#60a5fa', shape: 'diamond' } },
      { selector: 'node[status="critical"]', style: { 'background-color': '#fb7185' } },
      { selector: 'node[status="warning"]', style: { 'background-color': '#fbbf24' } },
      { selector: 'edge', style: { width: 1.2, label: 'data(kind)', color: sakuraDark ? '#c99aaa' : sakura ? '#8b6070' : '#66838f', 'font-size': 8, 'text-background-color': sakuraDark ? '#1d1118' : sakura ? '#fff8fb' : '#071219', 'text-background-opacity': .85, 'text-background-padding': 2, 'line-color': sakuraDark ? '#704454' : sakura ? '#d6a7b8' : '#365363', 'target-arrow-color': sakuraDark ? '#704454' : sakura ? '#d6a7b8' : '#365363', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', opacity: .75 } }
    ] as any });
    cyRef.current = cy;
    const known = graph.entities.filter(entity => positions.current.has(entity.id)).length;
    const layout = known === graph.entities.length ? cy.layout({ name: 'preset', fit: false }) : cy.layout({ name: 'cose', animate: false, fit: true, padding: 65, randomize: known === 0, nodeRepulsion: () => 18000, idealEdgeLength: () => 120, gravity: .2, componentSpacing: 100 });
    layout.run();
    cy.on('tap', 'node', event => { const entity = event.target.data() as Entity; const hasHidden = [...(graph.neighbors.get(entity.id) ?? [])].some(id => !visibleIds.has(id)); if (hasHidden) setExpanded(current => new Set(current).add(entity.id)); else onSelect(entity); });
    cy.on('cxttap', 'node', event => onSelect(event.target.data() as Entity));
    const resize = () => cy.resize(); const observer = new ResizeObserver(resize); observer.observe(container.current);
    return () => { observer.disconnect(); cy.nodes().forEach(node => { positions.current.set(node.id(), node.position()); }); cyRef.current = null; cy.destroy(); };
  }, [graph, expanded, onSelect, rootId, theme]);

  const zoom = (factor: number) => { const cy = cyRef.current, el = container.current; if (!cy || !el) return; cy.zoom({ level: Math.max(cy.minZoom(), Math.min(cy.maxZoom(), cy.zoom() * factor)), renderedPosition: { x: el.clientWidth / 2, y: el.clientHeight / 2 } }); };
  const fit = () => { const cy = cyRef.current; if (!cy) return; cy.resize(); cy.fit(cy.elements(), 65); };
  return <div className="graph-shell"><div className="graph" ref={container} /><div className="graph-controls"><button type="button" onClick={() => zoom(1.3)}>+</button><button type="button" onClick={() => zoom(1 / 1.3)}>−</button><button type="button" className="fit" onClick={fit}>Fit</button><button type="button" className="fit" onClick={() => { positions.current.clear(); setExpanded(new Set([rootId])); }}>Reset</button></div><div className="graph-hint">Click nodes to reveal connections · drag nodes or canvas · scroll to zoom · right-click for details{graph.limited ? ` · limited to ${MAX_VISIBLE} nodes` : ''}</div></div>;
}
