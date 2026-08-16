import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type DiscoveredPct = { vmid: number; status: string; name: string; address?: string; docker?: boolean; collector?: boolean };

async function helper(command: string, env = process.env) {
  if (!env.PVE_ENROLLMENT_ENABLED || env.PVE_ENROLLMENT_ENABLED !== 'true') throw new Error('PCT enrollment is disabled');
  const key = env.DOCKER_COLLECTOR_KEY, knownHosts = env.DOCKER_COLLECTOR_KNOWN_HOSTS, host = env.PVE_ENROLLMENT_HOST;
  if (!key || !knownHosts || !host) throw new Error('PCT enrollment helper is not configured');
  const { stdout } = await exec('ssh', ['-i', key, '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `root@${host}`, command], { timeout: 120000, maxBuffer: 1_000_000 });
  return JSON.parse(stdout);
}
export async function discoverPcts(env = process.env) { const value = await helper('discover', env); if (!Array.isArray(value)) throw new Error('invalid discovery response'); return value as DiscoveredPct[]; }
export async function enrollPct(vmid: number, env = process.env) { if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999999999) throw new Error('invalid VMID'); return helper(`enroll ${vmid}`, env) as Promise<DiscoveredPct>; }
