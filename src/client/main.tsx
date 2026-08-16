import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import cytoscape from 'cytoscape';
import './style.css';

type Entity = { id: string; kind: string; label: string; parent?: string; status?: string; metadata?: Record<string, unknown> };
type Issue = { id: string; entityId: string; code: string; severity: string; state: string; message: string; failures: number; updatedAt: string };
type Topology = { generatedAt: string; entities: Entity[]; relations: { id: string; source: string; target: string; kind: string }[] };
type View = 'overview' | 'topology' | 'guests' | 'services' | 'storage' | 'alerts';

async function api(path: string, init?: RequestInit) { const r = await fetch(path, init); if (!r.ok) throw new Error(String(r.status)); return r.status === 204 ? null : r.json(); }
const value = (v: unknown) => v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
const age = (stamp: unknown) => { if (!stamp) return 'never'; const seconds = Math.max(0, Math.floor((Date.now() - new Date(String(stamp)).getTime()) / 1000)); return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`; };
const pct = (v: unknown) => typeof v === 'number' ? `${v.toFixed(1)}%` : '—';

function Status({ status = 'unknown' }: { status?: string }) { return <span className={`status ${status}`}><i />{status}</span>; }
function Meter({ number }: { number: unknown }) { const n = typeof number === 'number' ? number : 0; return <span className="meter"><i style={{ width: `${Math.min(100, n)}%` }} /><b>{pct(number)}</b></span>; }

function Graph({ model, query, onSelect }: { model: Topology; query: string; onSelect: (e: Entity) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const matches = (e: Entity) => !query || `${e.label} ${e.id}`.toLowerCase().includes(query.toLowerCase());
    const visible = model.entities.filter(e => matches(e) || e.kind === 'node' || e.kind === 'guest');
    const ids = new Set(visible.map(e => e.id));
    const cy = cytoscape({ container: ref.current, elements: [...visible.map(e => ({ data: e })), ...model.relations.filter(r => ids.has(r.source) && ids.has(r.target)).map(r => ({ data: r }))], layout: { name: 'cose', animate: false, nodeRepulsion: () => 9000 }, style: [{ selector: 'node', style: { label: 'data(label)', 'background-color': '#38bdf8', color: '#dce9ef', 'font-size': 10, 'text-valign': 'bottom', 'text-margin-y': 7 } }, { selector: 'node[kind="guest"]', style: { shape: 'round-rectangle', width: 34, height: 22, 'background-color': '#2dd4bf' } }, { selector: 'node[kind="container"]', style: { width: 19, height: 19, 'background-color': '#a78bfa' } }, { selector: 'node[status="critical"]', style: { 'background-color': '#fb7185' } }, { selector: 'node[status="warning"]', style: { 'background-color': '#fbbf24' } }, { selector: 'edge', style: { width: 1, 'line-color': '#365363', 'target-arrow-color': '#365363', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', opacity: .7 } }] });
    cy.on('tap', 'node', event => onSelect(event.target.data() as Entity));
    return () => cy.destroy();
  }, [model, query, onSelect]);
  return <div className="graph" ref={ref} />;
}

function EntityTable({ entities, onSelect }: { entities: Entity[]; onSelect: (e: Entity) => void }) {
  return <div className="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Host / type</th><th>CPU</th><th>Memory</th><th>Disk</th><th>Observed</th></tr></thead><tbody>{entities.map(e => <tr key={e.id} onClick={() => onSelect(e)}><td><strong>{e.label}</strong><small>{e.id}</small></td><td><Status status={e.status} /></td><td>{value(e.metadata?.image ?? e.metadata?.observedName ?? e.metadata?.storageType ?? e.kind)}</td><td><Meter number={e.metadata?.cpuPercent} /></td><td><Meter number={e.metadata?.memoryPercent} /></td><td><Meter number={e.metadata?.diskPercent} /></td><td>{age(e.metadata?.lastObservedAt)}</td></tr>)}</tbody></table>{entities.length === 0 && <div className="empty">No matching entities</div>}</div>;
}

function App() {
  const [model, setModel] = useState<Topology | null>(null), [issues, setIssues] = useState<Issue[]>([]), [view, setView] = useState<View>('overview'), [query, setQuery] = useState(''), [selected, setSelected] = useState<Entity | null>(null), [auth, setAuth] = useState(true), [password, setPassword] = useState(''), [error, setError] = useState(''), [refreshing, setRefreshing] = useState(false), [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const load = useCallback(async () => { setRefreshing(true); try { const [m, i] = await Promise.all([api('/api/v1/topology'), api('/api/v1/issues')]); setModel(m); setIssues(i); setAuth(true); setError(''); setLastRefresh(new Date()); } catch (e) { if (String(e).includes('401')) setAuth(false); else setError('Atlas could not refresh live data'); } finally { setRefreshing(false); } }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15000); return () => clearInterval(timer); }, [load]);
  const entities = model?.entities ?? [];
  const filtered = useCallback((kind: string) => entities.filter(e => e.kind === kind && `${e.label} ${e.id} ${JSON.stringify(e.metadata)}`.toLowerCase().includes(query.toLowerCase())), [entities, query]);
  const guests = filtered('guest'), containers = filtered('container'), storages = filtered('storage'), endpoints = filtered('endpoint');
  const activeIssues = issues.filter(i => i.state === 'open' || i.state === 'pending');
  const stats = useMemo(() => ({ guests: entities.filter(e => e.kind === 'guest').length, running: entities.filter(e => e.kind === 'guest' && e.status === 'ok').length, containers: entities.filter(e => e.kind === 'container').length, unhealthy: entities.filter(e => e.kind === 'container' && e.status !== 'ok').length, issues: issues.filter(i => i.state === 'open').length }), [entities, issues]);
  const node = entities.find(e => e.kind === 'node');
  if (!auth) return <main className="login"><form onSubmit={async e => { e.preventDefault(); try { await api('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) }); setAuth(true); setPassword(''); void load(); } catch { setPassword(''); setError('Credential rejected'); } }}><span className="eyebrow">PVE ATLAS</span><h1>Operations console</h1><p>Sign in to inspect live infrastructure health.</p>{error && <div className="form-error">{error}</div>}<input aria-label="Administrator password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoFocus /><button>Sign in</button></form></main>;
  return <div className="app">
    <header><div className="brand"><span className="mark">A</span><span><b>PVE Atlas</b><small>LIVE OPERATIONS</small></span></div><div className="header-state"><span className={`live-dot ${node?.metadata?.dataStale ? 'stale' : ''}`} />{node?.metadata?.dataStale ? 'DATA STALE' : 'LIVE'}<button className="refresh" onClick={() => void load()} disabled={refreshing}>{refreshing ? 'Refreshing…' : `Refresh · ${lastRefresh ? age(lastRefresh.toISOString()) : 'never'}`}</button></div></header>
    <aside className="nav"><label>SEARCH<input placeholder="Guest, container, image…" value={query} onChange={e => setQuery(e.target.value)} /></label><nav>{(['overview', 'topology', 'guests', 'services', 'storage', 'alerts'] as View[]).map(v => <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}><span>{v === 'overview' ? '◫' : v === 'topology' ? '⌘' : v === 'guests' ? '▣' : v === 'services' ? '◆' : v === 'storage' ? '▤' : '!'}</span>{v}<b>{v === 'guests' ? stats.guests : v === 'services' ? stats.containers : v === 'alerts' ? activeIssues.length : ''}</b></button>)}</nav><div className="collector"><span>COLLECTORS</span><p><Status status={node?.status} /> Proxmox API</p><p><Status status={stats.containers ? 'ok' : 'unknown'} /> Docker SSH</p><small>PVE: {age(node?.metadata?.lastObservedAt)}</small></div></aside>
    <main className="content">{error && <div className="banner">{error}</div>}
      {view === 'overview' && <><div className="title"><div><span className="eyebrow">INFRASTRUCTURE</span><h1>Operations overview</h1></div><Status status={stats.issues ? 'critical' : 'ok'} /></div><section className="stats"><article><span>GUESTS ONLINE</span><strong>{stats.running}<small> / {stats.guests}</small></strong></article><article><span>CONTAINERS</span><strong>{stats.containers}</strong><small>{stats.unhealthy} need attention</small></article><article><span>OPEN ISSUES</span><strong>{stats.issues}</strong><small>{activeIssues.length - stats.issues} pending</small></article><article><span>PVE CPU</span><strong>{pct(node?.metadata?.cpuPercent)}</strong><Meter number={node?.metadata?.cpuPercent} /></article></section><div className="overview-grid"><section className="panel"><div className="panel-head"><h2>Guest health</h2><button onClick={() => setView('guests')}>View all</button></div><EntityTable entities={guests.slice(0, 8)} onSelect={setSelected} /></section><section className="panel issues-panel"><div className="panel-head"><h2>Active issues</h2><button onClick={() => setView('alerts')}>History</button></div>{activeIssues.length ? activeIssues.slice(0, 8).map(i => <button className="issue-row" key={i.id} onClick={() => setSelected(entities.find(e => e.id === i.entityId) ?? null)}><Status status={i.severity} /><span>{i.message}<small>{i.entityId} · {age(i.updatedAt)}</small></span></button>) : <div className="empty healthy">✓ All observed systems nominal</div>}</section></div></>}
      {view === 'topology' && <><div className="title"><div><span className="eyebrow">RELATIONSHIPS</span><h1>Live topology</h1></div><span>{entities.length} entities · {model?.relations.length ?? 0} links</span></div><section className="panel graph-panel">{model && <Graph model={model} query={query} onSelect={setSelected} />}</section></>}
      {view === 'guests' && <><div className="title"><div><span className="eyebrow">PROXMOX</span><h1>Guests</h1></div><span>{guests.length} shown</span></div><EntityTable entities={guests} onSelect={setSelected} /></>}
      {view === 'services' && <><div className="title"><div><span className="eyebrow">DOCKER</span><h1>Services & endpoints</h1></div><span>{containers.length} containers · {endpoints.length} endpoints</span></div><EntityTable entities={containers} onSelect={setSelected} /></>}
      {view === 'storage' && <><div className="title"><div><span className="eyebrow">CAPACITY</span><h1>Storage</h1></div></div><EntityTable entities={storages} onSelect={setSelected} /></>}
      {view === 'alerts' && <><div className="title"><div><span className="eyebrow">EVENTS</span><h1>Alerts</h1></div><span>{stats.issues} open</span></div><section className="panel alerts-list">{issues.map(i => <button key={i.id} onClick={() => setSelected(entities.find(e => e.id === i.entityId) ?? null)}><Status status={i.state === 'resolved' ? 'ok' : i.severity} /><span><strong>{i.message}</strong><small>{i.code} · {i.entityId}</small></span><time>{i.state}<small>{age(i.updatedAt)}</small></time></button>)}</section></>}
    </main>
    {selected && <aside className="drawer"><button className="close" onClick={() => setSelected(null)}>×</button><span className="eyebrow">ENTITY DETAIL</span><h2>{selected.label}</h2><Status status={selected.status} /><dl><dt>TYPE</dt><dd>{selected.kind}</dd><dt>IDENTIFIER</dt><dd>{selected.id}</dd>{Object.entries(selected.metadata ?? {}).map(([k, v]) => <React.Fragment key={k}><dt>{k.replace(/([A-Z])/g, ' $1').toUpperCase()}</dt><dd>{Array.isArray(v) || typeof v === 'object' && v !== null ? <code>{JSON.stringify(v)}</code> : value(v)}</dd></React.Fragment>)}</dl></aside>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
