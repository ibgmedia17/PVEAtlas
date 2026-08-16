import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Entity, Issue, Relation, Topology } from './types.js';

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,label TEXT NOT NULL,parent TEXT,status TEXT,metadata TEXT NOT NULL,observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relations(id TEXT PRIMARY KEY,source TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,code TEXT NOT NULL,severity TEXT NOT NULL,state TEXT NOT NULL,message TEXT NOT NULL,failures INTEGER NOT NULL,fingerprint TEXT NOT NULL,opened_at TEXT,updated_at TEXT NOT NULL,resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,entity_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_queue(id INTEGER PRIMARY KEY,issue_id TEXT NOT NULL,state TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,sent_at TEXT);
      CREATE INDEX IF NOT EXISTS history_time ON history(recorded_at);
      CREATE INDEX IF NOT EXISTS notification_unsent ON notification_queue(sent_at);
    `);
  }

  importDeclaration(path: string) {
    const model = JSON.parse(readFileSync(path, 'utf8')) as { entities: Entity[]; relations: Relation[] };
    const now = new Date().toISOString();
    const entity = this.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,parent=excluded.parent,metadata=json_patch(entities.metadata,excluded.metadata)');
    const relation = this.db.prepare('INSERT OR REPLACE INTO relations VALUES(?,?,?,?)');
    for (const e of model.entities) entity.run(e.id, e.kind, e.label, e.parent ?? null, e.status ?? 'unknown', JSON.stringify(e.metadata ?? {}), now);
    for (const r of model.relations) relation.run(r.id, r.source, r.target, r.kind);
  }

  topology(): Topology {
    const entities = this.db.prepare('SELECT * FROM entities ORDER BY kind,label').all().map((r: any) => ({ id: r.id, kind: r.kind, label: r.label, parent: r.parent ?? undefined, status: r.status, metadata: JSON.parse(r.metadata) }));
    const relations = this.db.prepare('SELECT * FROM relations ORDER BY id').all() as unknown as Relation[];
    return { generatedAt: new Date().toISOString(), entities, relations };
  }

  entity(id: string) {
    const r = this.db.prepare('SELECT * FROM entities WHERE id=?').get(id) as any;
    return r ? { id: r.id, kind: r.kind, label: r.label, parent: r.parent, status: r.status, metadata: JSON.parse(r.metadata) } : undefined;
  }

  issues() { return this.db.prepare('SELECT id,entity_id entityId,code,severity,state,message,failures,fingerprint,opened_at openedAt,updated_at updatedAt,resolved_at resolvedAt FROM issues ORDER BY CASE state WHEN \'open\' THEN 0 WHEN \'pending\' THEN 1 ELSE 2 END, updated_at DESC').all() as unknown as Issue[]; }
  history(limit = 500) { return this.db.prepare('SELECT id,entity_id entityId,kind,payload,recorded_at recordedAt FROM history ORDER BY recorded_at DESC LIMIT ?').all(limit); }

  updateObserved(entityId: string, status: Entity['status'], observed: Record<string, unknown>) {
    const row = this.db.prepare('SELECT status,metadata FROM entities WHERE id=?').get(entityId) as any;
    if (!row) return false;
    const metadata = { ...JSON.parse(row.metadata), ...observed, lastObservedAt: new Date().toISOString() };
    this.db.prepare('UPDATE entities SET status=?,metadata=?,observed_at=? WHERE id=?').run(status ?? 'unknown', JSON.stringify(metadata), metadata.lastObservedAt, entityId);
    return true;
  }

  updateMetadata(entityId: string, status: Entity['status'], values: Record<string, unknown>) {
    const row = this.db.prepare('SELECT status,metadata FROM entities WHERE id=?').get(entityId) as any;
    if (!row) return false;
    this.db.prepare('UPDATE entities SET status=?,metadata=? WHERE id=?').run(status ?? row.status ?? 'unknown', JSON.stringify({ ...JSON.parse(row.metadata), ...values }), entityId);
    return true;
  }

  declaredGuestIds() { return (this.db.prepare("SELECT id FROM entities WHERE kind='guest'").all() as { id: string }[]).map(row => row.id); }
  guestTargets() { return this.db.prepare("SELECT id,label,metadata FROM entities WHERE kind='guest'").all().map((r: any) => ({ id: r.id, vmid: Number(r.id.slice(6)), label: r.label, ...JSON.parse(r.metadata) })) as { id: string; vmid: number; label: string; address?: string; application?: string }[]; }
  removeIssuesForUnknownEntities() { this.db.prepare('DELETE FROM issues WHERE entity_id NOT IN (SELECT id FROM entities)').run(); }

  replaceDockerObservation(vmid: number, containers: Record<string, unknown>[]) {
    const prefix = `container:${vmid}:`;
    const endpointPrefix = `endpoint:${vmid}:`;
    const oldIds = this.db.prepare("SELECT id FROM entities WHERE id LIKE ? OR id LIKE ?").all(`${prefix}%`, `${endpointPrefix}%`) as { id: string }[];
    for (const { id } of oldIds) {
      this.db.prepare('DELETE FROM relations WHERE source=? OR target=?').run(id, id);
      this.db.prepare('DELETE FROM entities WHERE id=?').run(id);
    }
    const now = new Date().toISOString();
    const insertEntity = this.db.prepare('INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?,?,?)');
    const insertRelation = this.db.prepare('INSERT OR REPLACE INTO relations VALUES(?,?,?,?)');
    for (const raw of containers) {
      const name = String(raw.name ?? String(raw.id).slice(0, 12));
      const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '-');
      const id = `${prefix}${safeName}`;
      const running = raw.state === 'running';
      const completed = raw.state === 'exited' && raw.exitCode === 0 && (raw.restartPolicy === 'no' || raw.restartPolicy === '' || raw.restartPolicy === 'on-failure');
      const healthy = raw.health === undefined || raw.health === null || raw.health === 'healthy';
      const status: Entity['status'] = (!running && !completed) || raw.health === 'unhealthy' ? 'critical' : healthy ? 'ok' : 'warning';
      insertEntity.run(id, 'container', name, `guest:${vmid}`, status, JSON.stringify({ ...raw, vmid, lastObservedAt: now }), now);
      insertRelation.run(`guest-container-${vmid}-${safeName}`, `guest:${vmid}`, id, 'runs');
      const ports = Array.isArray(raw.ports) ? raw.ports as { container?: string; host?: string[] }[] : [];
      for (const port of ports) for (const hostPort of port.host ?? []) {
        const endpointId = `${endpointPrefix}${safeName}-${hostPort}`;
        insertEntity.run(endpointId, 'endpoint', `${name}:${hostPort}`, id, running ? 'ok' : 'critical', JSON.stringify({ hostPort, containerPort: port.container, address: this.guestTargets().find(g => g.vmid === vmid)?.address, lastObservedAt: now }), now);
        insertRelation.run(`container-endpoint-${vmid}-${safeName}-${hostPort}`, id, endpointId, 'publishes');
      }
      this.observe(id, 'docker-container-state', !running && !completed, 'critical', running ? `${name} is running` : completed ? `${name} completed successfully` : `${name} is ${String(raw.state ?? 'unknown')}`);
      if (raw.health !== undefined && raw.health !== null) this.observe(id, 'docker-container-health', raw.health === 'unhealthy', 'critical', `${name} health is ${String(raw.health)}`);
    }
    this.updateMetadata(`guest:${vmid}`, undefined, { dockerCollectorStatus: 'ok', dockerContainerCount: containers.length, dockerObservedAt: now });
  }

  observe(entityId: string, code: string, failed: boolean, severity: Issue['severity'], message: string, fingerprint = message) {
    const id = `${entityId}:${code}`, now = new Date().toISOString();
    const old = this.db.prepare('SELECT * FROM issues WHERE id=?').get(id) as any;
    const failures = failed ? (old?.failures ?? 0) + 1 : 0;
    const state: Issue['state'] = failed ? (failures >= 2 ? 'open' : 'pending') : 'resolved';
    const openedAt = state === 'open' ? (old?.opened_at ?? now) : old?.opened_at ?? null;
    const resolvedAt = !failed && old && old.state !== 'resolved' ? now : old?.resolved_at ?? null;
    this.db.prepare('INSERT INTO issues VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET severity=excluded.severity,state=excluded.state,message=excluded.message,failures=excluded.failures,fingerprint=excluded.fingerprint,opened_at=excluded.opened_at,updated_at=excluded.updated_at,resolved_at=excluded.resolved_at').run(id, entityId, code, severity, state, message, failures, fingerprint, openedAt, now, resolvedAt);
    if (!old || old.state !== state || old.fingerprint !== fingerprint) this.db.prepare('INSERT INTO history(entity_id,kind,payload,recorded_at) VALUES(?,?,?,?)').run(entityId, 'issue-transition', JSON.stringify({ code, state, message }), now);
    const notify = state === 'open' && old?.state !== 'open' || state === 'resolved' && old?.state === 'open' || old?.state === 'open' && old.fingerprint !== fingerprint;
    if (notify) this.db.prepare('INSERT INTO notification_queue(issue_id,state,title,message,created_at) VALUES(?,?,?,?,?)').run(id, state, state === 'resolved' ? 'Atlas recovery' : `Atlas ${severity}`, message, now);
    return { notify, state };
  }

  pendingNotifications() { return this.db.prepare('SELECT id,issue_id issueId,state,title,message FROM notification_queue WHERE sent_at IS NULL ORDER BY id LIMIT 50').all() as { id: number; issueId: string; state: string; title: string; message: string }[]; }
  markNotificationSent(id: number) { this.db.prepare('UPDATE notification_queue SET sent_at=? WHERE id=?').run(new Date().toISOString(), id); }
  prune(days = 90) { this.db.prepare("DELETE FROM history WHERE recorded_at < datetime('now', ?)").run(`-${days} days`); this.db.prepare("DELETE FROM notification_queue WHERE sent_at < datetime('now', ?)").run(`-${days} days`); }
  backup(path: string) { this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`); }
  close() { this.db.close(); }
}
