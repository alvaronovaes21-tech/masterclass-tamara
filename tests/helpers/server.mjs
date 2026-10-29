// Servidor de TESTE (não é usado em produção).
// Serve o site estático e emula a API do Supabase (Auth, REST/PostgREST, Storage) por cima de um Postgres REAL
// (PGlite) com a MIGRAÇÃO REAL, para exercitar RLS, triggers, permissões e as telas de ponta a ponta.
// A Edge Function REAL (supabase/functions/testimonials/index.ts) é carregada e executada aqui, usando o
// @supabase/supabase-js real apontado para este emulador.
import http from 'node:http';
import { register } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.mjs';

register('./deno-loader.mjs', import.meta.url);

export const ADMIN = { id: '11111111-1111-1111-1111-111111111111', email: 'admin@teste.com', password: 'Senha-Forte-123!' };
export const OTHER = { id: '22222222-2222-2222-2222-222222222222', email: 'outro@teste.com', password: 'Outra-Senha-456!' };
export const SERVICE_KEY = 'service-role-key-SOMENTE-NO-SERVIDOR';
export const ANON_KEY = 'anon-public-key';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain', '.webp': 'image/webp' };
const TABLES = new Set(['testimonials', 'testimonial_history', 'submission_attempts', 'consent_texts']);
const COL = /^[a-z_][a-z0-9_]*$/;

export async function startServer({ port = 0, dataDir, files = new Map() } = {}) {
  const db = await createDb({ adminId: ADMIN.id, otherIds: [OTHER.id], dataDir });
  const sessions = new Map();      // access_token -> {sub,email}
  const refreshTokens = new Map(); // refresh -> {sub,email}
  const signed = new Map();        // token -> path
  const log = [];                  // log de requisições (para os testes inspecionarem)
  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  let origin = '';
  let fnHandler = null;

  // ----- carrega a Edge Function real -----
  const server = http.createServer(async (req, res) => {
    try { await route(req, res); } catch (e) { console.error('server error', e); res.writeHead(500); res.end(String(e)); }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;

  globalThis.Deno = { env: { get: (k) => process.env[k] }, serve: (h) => { fnHandler = h; } };
  process.env.SUPABASE_URL = origin;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  process.env.IP_HASH_SALT = 'salt-de-teste';
  await import('../../supabase/functions/testimonials/index.ts?t=' + Date.now());

  // ----- utilidades -----
  const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
  const send = (res, status, body, headers = {}) => {
    if (typeof body === 'boolean' || typeof body === 'number') body = JSON.stringify(body), headers = { 'Content-Type': 'application/json', ...headers };
    const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(status, { ...(isObj ? { 'Content-Type': 'application/json' } : {}), ...headers });
    res.end(isObj ? JSON.stringify(body) : body ?? '');
  };

  function who(req) {
    const auth = (req.headers.authorization || '').replace(/^Bearer /i, '');
    if (auth === SERVICE_KEY) return { role: 'service_role', claims: null };
    const s = sessions.get(auth);
    if (s) return { role: 'authenticated', claims: { sub: s.sub, email: s.email } };
    return { role: 'anon', claims: null };
  }
  function runAs(w, fn) {
    return serial(async () => {
      await db.query("select set_config('request.jwt.claims', $1, false)", [w.claims ? JSON.stringify(w.claims) : '']);
      await db.exec(`set role ${w.role}`);
      try { return await fn(); } finally { await db.exec('reset role'); }
    });
  }
  const pgErr = (e) => {
    const code = e.code || '';
    const status = code === '42501' ? 403 : code === '23505' ? 409 : 400;
    return [status, { code, message: e.message, details: e.detail || null, hint: e.hint || null }];
  };

  // ----- PostgREST mínimo -----
  function filters(params, start = 1) {
    const where = [], vals = [];
    const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'columns'].includes(k)) continue;
      if (!COL.test(k)) throw Object.assign(new Error('coluna inválida'), { code: 'PGRST100' });
      const m = /^(eq|neq|gt|gte|lt|lte)\.(.*)$/.exec(v);
      if (!m) throw Object.assign(new Error('filtro não suportado pelo emulador: ' + k + '=' + v), { code: 'PGRST100' });
      vals.push(m[2]); where.push(`"${k}" ${ops[m[1]]} $${start + vals.length - 1}`);
    }
    return { sql: where.length ? ' where ' + where.join(' and ') : '', vals };
  }
  function selectCols(params) {
    const s = params.get('select') || '*';
    if (s === '*') return '*';
    const cols = s.split(',').map((c) => c.trim());
    if (!cols.every((c) => COL.test(c))) throw Object.assign(new Error('select não suportado'), { code: 'PGRST100' });
    return cols.map((c) => `"${c}"`).join(', ');
  }
  function orderBy(params) {
    const o = params.get('order'); if (!o) return '';
    return ' order by ' + o.split(',').map((p) => {
      const [c, d = 'asc', n] = p.split('.');
      if (!COL.test(c)) throw new Error('order inválido');
      return `"${c}" ${d === 'desc' ? 'desc' : 'asc'}${n === 'nullslast' ? ' nulls last' : n === 'nullsfirst' ? ' nulls first' : ''}`;
    }).join(', ');
  }

  async function rest(req, res, url) {
    const w = who(req);
    const parts = url.pathname.replace('/rest/v1/', '').split('/');
    const body = await readBody(req);
    const json = body.length ? JSON.parse(body.toString('utf8')) : null;

    if (parts[0] === 'rpc') {
      const fn = parts[1];
      if (!['is_admin', 'set_featured_testimonials', 'confirm_author_change'].includes(fn)) return send(res, 404, { message: 'rpc inexistente' });
      const casts = { p_ids: 'uuid[]', p_id: 'uuid', p_note: 'text' };
      const keys = Object.keys(json || {});
      const args = keys.map((k, i) => `${k} => $${i + 1}::${casts[k]}`).join(', ');
      try {
        const r = await runAs(w, () => db.query(`select public.${fn}(${args}) as r`, keys.map((k) => json[k])));
        if (fn === 'is_admin') return send(res, 200, r.rows[0].r);
        return send(res, 204, '');
      } catch (e) { const [s, b] = pgErr(e); return send(res, s, b); }
    }

    const table = parts[0];
    if (!TABLES.has(table)) return send(res, 404, { message: 'tabela inexistente' });
    const prefer = req.headers.prefer || '';
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const f = filters(url.searchParams);
        if (req.method === 'HEAD') {
          const r = await runAs(w, () => db.query(`select count(*)::int c from public.${table}${f.sql}`, f.vals));
          return send(res, 200, '', { 'content-range': `*/${r.rows[0].c}` });
        }
        const lim = url.searchParams.get('limit');
        const r = await runAs(w, () => db.query(`select ${selectCols(url.searchParams)} from public.${table}${f.sql}${orderBy(url.searchParams)}${lim ? ` limit ${parseInt(lim, 10)}` : ''}`, f.vals));
        return send(res, 200, r.rows);
      }
      if (req.method === 'POST') {
        const rows = Array.isArray(json) ? json : [json];
        const cols = Object.keys(rows[0]);
        if (!cols.every((c) => COL.test(c))) throw new Error('coluna inválida');
        const vals = []; const tuples = rows.map((row) => '(' + cols.map((c) => { vals.push(row[c]); return `$${vals.length}`; }).join(', ') + ')');
        const ret = prefer.includes('return=representation') ? ' returning *' : '';
        const r = await runAs(w, () => db.query(`insert into public.${table} (${cols.map((c) => `"${c}"`).join(', ')}) values ${tuples.join(', ')}${ret}`, vals));
        return ret ? send(res, 201, r.rows) : send(res, 201, '');
      }
      if (req.method === 'PATCH') {
        const cols = Object.keys(json); if (!cols.every((c) => COL.test(c))) throw new Error('coluna inválida');
        const f = filters(url.searchParams, cols.length + 1);
        const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
        const ret = prefer.includes('return=representation') ? ' returning *' : '';
        const r = await runAs(w, () => db.query(`update public.${table} set ${sets}${f.sql}${ret}`, [...cols.map((c) => json[c]), ...f.vals]));
        return ret ? send(res, 200, r.rows) : send(res, 204, '');
      }
      if (req.method === 'DELETE') {
        const f = filters(url.searchParams);
        const ret = prefer.includes('return=representation') ? ' returning *' : '';
        const r = await runAs(w, () => db.query(`delete from public.${table}${f.sql}${ret}`, f.vals));
        return ret ? send(res, 200, r.rows) : send(res, 204, '');
      }
    } catch (e) { const [s, b] = pgErr(e); return send(res, s, b); }
    send(res, 405, { message: 'método' });
  }

  // ----- Storage (bucket privado) -----
  async function storage(req, res, url) {
    const w = who(req);
    const rest_ = url.pathname.replace('/storage/v1', '');
    const isAllowed = async () => {
      if (w.role === 'service_role') return true;
      if (w.role !== 'authenticated') return false;
      const r = await runAs(w, () => db.query('select public.is_admin() a'));
      return r.rows[0].a;
    };
    // download por URL assinada
    let m = /^\/object\/sign\/testimonial-photos\/(.+)$/.exec(rest_);
    if (m && req.method === 'GET') {
      const path = decodeURIComponent(m[1]); const tok = url.searchParams.get('token');
      if (signed.get(tok) !== path || !files.has(path)) return send(res, 400, { message: 'token inválido ou arquivo inexistente' });
      const f = files.get(path);
      return send(res, 200, Buffer.from(f.bytes), { 'Content-Type': f.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private' });
    }
    if (rest_ === '/object/sign/testimonial-photos' && req.method === 'POST') {
      if (!(await isAllowed())) return send(res, 403, { message: 'Acesso negado' });
      const { paths } = JSON.parse((await readBody(req)).toString());
      return send(res, 200, paths.map((p) => { const t = randomUUID(); signed.set(t, p); return { path: p, signedURL: `/object/sign/testimonial-photos/${p.split('/').map(encodeURIComponent).join('/')}?token=${t}`, error: null }; }));
    }
    m = /^\/object\/testimonial-photos\/(.+)$/.exec(rest_);
    if (m && req.method === 'POST') {
      if (!(await isAllowed())) return send(res, 403, { message: 'new row violates row-level security policy' });
      const path = decodeURIComponent(m[1]);
      let bytes = await readBody(req), type = req.headers['content-type'] || '';
      if (type.startsWith('multipart/')) {
        const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': type }, body: bytes }).formData();
        const f = fd.get('') || [...fd.values()].find((v) => typeof v !== 'string');
        type = f.type; bytes = Buffer.from(await f.arrayBuffer());
      }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return send(res, 415, { message: 'mime type not supported' });
      if (bytes.length > 5 * 1024 * 1024) return send(res, 413, { message: 'The object exceeded the maximum allowed size' });
      if (files.has(path) && req.headers['x-upsert'] !== 'true') return send(res, 409, { message: 'The resource already exists' });
      files.set(path, { bytes, type });
      return send(res, 200, { Key: `testimonial-photos/${path}` });
    }
    if (rest_ === '/object/testimonial-photos' && req.method === 'DELETE') {
      if (!(await isAllowed())) return send(res, 403, { message: 'Acesso negado' });
      const { prefixes } = JSON.parse((await readBody(req)).toString());
      prefixes.forEach((p) => files.delete(p));
      return send(res, 200, prefixes.map((name) => ({ name })));
    }
    if (/^\/object\/(public|authenticated)\//.test(rest_)) return send(res, 400, { message: 'Bucket not found' });
    send(res, 404, { message: 'rota de storage não emulada' });
  }

  // ----- Auth -----
  async function auth(req, res, url) {
    const body = (await readBody(req)).toString();
    const json = body ? JSON.parse(body) : {};
    const mk = (u) => {
      const access = 'jwt.' + randomUUID(), refresh = 'rt.' + randomUUID();
      sessions.set(access, { sub: u.id, email: u.email }); refreshTokens.set(refresh, { sub: u.id, email: u.email });
      return { access_token: access, refresh_token: refresh, expires_in: server.shortTokens ? 2 : 3600, token_type: 'bearer', user: { id: u.id, email: u.email } };
    };
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const u = [ADMIN, OTHER].find((x) => x.email === json.email && x.password === json.password);
      if (!u) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      return send(res, 200, mk(u));
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const u = refreshTokens.get(json.refresh_token);
      if (!u) return send(res, 400, { error_description: 'Invalid Refresh Token' });
      refreshTokens.delete(json.refresh_token);
      return send(res, 200, mk({ id: u.sub, email: u.email }));
    }
    if (url.pathname === '/auth/v1/logout') { sessions.delete((req.headers.authorization || '').replace(/^Bearer /i, '')); return send(res, 204, ''); }
    send(res, 404, { message: 'auth não emulado' });
  }

  // ----- Edge Function real -----
  async function functions(req, res, url) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    headers.set('x-forwarded-for', req.headers['x-test-ip'] || '203.0.113.7');
    const r = await fnHandler(new Request(origin + url.pathname + url.search, { method: req.method, headers, body }));
    const out = {}; r.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(r.status, out); res.end(Buffer.from(await r.arrayBuffer()));
  }

  // ----- Estático -----
  function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/__config.js') {
      return send(res, 200, `window.SITE_CONFIG = { supabaseUrl: '${origin}', supabaseAnonKey: '${ANON_KEY}', turnstileSiteKey: '' };`, { 'Content-Type': MIME['.js'] });
    }
    let file = normalize(join(ROOT, p));
    if (!file.startsWith(normalize(ROOT))) return send(res, 403, 'no');
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return send(res, 404, 'not found');
    let buf = readFileSync(file); const ext = extname(file);
    if (file.endsWith('site-config.js') && server.configured !== false) {
      buf = Buffer.from(`window.SITE_CONFIG = { supabaseUrl: '${origin}', supabaseAnonKey: '${ANON_KEY}', turnstileSiteKey: '' };`);
    }
    if (file.endsWith('site-config.js') && server.configured === false) {   // simula o site "ainda não configurado" (o arquivo real agora tem a URL de produção)
      buf = Buffer.from("window.SITE_CONFIG = { supabaseUrl: '', supabaseAnonKey: '', turnstileSiteKey: '' };");
    }
    if (ext === '.html') { // CSP do teste: troca o domínio do Supabase pelo servidor local e remove o upgrade para https
      buf = Buffer.from(buf.toString('utf8').replaceAll('https://*.supabase.co', origin).replace('; upgrade-insecure-requests', ''));
    }
    send(res, 200, buf, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  }

  async function route(req, res) {
    const url = new URL(req.url, origin);
    log.push(`${req.method} ${url.pathname}`);
    if (url.pathname.startsWith('/rest/v1/')) return rest(req, res, url);
    if (url.pathname.startsWith('/storage/v1/')) return storage(req, res, url);
    if (url.pathname.startsWith('/auth/v1/')) return auth(req, res, url);
    if (url.pathname.startsWith('/functions/v1/testimonials')) return functions(req, res, url);
    return serveStatic(req, res, url);
  }

  return {
    origin, db, files, log, sessions, signed,
    setConfigured(v) { server.configured = v; },
    setShortTokens(v) { server.shortTokens = v; },
    sql: (q, p) => serial(() => db.query(q, p)),
    close: async () => { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); await db.close(); },
  };
}

// Execução manual: node helpers/server.mjs  -> sobe em http://127.0.0.1:8787 para você testar no navegador
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const s = await startServer({ port: 8787 });
  console.log(`Servidor de teste: ${s.origin}/  |  admin: ${s.origin}/admin/depoimentos/  (${ADMIN.email} / ${ADMIN.password})`);
}
