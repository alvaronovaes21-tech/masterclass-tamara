// Edge Function "testimonials" (Supabase / Deno)
//
//   GET  -> lista PÚBLICA: somente depoimentos aprovados + publicados, só campos autorizados.
//   POST -> recebe um depoimento (multipart/form-data) como PENDENTE. Nunca publica sozinho.
//
// Roda no servidor com a service role (chave que NUNCA vai para o navegador).
// Variáveis de ambiente (as duas primeiras o Supabase injeta automaticamente):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ALLOWED_ORIGINS      (opcional) origens permitidas, separadas por vírgula. Ex.: https://seusite.com
//   TURNSTILE_SECRET_KEY (opcional) ativa o CAPTCHA Cloudflare Turnstile
//   IP_HASH_SALT         (recomendado) segredo usado para anonimizar o IP no limitador de envios
import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkPhoto, publicCourseLabel, validateSubmission, type RawFields } from './validate.ts';

const BUCKET = 'testimonial-photos';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_PER_HOUR = 4;
const MAX_PER_DAY = 10;
const MAX_PENDING_TOTAL = 500;
const SIGNED_URL_SECONDS = 60 * 60;

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') ?? '';
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allowed.length === 0) h['Access-Control-Allow-Origin'] = '*';
  else if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...corsHeaders(req), ...extra },
  });
}

async function hashIp(req: Request): Promise<string> {
  const ip = (req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  const salt = Deno.env.get('IP_HASH_SALT') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyTurnstile(token: string, req: Request): Promise<boolean> {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  if (!secret) return true; // não configurado: verificação desligada
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  const ip = req.headers.get('cf-connecting-ip');
  if (ip) body.set('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const j = await r.json();
    return j.success === true;
  } catch { return false; }
}

// ------------------------------------------------------------------ GET
async function listPublic(req: Request): Promise<Response> {
  const { data, error } = await sb
    .from('testimonials')
    .select('display_name, profession, cohort, body, published_at, photo_path, photo_consent, featured_position, course_key, course_detail, course_detail_public')
    .eq('status', 'approved')
    .eq('published', true)
    .eq('needs_author_confirmation', false)
    .order('featured_position', { ascending: true, nullsFirst: false })
    .order('published_at', { ascending: false })
    .limit(105);
  if (error) return json(req, { error: 'Não foi possível carregar os depoimentos.' }, 500);

  const rows = data ?? [];
  const paths = rows.filter((r) => r.photo_path && r.photo_consent).map((r) => r.photo_path as string);
  const urlByPath = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
    for (const s of signed ?? []) if (s.signedUrl && s.path) urlByPath.set(s.path, s.signedUrl);
  }

  // Apenas campos autorizados. Nenhum id interno, e-mail, telefone ou nome real.
  const shape = (r: (typeof rows)[number]) => ({
    name: r.display_name,
    profession: r.profession || null,
    cohort: r.cohort || null,
    course: publicCourseLabel(r.course_key, r.course_detail, r.course_detail_public),
    text: r.body,
    date: r.published_at ? String(r.published_at).slice(0, 10) : null,
    photo_url: r.photo_path && r.photo_consent ? urlByPath.get(r.photo_path) ?? null : null,
  });
  const featured = rows.filter((r) => r.featured_position !== null).map(shape);
  const others = rows.filter((r) => r.featured_position === null).map(shape);
  return json(req, { featured, others }, 200, { 'Cache-Control': 'public, max-age=60' });
}

// ------------------------------------------------------------------ POST
async function receive(req: Request): Promise<Response> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_REQUEST_BYTES) return json(req, { ok: false, errors: { photo: 'O envio é grande demais.' } }, 413);

  let form: FormData;
  try { form = await req.formData(); } catch { return json(req, { ok: false, message: 'Envio inválido.' }, 400); }

  const raw: RawFields = {};
  for (const k of ['author_name', 'display_choice', 'custom_name', 'profession', 'cohort', 'contact', 'course', 'course_detail', 'body', 'consent_own',
    'consent_publication', 'photo_consent', 'consent_version', 'website', 'elapsed'] as const) {
    const v = form.get(k);
    raw[k] = typeof v === 'string' ? v.slice(0, 5000) : '';
  }

  const file = form.get('photo');
  const hasPhoto = file instanceof File && file.size > 0;

  const result = validateSubmission(raw, hasPhoto);
  if (result.bot) return json(req, { ok: true }, 201); // silenciosamente descartado
  if (!result.value) return json(req, { ok: false, errors: result.errors }, 400);

  // Foto: validação do conteúdo REAL (magic bytes), tamanho e dimensões.
  let photoBytes: Uint8Array | null = null;
  let photoInfo: { type: string; ext: string } | null = null;
  if (hasPhoto) {
    if ((file as File).size > 5 * 1024 * 1024) return json(req, { ok: false, errors: { photo: 'A foto é muito grande (máximo de 5 MB).' } }, 400);
    photoBytes = new Uint8Array(await (file as File).arrayBuffer());
    const chk = checkPhoto(photoBytes);
    if (!chk.ok) return json(req, { ok: false, errors: { photo: chk.error } }, 400);
    photoInfo = chk.info;
  }

  // CAPTCHA (opcional) e limite de envios por IP anonimizado.
  if (!(await verifyTurnstile(String(form.get('cf-turnstile-response') ?? ''), req))) {
    return json(req, { ok: false, errors: { captcha: 'Não foi possível validar a verificação de segurança. Tente novamente.' } }, 400);
  }
  const ipHash = await hashIp(req);
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const [{ count: lastHour }, { count: lastDay }, { count: pending }] = await Promise.all([
    sb.from('submission_attempts').select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).gte('created_at', since(3_600_000)),
    sb.from('submission_attempts').select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).gte('created_at', since(86_400_000)),
    sb.from('testimonials').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);
  if ((lastHour ?? 0) >= MAX_PER_HOUR || (lastDay ?? 0) >= MAX_PER_DAY) {
    return json(req, { ok: false, message: 'Muitos envios em pouco tempo. Tente novamente mais tarde.' }, 429, { 'Retry-After': '3600' });
  }
  if ((pending ?? 0) >= MAX_PENDING_TOTAL) {
    return json(req, { ok: false, message: 'O recebimento de depoimentos está temporariamente indisponível. Tente novamente mais tarde.' }, 503);
  }
  await sb.from('submission_attempts').insert({ ip_hash: ipHash });
  if (Math.random() < 0.05) await sb.from('submission_attempts').delete().lt('created_at', since(2 * 86_400_000));

  // Grava: foto (bucket privado) e depois o registro, sempre como PENDENTE.
  const id = crypto.randomUUID();
  let photoPath: string | null = null;
  if (photoBytes && photoInfo) {
    photoPath = `${id}/${crypto.randomUUID()}.${photoInfo.ext}`; // nunca usa o nome do arquivo enviado
    const { error: upErr } = await sb.storage.from(BUCKET).upload(photoPath, photoBytes, { contentType: photoInfo.type, upsert: false });
    if (upErr) return json(req, { ok: false, message: 'Não foi possível salvar a foto. Tente novamente.' }, 500);
  }

  const v = result.value;
  const { error: insErr } = await sb.from('testimonials').insert({
    id,
    author_name: v.author_name,
    author_contact: v.author_contact,
    display_choice: v.display_choice,
    display_name: v.display_name,
    profession: v.profession,
    cohort: v.cohort,
    course_key: v.course_key,
    course_detail: v.course_detail,
    body: v.body,
    original_body: v.body,
    photo_path: photoPath,
    photo_consent: v.photo_consent,
    photo_consent_at: v.photo_consent ? new Date().toISOString() : null,
    consent_own_experience: true,
    consent_publication: true,
    consent_version: raw.consent_version,
    consent_at: new Date().toISOString(),
    status: 'pending',
    published: false,
  });
  if (insErr) {
    if (photoPath) await sb.storage.from(BUCKET).remove([photoPath]);
    console.error('insert failed', insErr.code);
    return json(req, { ok: false, message: 'Não foi possível salvar o seu depoimento. Tente novamente.' }, 500);
  }
  return json(req, { ok: true }, 201);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    if (req.method === 'GET') return await listPublic(req);
    if (req.method === 'POST') return await receive(req);
    return json(req, { error: 'Método não permitido.' }, 405);
  } catch (e) {
    console.error('unhandled', e instanceof Error ? e.message : e);
    return json(req, { ok: false, message: 'Erro inesperado. Tente novamente.' }, 500);
  }
});
