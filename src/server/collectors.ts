import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import type { Store } from './store.js';

const exec = promisify(execFile);
export const ALLOWED_CONTAINER_FIELDS = ['id', 'name', 'image', 'state', 'health', 'exitCode', 'restartPolicy', 'project', 'service', 'ports', 'networks', 'mounts', 'devices'] as const;

export function sanitizeContainers(input: unknown) {
  if (!Array.isArray(input)) throw new Error('collector payload must be an array');
  return input.map((raw: any) => Object.fromEntries(ALLOWED_CONTAINER_FIELDS.filter(k => raw[k] !== undefined).map(k => [k, raw[k]])));
}

export async function collectDocker(host: string, key: string, knownHosts: string, user = 'pve-atlas') {
  const { stdout } = await exec('ssh', ['-i', key, '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${user}@${host}`], { timeout: 30000, maxBuffer: 2_000_000 });
  return sanitizeContainers(JSON.parse(stdout));
}

export async function probe(url: string) { const r = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'manual' }); return { ok: r.status >= 200 && r.status < 400, status: r.status }; }
export async function notifyNtfy(url: string, topic: string, bearer: string | undefined, title: string, message: string) {
  const headers: Record<string, string> = { title, tags: title.includes('recovery') ? 'white_check_mark' : 'warning' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${url.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`ntfy returned ${response.status}`);
}

type PveResource = { type: string; id?: string; vmid?: number; node?: string; name?: string; status?: string; cpu?: number; maxcpu?: number; mem?: number; maxmem?: number; disk?: number; maxdisk?: number; uptime?: number; storage?: string; plugintype?: string; content?: string; shared?: number };
function pveRequest<T>(base: string, path: string, tokenId: string, tokenSecret: string, caPath?: string) {
  return new Promise<T>((resolve, reject) => {
    const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
    const req = request(url, { headers: { authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` }, ca: caPath ? readFileSync(caPath) : undefined, rejectUnauthorized: process.env.PVE_TLS_INSECURE !== 'true', timeout: 15000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 10_000_000) req.destroy(new Error('PVE response too large')); });
      res.on('end', () => { if ((res.statusCode ?? 500) >= 400) return reject(new Error(`PVE API returned ${res.statusCode}`)); try { resolve(JSON.parse(body).data as T); } catch { reject(new Error('PVE API returned invalid JSON')); } });
    });
    req.on('timeout', () => req.destroy(new Error('PVE API timeout')));
    req.on('error', reject);
    req.end();
  });
}
const percent = (value?: number, max?: number) => max && value !== undefined ? Math.round(value / max * 1000) / 10 : undefined;

export async function collectPve(store: Store, env = process.env) {
  const base = env.PVE_API_URL, tokenId = env.PVE_API_TOKEN_ID, tokenSecret = env.PVE_API_TOKEN_SECRET;
  if (!base || !tokenId || !tokenSecret) throw new Error('PVE collector is not configured');
  const resources = await pveRequest<PveResource[]>(base, 'api2/json/cluster/resources', tokenId, tokenSecret, env.PVE_CA_CERT);
  const seen = new Set<string>();
  store.removeIssuesForUnknownEntities();
  for (const r of resources) {
    if (r.type === 'node' && r.node) {
      const id = `node:${r.node}`; seen.add(id);
      store.updateObserved(id, r.status === 'online' ? 'ok' : 'critical', { observedStatus: r.status, cpuPercent: percent(r.cpu, 1), memoryPercent: percent(r.mem, r.maxmem), uptimeSeconds: r.uptime, dataStale: false, collectorError: null, lastCollectionAttempt: new Date().toISOString() });
    } else if ((r.type === 'lxc' || r.type === 'qemu') && r.vmid !== undefined) {
      const id = `guest:${r.vmid}`; seen.add(id); const running = r.status === 'running';
      const declared = store.updateObserved(id, running ? 'ok' : 'critical', { observedStatus: r.status, observedName: r.name, node: r.node, cpuPercent: percent(r.cpu, 1), memoryPercent: percent(r.mem, r.maxmem), diskPercent: percent(r.disk, r.maxdisk), uptimeSeconds: r.uptime });
      if (declared) store.observe(id, 'pve-guest-stopped', !running, 'critical', running ? 'Guest is running' : `Guest is ${r.status ?? 'unknown'}`);
    } else if (r.type === 'storage' && r.storage) {
      const id = `storage:${r.storage}`; seen.add(id); const available = r.status === 'available';
      const declared = store.updateObserved(id, available ? 'ok' : 'critical', { observedStatus: r.status, storageType: r.plugintype, content: r.content, shared: Boolean(r.shared), diskPercent: percent(r.disk, r.maxdisk) });
      if (declared) store.observe(id, 'pve-storage-unavailable', !available, 'critical', available ? 'Storage is available' : `Storage is ${r.status ?? 'unknown'}`);
    }
  }
  for (const id of store.declaredGuestIds()) { const missing = !seen.has(id); store.observe(id, 'pve-guest-missing', missing, 'critical', missing ? 'Guest is absent from the PVE API' : 'Guest is present in PVE'); }
  store.observe('node:pve', 'pve-collector-failed', false, 'critical', 'PVE collection is healthy');
  return resources.length;
}

export async function collectAllDocker(store: Store, env = process.env) {
  const key = env.DOCKER_COLLECTOR_KEY, knownHosts = env.DOCKER_COLLECTOR_KNOWN_HOSTS;
  if (!key || !knownHosts) throw new Error('Docker collectors are not configured');
  const targets = store.guestTargets().filter(t => t.address && t.application && t.application !== 'pve_atlas' && t.application !== 'tailscale');
  const rootVmids = new Set((env.DOCKER_COLLECTOR_ROOT_VMIDS ?? '').split(',').map(Number));
  const results = await Promise.allSettled(targets.map(async target => {
    const containers = await collectDocker(String(target.address), key, knownHosts, rootVmids.has(target.vmid) ? 'root' : 'pve-atlas');
    store.replaceDockerObservation(target.vmid, containers);
    store.observe(target.id, 'docker-collector-failed', false, 'warning', 'Docker collection is healthy');
    return containers.length;
  }));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const target = targets[index], message = result.reason instanceof Error ? result.reason.message : 'unknown Docker collector error';
      store.updateMetadata(target.id, undefined, { dockerCollectorStatus: 'error', dockerCollectorError: message, dockerCollectionAttempt: new Date().toISOString() });
      store.observe(target.id, 'docker-collector-failed', true, 'warning', `Docker collection failed for ${target.label}: ${message}`, message);
    }
  });
  return { targets: targets.length, successful: results.filter(r => r.status === 'fulfilled').length };
}

async function dispatchNotifications(store: Store, env = process.env) {
  if (!env.NTFY_URL || !env.NTFY_TOPIC) return;
  for (const item of store.pendingNotifications()) {
    await notifyNtfy(env.NTFY_URL, env.NTFY_TOPIC, env.NTFY_TOKEN, item.title, `${item.message}\n${item.issueId}`);
    store.markNotificationSent(item.id);
  }
}

export function schedule(store: Store, env = process.env) {
  store.prune();
  let pveCollecting = false, dockerCollecting = false;
  const pvePoll = async () => { if (pveCollecting) return; pveCollecting = true; try { await collectPve(store, env); } catch (error) { const message = error instanceof Error ? error.message : 'unknown PVE collection error'; store.updateMetadata('node:pve', 'critical', { dataStale: true, collectorError: message, lastCollectionAttempt: new Date().toISOString() }); store.observe('node:pve', 'pve-collector-failed', true, 'critical', message, message); } finally { pveCollecting = false; await dispatchNotifications(store, env).catch(error => console.error('notification delivery failed', error)); } };
  const dockerPoll = async () => { if (dockerCollecting || env.DOCKER_COLLECTION_ENABLED !== 'true') return; dockerCollecting = true; try { await collectAllDocker(store, env); } catch (error) { console.error('Docker collection failed', error); } finally { dockerCollecting = false; await dispatchNotifications(store, env).catch(error => console.error('notification delivery failed', error)); } };
  void pvePoll(); void dockerPoll();
  const pveInterval = Math.max(15, Number(env.PVE_POLL_INTERVAL_SECONDS ?? 60)) * 1000;
  const dockerInterval = Math.max(30, Number(env.DOCKER_POLL_INTERVAL_SECONDS ?? 120)) * 1000;
  return [setInterval(() => void pvePoll(), pveInterval), setInterval(() => void dockerPoll(), dockerInterval), setInterval(() => store.prune(), 86400000)];
}
