import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamZip } from './zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const uid = () => randomUUID();
const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const requireText = (v, label, max = 200) => { const s = text(v, max); if (!s) fail(400, `${label} is required.`); return s; };
const integer = (v, min, max, label) => { if (!Number.isInteger(v) || v < min || v > max) fail(400, `${label} must be between ${min} and ${max}.`); return v; };
const hashPassword = (password, salt) => scryptSync(password, salt, 64).toString('hex');
const equal = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function createApp(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || join(here, 'data'));
  mkdirSync(join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'publisher-exit.sqlite'));
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,contact TEXT,email TEXT,deadline TEXT,referral TEXT,stage TEXT DEFAULT 'audit',next_action TEXT DEFAULT 'Receive source library',audit_paid INTEGER DEFAULT 0,received_at TEXT,training_at TEXT,trainee TEXT,training_passed INTEGER DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,role TEXT,project_id TEXT,expires INTEGER,csrf TEXT);
    CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),expires INTEGER);
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),name TEXT,size INTEGER,sha256 TEXT,path TEXT,duplicate_of TEXT REFERENCES files(id),created_at TEXT);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,file_id TEXT UNIQUE REFERENCES files(id),status TEXT DEFAULT 'queued',attempts INTEGER DEFAULT 0,lease TEXT,lease_until INTEGER,error TEXT,artifact TEXT,pages INTEGER,qa INTEGER DEFAULT 0,exception TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),version INTEGER,cents INTEGER,template_count INTEGER,file_limit INTEGER,page_limit INTEGER,revisions INTEGER,scope TEXT,due TEXT,status TEXT DEFAULT 'offered',accepted_at TEXT,created_at TEXT,UNIQUE(project_id,version));
    CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),name TEXT,url TEXT DEFAULT '',version INTEGER DEFAULT 0,status TEXT DEFAULT 'building',ownership INTEGER DEFAULT 0,print_checked INTEGER DEFAULT 0,notes TEXT DEFAULT '',created_at TEXT);
    CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,template_id TEXT REFERENCES templates(id),version INTEGER,author TEXT,body TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS care(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,body TEXT,status TEXT DEFAULT 'open',created_at TEXT);
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),message TEXT,created_at TEXT);
    CREATE INDEX IF NOT EXISTS files_project ON files(project_id);
    CREATE INDEX IF NOT EXISTS events_project ON events(project_id);`);
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const audit = (id, message) => run('INSERT INTO events VALUES(?,?,?,?)', uid(), id, message, now());
  const configuredPassword = options.password || process.env.OPERATOR_PASSWORD;
  if (!one("SELECT value FROM settings WHERE key='password'")) {
    if (!configuredPassword || configuredPassword.length < 12) { db.close(); throw new Error('Set OPERATOR_PASSWORD to at least 12 characters for first startup.'); }
    const salt = randomBytes(16).toString('hex');
    run('INSERT INTO settings VALUES(?,?)', 'salt', salt);
    run('INSERT INTO settings VALUES(?,?)', 'password', hashPassword(configuredPassword, salt));
  }
  const workerToken = options.workerToken || process.env.WORKER_TOKEN || '';
  const allowedOrigin = options.origin || process.env.APP_ORIGIN;
  const secureCookies = options.secureCookies ?? process.env.SECURE_COOKIES === 'true';
  const attempts = new Map();
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const body = async (req, max = 1024 * 1024) => {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > max) fail(413, 'File or request is too large.'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  };
  const parse = async req => { try { const value=JSON.parse((await body(req)).toString()); if(!value || typeof value!=='object' || Array.isArray(value))fail(400,'Expected a JSON object.'); return value; } catch (e) { if (e.status) throw e; fail(400, 'Invalid JSON.'); } };
  const session = req => {
    const token = /(?:^|;\s*)px_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    const s = token && one('SELECT * FROM sessions WHERE hash=? AND expires>?', digest(token), Date.now());
    if (!s) fail(401, 'Please sign in.');
    if (!['GET', 'HEAD'].includes(req.method) && !equal(String(req.headers['x-csrf-token'] || ''), s.csrf)) fail(403, 'Session verification failed. Refresh and try again.');
    return s;
  };
  const operator = s => { if (s.role !== 'operator') fail(403, 'Operator access required.'); };
  const project = (id, s) => { const p = one('SELECT * FROM projects WHERE id=?', id); if (!p || (s.role !== 'operator' && s.project_id !== id)) fail(404, 'Project not found.'); return p; };
  const worker = req => { if (!workerToken || !equal(String(req.headers['x-worker-token'] || ''), workerToken)) fail(401, 'Worker authentication required.'); };
  const startSession = (res, role, projectId = null) => {
    const token = randomBytes(32).toString('hex'); const csrf = randomBytes(24).toString('hex');
    run('DELETE FROM sessions WHERE expires<?', Date.now());
    run('INSERT INTO sessions VALUES(?,?,?,?,?)', digest(token), role, projectId, Date.now() + 8 * 3600_000, csrf);
    res.setHeader('Set-Cookie', `px_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookies ? '; Secure' : ''}`);
    json(res, 200, { role, projectId, csrf });
  };
  const inventory = id => all(`SELECT f.id,f.name,f.size,f.sha256,f.duplicate_of,f.created_at,j.id job_id,j.status,j.attempts,j.error,j.pages,j.qa,j.exception,CASE WHEN j.artifact IS NULL THEN 0 ELSE 1 END has_pdf FROM files f LEFT JOIN jobs j ON j.file_id=COALESCE(f.duplicate_of,f.id) WHERE f.project_id=? ORDER BY f.name`, id);
  const detail = id => ({
    project: one('SELECT * FROM projects WHERE id=?', id), files: inventory(id),
    quotes: all('SELECT * FROM quotes WHERE project_id=? ORDER BY version DESC', id),
    templates: all('SELECT * FROM templates WHERE project_id=? ORDER BY created_at', id).map(t => ({ ...t, comments: all('SELECT * FROM comments WHERE template_id=? ORDER BY created_at', t.id) })),
    care: all('SELECT * FROM care WHERE project_id=? ORDER BY created_at DESC', id),
    events: all('SELECT * FROM events WHERE project_id=? ORDER BY created_at DESC LIMIT 40', id)
  });
  const download = (res, filename, bytes, type) => { res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename)}` }); res.end(bytes); };
  const lease = (req, jobId) => { worker(req); const j = one('SELECT * FROM jobs WHERE id=?', jobId); if (!j || j.status !== 'running' || j.lease_until < Date.now() || !equal(String(req.headers['x-job-lease'] || ''), j.lease || '')) fail(409, 'Job lease expired or invalid.'); return j; };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost'); const path = url.pathname; const method = req.method;
      if (!['GET', 'HEAD'].includes(method) && req.headers.origin && req.headers.origin !== (allowedOrigin || `http://${req.headers.host}`)) fail(403, 'Cross-origin request rejected.');
      if (method === 'GET' && ['/','/app.js','/style.css'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1); res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }); return res.end(readFileSync(join(here, file)));
      }
      if (method === 'POST' && ['/api/login', '/api/access'].includes(path)) {
        const key = req.socket.remoteAddress; const recent = attempts.get(key) || { count: 0, until: Date.now() + 15 * 60_000 };
        if (recent.until < Date.now()) { recent.count = 0; recent.until = Date.now() + 15 * 60_000; }
        if (recent.count >= 10) fail(429, 'Too many attempts. Try again in 15 minutes.');
        if (attempts.size > 1000) for (const [k,v] of attempts) if (v.until < Date.now()) attempts.delete(k);
        recent.count++; attempts.set(key, recent);
        const b = await parse(req);
        if (path === '/api/login') {
          const actual = hashPassword(typeof b.password === 'string' ? b.password.slice(0,512) : '', one("SELECT value FROM settings WHERE key='salt'").value);
          if (!equal(actual, one("SELECT value FROM settings WHERE key='password'").value)) fail(401, 'Incorrect password.');
          attempts.delete(key); return startSession(res, 'operator');
        }
        const invite = one('SELECT * FROM invites WHERE hash=? AND expires>?', digest(text(b.token, 128)), Date.now());
        if (!invite) fail(401, 'Invitation expired or invalid. Ask your operator for a new link.');
        run('DELETE FROM invites WHERE hash=?', invite.hash); attempts.delete(key); return startSession(res, 'customer', invite.project_id);
      }
      if (path.startsWith('/api/worker/')) {
        worker(req);
        if (method === 'POST' && path === '/api/worker/claim') {
          // Synchronous transaction guarantees one active lease per job even with concurrent requests.
          db.exec('BEGIN IMMEDIATE'); let claimed;
          try {
            run("UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error='Worker lease expired',lease=NULL WHERE status='running' AND lease_until<?", Date.now());
            const j = one("SELECT j.*,f.name FROM jobs j JOIN files f ON f.id=j.file_id WHERE j.status='queued' ORDER BY j.created_at LIMIT 1");
            if (j) { const token = randomBytes(24).toString('hex'); run("UPDATE jobs SET status='running',attempts=attempts+1,lease=?,lease_until=? WHERE id=?", token, Date.now() + 90_000, j.id); claimed = { id: j.id, name: j.name, lease: token }; }
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
          return json(res, 200, { job: claimed || null });
        }
        const m = /^\/api\/worker\/jobs\/([^/]+)\/(source|heartbeat|result|fail)$/.exec(path);
        if (!m) fail(404, 'Worker route not found.'); const j = lease(req, m[1]);
        if (method === 'GET' && m[2] === 'source') { const f = one('SELECT * FROM files WHERE id=?', j.file_id); return download(res, f.name, readFileSync(join(dataDir, 'files', f.path)), 'application/octet-stream'); }
        if (method === 'POST' && m[2] === 'heartbeat') { run('UPDATE jobs SET lease_until=? WHERE id=?', Date.now() + 90_000, j.id); return json(res, 200, { ok: true }); }
        if (method === 'POST' && m[2] === 'fail') { const b = await parse(req); run("UPDATE jobs SET status='failed',error=?,lease=NULL WHERE id=?", text(b.error, 1000) || 'Export failed', j.id); return json(res, 200, { ok: true }); }
        if (method === 'POST' && m[2] === 'result') {
          const bytes = await body(req, 100 * 1024 * 1024); if (bytes.subarray(0, 5).toString() !== '%PDF-' || !bytes.subarray(-4096).includes(Buffer.from('%%EOF'))) fail(400, 'Output must be a complete PDF.');
          lease(req, j.id); // Upload may outlive the lease; never accept a stale worker result.
          const pages = integer(Number(req.headers['x-page-count']), 1, 10000, 'Page count');
          const artifact = `${j.id}.pdf`; writeFileSync(join(dataDir, 'files', artifact), bytes);
          run("UPDATE jobs SET status='exported',artifact=?,pages=?,error=NULL,lease=NULL WHERE id=?", artifact, pages, j.id);
          return json(res, 200, { ok: true, message: 'Export saved; human quality review required.' });
        }
        fail(405, 'Method not allowed.');
      }
      const s = session(req);
      if (method === 'GET' && path === '/api/me') return json(res, 200, { role: s.role, projectId: s.project_id, csrf: s.csrf, workerConfigured: s.role === 'operator' && Boolean(workerToken) });
      if (method === 'POST' && path === '/api/logout') { run('DELETE FROM sessions WHERE hash=?', s.hash); res.setHeader('Set-Cookie', 'px_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
      if (method === 'GET' && path === '/api/projects') {
        const rows = s.role === 'operator' ? all('SELECT * FROM projects ORDER BY deadline,created_at DESC') : all('SELECT * FROM projects WHERE id=?', s.project_id);
        return json(res, 200, rows.map(p => ({ ...p, files: one('SELECT COUNT(*) n FROM files WHERE project_id=?', p.id).n, open_care: one("SELECT COUNT(*) n FROM care WHERE project_id=? AND status='open'", p.id).n })));
      }
      if (method === 'POST' && path === '/api/projects') {
        operator(s); const b = await parse(req); const id = uid();
        run('INSERT INTO projects(id,name,contact,email,deadline,referral,created_at) VALUES(?,?,?,?,?,?,?)', id, requireText(b.name, 'Organization'), requireText(b.contact, 'Contact'), text(b.email), text(b.deadline, 10), text(b.referral), now());
        audit(id, 'Project opened.'); return json(res, 201, { id });
      }
      const m = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (!m) fail(404, 'Not found.'); const id = m[1], action = m[2] || ''; const p = project(id, s);
      if (method === 'GET' && !action) return json(res, 200, detail(id));
      if (method === 'PATCH' && !action) {
        operator(s); if(p.stage==='complete')fail(409,'Completed handoff records are locked. Use a care request for later work.'); const b = await parse(req);
        run('UPDATE projects SET next_action=?,audit_paid=?,received_at=?,training_at=?,trainee=?,training_passed=? WHERE id=?', text(b.next_action, 500), b.audit_paid ? 1 : 0, b.source_complete ? (p.received_at || now()) : null, text(b.training_at, 30) || null, text(b.trainee), b.training_passed ? 1 : 0, id);
        audit(id, 'Operator updated project and handoff checklist.'); return json(res, 200, { ok: true });
      }
      if (method === 'POST' && action === 'invite') {
        operator(s); const token = randomBytes(32).toString('hex'); run('DELETE FROM invites WHERE project_id=?', id); run("DELETE FROM sessions WHERE project_id=? AND role='customer'", id); run('INSERT INTO invites VALUES(?,?,?)', digest(token), id, Date.now() + 7 * 86400_000); audit(id, 'New single-use customer invitation issued; previous customer sessions revoked.'); return json(res, 201, { token });
      }
      if (method === 'POST' && action === 'files') {
        if (p.stage === 'complete') fail(409, 'Project is complete. Open a new project for additional source files.');
        let name; try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { fail(400, 'Invalid file name.'); }
        name = requireText(name, 'File name', 500).replaceAll('\\', '/');
        if (!name.toLowerCase().endsWith('.pub') || name.split('/').some(x => x === '..' || x === '.') || /[\x00-\x1f]/.test(name)) fail(400, 'Upload .pub files using a valid relative file name.');
        if (inventory(id).length >= 800) fail(400, 'MVP limit: 800 source files per project.');
        const bytes = await body(req, 50 * 1024 * 1024); if (!bytes.length) fail(400, 'File is empty.');
        if(one('SELECT stage FROM projects WHERE id=?',id).stage==='complete')fail(409,'Project was completed while uploading. No new source was added.');
        const hash = digest(bytes); const existing = one('SELECT id FROM files WHERE project_id=? AND sha256=? AND duplicate_of IS NULL', id, hash);
        const same = one('SELECT id FROM files WHERE project_id=? AND sha256=? AND name=?', id, hash, name); if (same) return json(res, 200, { id: same.id, alreadyUploaded: true });
        if(one('SELECT COUNT(*) n FROM files WHERE project_id=?',id).n>=800)fail(400,'MVP limit: 800 source files per project.');
        const fileId = uid(), filename = `${fileId}.pub`; if (!existing) writeFileSync(join(dataDir, 'files', filename), bytes, { flag: 'wx' });
        run('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)', fileId, id, name, bytes.length, hash, existing ? '' : filename, existing?.id || null, now());
        if (!existing) run('INSERT INTO jobs(id,file_id,created_at) VALUES(?,?,?)', uid(), fileId, now());
        audit(id, `Received ${name}${existing ? ' (identical copy mapped to existing source)' : ''}.`); return json(res, 201, { id: fileId, duplicate: Boolean(existing) });
      }
      const fm = /^files\/([^/]+)\/(pdf|source)$/.exec(action);
      if (method === 'GET' && fm) {
        const f = one('SELECT * FROM files WHERE id=? AND project_id=?', fm[1], id); if (!f) fail(404, 'File not found.'); const canonical = f.duplicate_of ? one('SELECT * FROM files WHERE id=?', f.duplicate_of) : f;
        if (fm[2] === 'source') return download(res, f.name.split('/').pop(), readFileSync(join(dataDir, 'files', canonical.path)), 'application/octet-stream');
        const j = one('SELECT * FROM jobs WHERE file_id=?', canonical.id); if (!j?.artifact) fail(404, 'PDF not yet available.'); return download(res, f.name.split('/').pop().replace(/\.pub$/i, '.pdf'), readFileSync(join(dataDir, 'files', j.artifact)), 'application/pdf');
      }
      const jm = /^jobs\/([^/]+)\/(retry|review|exception)$/.exec(action);
      if (method === 'POST' && jm) {
        operator(s); const j = one('SELECT j.* FROM jobs j JOIN files f ON f.id=j.file_id WHERE j.id=? AND f.project_id=?', jm[1], id); if (!j) fail(404, 'Job not found.');
        if (p.stage === 'complete') fail(409, 'Completed archive is locked.');
        if (jm[2] === 'retry') { if (j.status !== 'failed') fail(409, 'Only failed jobs can be retried.'); run("UPDATE jobs SET status='queued',attempts=0,error=NULL,qa=0,exception=NULL WHERE id=?", j.id); }
        if (jm[2] === 'review') { if (!j.artifact || j.status !== 'exported') fail(409, 'Export a PDF before reviewing it.'); run("UPDATE jobs SET qa=1,status='reviewed' WHERE id=?", j.id); }
        if (jm[2] === 'exception') { const b = await parse(req); if (j.status === 'running') fail(409, 'Wait for the active export attempt.'); run("UPDATE jobs SET status='exception',exception=?,qa=0 WHERE id=?", requireText(b.reason, 'Exception explanation', 1000), j.id); }
        audit(id, `Conversion ${jm[2]} recorded.`); return json(res, 200, { ok: true });
      }
      if (method === 'POST' && action === 'quotes') {
        operator(s); const b = await parse(req); if (one("SELECT id FROM quotes WHERE project_id=? AND status='accepted'", id)) fail(409, 'Accepted scope is locked. Start a separate project for additional work.');
        const quote = { cents: integer(b.cents, 100, 10000000, 'Price in cents'), count: integer(b.template_count, 0, 100, 'Template count'), files: integer(b.file_limit, 1, 800, 'File limit'), pages: integer(b.page_limit, 1, 100000, 'Page limit'), revisions: integer(b.revisions, 0, 20, 'Revision allowance'), scope: requireText(b.scope, 'Scope', 10000), due: requireText(b.due, 'Due date', 10) };
        const version = one('SELECT COALESCE(MAX(version),0)+1 n FROM quotes WHERE project_id=?', id).n;
        run("UPDATE quotes SET status='superseded' WHERE project_id=? AND status='offered'", id);
        run('INSERT INTO quotes(id,project_id,version,cents,template_count,file_limit,page_limit,revisions,scope,due,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', uid(), id, version, quote.cents, quote.count, quote.files, quote.pages, quote.revisions, quote.scope, quote.due, now());
        run("UPDATE projects SET stage='quote',next_action='Customer: review fixed quote' WHERE id=?", id); audit(id, `Fixed quote v${version} offered.`); return json(res, 201, { ok: true });
      }
      const qm = /^quotes\/([^/]+)\/accept$/.exec(action);
      if (method === 'POST' && qm) {
        if (s.role !== 'customer') fail(403, 'The customer must accept their quote.');
        const q = one("SELECT * FROM quotes WHERE id=? AND project_id=? AND status='offered'", qm[1], id); if (!q) fail(409, 'Quote is no longer available.');
        run("UPDATE quotes SET status='accepted',accepted_at=? WHERE id=?", now(), q.id); run("UPDATE projects SET stage='migration',next_action='Export archives and rebuild active templates' WHERE id=?", id); audit(id, `Customer accepted fixed quote v${q.version}.`); return json(res, 200, { ok: true });
      }
      if (method === 'POST' && action === 'templates') {
        operator(s); if (p.stage === 'complete') fail(409, 'Project is complete.'); const b = await parse(req); run('INSERT INTO templates(id,project_id,name,created_at) VALUES(?,?,?,?)', uid(), id, requireText(b.name, 'Template name'), now()); audit(id, 'Template rebuild added.'); return json(res, 201, { ok: true });
      }
      const tm = /^templates\/([^/]+)(?:\/(review))?$/.exec(action);
      if (tm && ['PATCH', 'POST'].includes(method)) {
        if (p.stage === 'complete') fail(409, 'Project is complete. Use a care request for later changes.');
        const t = one('SELECT * FROM templates WHERE id=? AND project_id=?', tm[1], id); if (!t) fail(404, 'Template not found.'); const b = await parse(req);
        if (method === 'PATCH' && !tm[2]) {
          operator(s); let link; try { link = new URL(b.url); } catch { fail(400, 'Enter a valid HTTPS template link.'); } if (link.protocol !== 'https:') fail(400, 'Template links must use HTTPS.');
          run("UPDATE templates SET url=?,version=version+1,status='review',ownership=?,print_checked=?,notes=? WHERE id=?", link.href, b.ownership ? 1 : 0, b.print_checked ? 1 : 0, text(b.notes, 2000), t.id); audit(id, `${t.name} submitted for customer review.`);
        } else if (method === 'POST' && tm[2]) {
          if (s.role !== 'customer') fail(403, 'Customer review required.'); if (t.status !== 'review' || b.version !== t.version) fail(409, 'Template changed. Refresh before reviewing.');
          if (b.accept && (!t.ownership || !t.print_checked)) fail(409, 'Operator must verify ownership and print quality before approval.');
          const note = requireText(b.comment, 'Review note', 2000); run('INSERT INTO comments VALUES(?,?,?,?,?,?)', uid(), t.id, t.version, 'customer', note, now()); run('UPDATE templates SET status=? WHERE id=?', b.accept ? 'accepted' : 'changes', t.id); audit(id, `${t.name}: customer ${b.accept ? 'approved' : 'requested changes'}.`);
        } else fail(405, 'Method not allowed.'); return json(res, 200, { ok: true });
      }
      if (method === 'POST' && action === 'care') { const b = await parse(req); run('INSERT INTO care(id,project_id,title,body,created_at) VALUES(?,?,?,?,?)', uid(), id, requireText(b.title, 'Request title'), requireText(b.body, 'Request details', 5000), now()); audit(id, 'Template-care request received.'); return json(res, 201, { ok: true }); }
      const cm = /^care\/([^/]+)\/resolve$/.exec(action);
      if (method === 'POST' && cm) { operator(s); const result = run("UPDATE care SET status='resolved' WHERE id=? AND project_id=?", cm[1], id); if (!result.changes) fail(404, 'Request not found.'); audit(id, 'Care request resolved.'); return json(res, 200, { ok: true }); }
      if (method === 'GET' && action === 'manifest') {
        const d = detail(id); const manifest = { organization: p.name, generated_at: now(), stage: p.stage, files: d.files, templates: d.templates.map(({comments,...t}) => t), training: { trainee: p.trainee, at: p.training_at, passed: Boolean(p.training_passed) } };
        return download(res, 'publisher-exit-manifest.json', JSON.stringify(manifest, null, 2), 'application/json');
      }
      if (method === 'GET' && action === 'archive') {
        const fs=inventory(id); if(!fs.length)fail(409,'Upload a source library first.');
        const manifest=Buffer.from(JSON.stringify({organization:p.name,generated_at:now(),stage:p.stage,files:fs,templates:detail(id).templates,training:{trainee:p.trainee,at:p.training_at,passed:Boolean(p.training_passed)},note:'PDFs are named with source IDs to avoid collisions. The manifest maps each PDF to its original name. Originals remain individually downloadable.'},null,2));
        const entries=[{name:'manifest.json',read:()=>manifest}];let size=manifest.length;
        for(const f of fs){if(!f.has_pdf)continue;const j=one('SELECT artifact FROM jobs WHERE id=?',f.job_id);const disk=join(dataDir,'files',j.artifact);size+=statSync(disk).size;entries.push({name:`pdfs/${f.id}.pdf`,read:()=>readFileSync(disk)});}
        if(size>2*1024*1024*1024)fail(413,'Archive exceeds the 2 GB MVP download limit. Download individual PDFs.');
        res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="publisher-exit-archive.zip"'});await streamZip(res,entries);return;
      }
      if (method === 'POST' && action === 'complete') {
        if (s.role !== 'customer') fail(403, 'Customer acceptance is required to complete handoff.');
        if (p.stage === 'complete') return json(res, 200, { ok: true });
        const b = await parse(req); const q = one("SELECT * FROM quotes WHERE project_id=? AND status='accepted'", id); const fs = inventory(id); const ts = all('SELECT * FROM templates WHERE project_id=?', id);
        if (!q) fail(409, 'Accept a fixed quote first.');
        if (!p.received_at || !fs.length || fs.some(f => !['reviewed', 'exception'].includes(f.status))) fail(409, 'Every source needs a reviewed PDF or a documented exception, and the library must be marked complete.');
        if (fs.length > q.file_limit || fs.reduce((sum,f) => sum + (f.pages || 0), 0) > q.page_limit) fail(409, 'Archive exceeds the accepted file or page limit. Operator review required.');
        if (ts.length < q.template_count || ts.some(t => t.status !== 'accepted')) fail(409, 'All contracted templates must be delivered and accepted.');
        if (!p.training_passed || !p.trainee || !p.training_at) fail(409, 'Staff training and an independent editing exercise must be recorded.');
        if (!b.accept_exceptions && fs.some(f => f.status === 'exception')) fail(409, 'Explicitly accept the listed source exceptions.');
        run("UPDATE projects SET stage='complete',next_action='Handoff accepted; template care available' WHERE id=?", id); audit(id, 'Customer accepted delivery, training, and listed exceptions.'); return json(res, 200, { ok: true });
      }
      fail(404, 'Not found.');
    } catch (e) { if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Unexpected server error. Check the operator console.' }); else res.end(); if (!e.status) console.error(e); }
  });
  server.requestTimeout = 120_000;
  server.on('close', () => db.close());
  return { server, db, dataDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && (!process.env.APP_ORIGIN?.startsWith('https://') || process.env.SECURE_COOKIES !== 'true')) throw new Error('Network deployment requires HTTPS APP_ORIGIN and SECURE_COOKIES=true behind a TLS proxy.');
  const { server } = createApp(); const port = Number(process.env.PORT || 4317);
  server.listen(port, host, () => console.log(`Publisher Exit listening on http://${host}:${port}`));
}
