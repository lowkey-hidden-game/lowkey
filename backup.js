// backup.js - full identity DB backup. Export -> AES-256-GCM encrypt -> push to GitHub branch 'backups'.
// The repo is PUBLIC, so backups are ALWAYS encrypted; the passphrase lives only in env (BACKUP_KEY).
// Retention: keep the newest 8 backups on the branch. Periodic runs are scheduled by the caller,
// independent of deploys. GCM authenticates the content: any tamper or truncation fails decrypt.
const crypto = require('crypto');

const REPO = 'lowkey-hidden-game/lowkey';
const BACKUP_BRANCH = 'backups';
const API = 'https://api.github.com';
const KEEP = 8;

const TABLES = ['players', 'player_devices', 'player_stats', 'player_loadout', 'rounds', 'round_players'];

async function exportData(pool) {
  const tables = {};
  for (const t of TABLES) tables[t] = (await pool.query(`SELECT * FROM ${t}`)).rows;
  return { format: 'lowkey-backup', version: 1, created_at: new Date().toISOString(), tables };
}

function encryptBackup(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(passphrase), salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decryptBackup(blobB64, passphrase) {
  const raw = Buffer.from(String(blobB64), 'base64');
  if (raw.length < 45) throw new Error('backup blob too short / truncated');
  const key = crypto.scryptSync(String(passphrase), raw.subarray(0, 16), 32, { N: 16384, r: 8, p: 1 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(16, 28));
  decipher.setAuthTag(raw.subarray(28, 44));
  let dec;
  try { dec = Buffer.concat([decipher.update(raw.subarray(44)), decipher.final()]); }
  catch (e) { throw new Error('backup authentication failed (wrong key or tampered data)'); }
  return JSON.parse(dec.toString('utf8'));
}

function makeBackupStore({ ghToken, fetchImpl = fetch }) {
  const headers = () => ({ Authorization: 'Bearer ' + ghToken, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'lowkey-backup' });

  async function ensureBranch() {
    const r = await fetchImpl(`${API}/repos/${REPO}/git/ref/heads/main`, { headers: headers() });
    if (!r.ok) throw new Error('gh main ref: ' + r.status);
    const sha = (await r.json()).object.sha;
    const c = await fetchImpl(`${API}/repos/${REPO}/git/refs`, { method: 'POST', headers: headers(), body: JSON.stringify({ ref: 'refs/heads/' + BACKUP_BRANCH, sha }) });
    if (!c.ok && c.status !== 422) throw new Error('gh branch: ' + c.status);
  }

  async function push(name, blobB64) {
    await ensureBranch();
    const body = { message: 'backup ' + name, content: Buffer.from(blobB64, 'utf8').toString('base64'), branch: BACKUP_BRANCH };
    const r = await fetchImpl(`${API}/repos/${REPO}/contents/backups/${name}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error('gh backup push: ' + r.status);
  }

  async function list() {
    const r = await fetchImpl(`${API}/repos/${REPO}/contents/backups?ref=${BACKUP_BRANCH}`, { headers: headers() });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('gh backup list: ' + r.status);
    return r.json();
  }

  async function fetchBlob(file) {
    const r = await fetchImpl(file.download_url, { headers: headers() });
    if (!r.ok) throw new Error('gh backup fetch: ' + r.status);
    return r.text();
  }

  async function remove(file) {
    const r = await fetchImpl(`${API}/repos/${REPO}/contents/${file.path}`, { method: 'DELETE', headers: headers(), body: JSON.stringify({ message: 'backup retention prune', sha: file.sha, branch: BACKUP_BRANCH }) });
    if (!r.ok) throw new Error('gh backup delete: ' + r.status);
  }

  // Full cycle: export, encrypt, push, prune to the newest KEEP.
  async function run(pool, passphrase) {
    const t0 = Date.now();
    const payload = await exportData(pool);
    const blob = encryptBackup(payload, passphrase);
    const name = payload.created_at.replace(/[:.]/g, '-') + '.json';
    await push(name, blob);
    let files = await list();
    files.sort((a, b) => a.name < b.name ? -1 : 1);
    let pruned = 0;
    while (files.length > KEEP) { await remove(files.shift()); pruned++; }
    return { name, bytes: blob.length, ms: Date.now() - t0, pruned, counts: Object.fromEntries(TABLES.map(t => [t, payload.tables[t].length])) };
  }

  return { run, list, fetchBlob, remove };
}

module.exports = { exportData, encryptBackup, decryptBackup, makeBackupStore, TABLES, KEEP, BACKUP_BRANCH };
