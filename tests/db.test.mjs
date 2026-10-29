// Testa a migração SQL em um Postgres real (PGlite/WASM) com um "shim" mínimo
// dos objetos que o Supabase fornece (schemas auth/storage e papéis).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const OUTSIDER = '22222222-2222-2222-2222-222222222222';
let db;

async function as(role, uid, fn) {
  const email = uid === ADMIN ? 'admin@x.com' : 'x@x.com';
  await db.exec(`select set_config('request.jwt.claims', '${uid ? JSON.stringify({ sub: uid, email }) : ''}', false)`);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rejects = async (p, re) => assert.rejects(p, (e) => (re ? re.test(e.message) : true));

async function insertTestimonial(over = {}) {
  const t = {
    name: 'Maria Souza', body: 'O conteúdo da masterclass foi muito claro e me ajudou bastante na prática.',
    photo: null, photo_consent: false, ...over,
  };
  const r = await db.query(
    `insert into testimonials (author_name, display_choice, display_name, body, original_body, photo_path, photo_consent,
       consent_own_experience, consent_publication, consent_version)
     values ($1,'first_initial','Maria S.',$2,$2,$3,$4,true,true,'v1-2026-10') returning id`,
    [t.name, t.body, t.photo, t.photo_consent]);
  return r.rows[0].id;
}

before(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema extensions; create schema storage;
    create table auth.users (id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema auth, extensions, storage, public to anon, authenticated, service_role;
    grant all on all tables in schema public, storage to anon, authenticated, service_role;
    grant execute on all functions in schema auth, extensions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    insert into auth.users values ('${ADMIN}'), ('${OUTSIDER}');
  `);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261029000000_depoimentos.sql', import.meta.url), 'utf8'));
  await db.exec(`insert into admin_users (user_id) values ('${ADMIN}')`);
});

test('migração é idempotente (pode ser executada novamente)', async () => {
  await db.exec(readFileSync(new URL('../supabase/migrations/20261029000000_depoimentos.sql', import.meta.url), 'utf8'));
});

test('público (anon) não lê, não grava e não altera nada', async () => {
  const id = await insertTestimonial();
  await as('anon', null, async () => {
    await rejects(db.query('select * from testimonials'), /permission denied/);
    await rejects(db.query("insert into testimonials (author_name) values ('x')"), /permission denied/);
    await rejects(db.query("update testimonials set status='approved'"), /permission denied/);
    await rejects(db.query('delete from testimonials'), /permission denied/);
    await rejects(db.query('select * from testimonial_history'), /permission denied/);
    await rejects(db.query('select * from submission_attempts'), /permission denied/);
  });
  assert.equal((await db.query('select count(*)::int c from testimonials where id=$1', [id])).rows[0].c, 1);
});

test('usuário autenticado que NÃO é admin não vê nem altera nada', async () => {
  const id = await insertTestimonial();
  await as('authenticated', OUTSIDER, async () => {
    assert.equal((await db.query('select * from testimonials')).rows.length, 0);
    const u = await db.query("update testimonials set status='approved', published=true where id=$1", [id]);
    assert.equal(u.affectedRows, 0);
    const d = await db.query('delete from testimonials where id=$1', [id]);
    assert.equal(d.affectedRows, 0);
    await rejects(db.query('select public.set_featured_testimonials(array[]::uuid[])'), /Acesso negado/);
    await rejects(db.query('select public.confirm_author_change($1)', [id]), /Acesso negado/);
    assert.equal((await db.query('select public.is_admin() a')).rows[0].a, false);
  });
  const row = (await db.query('select status, published from testimonials where id=$1', [id])).rows[0];
  assert.deepEqual(row, { status: 'pending', published: false });
});

test('envio entra como pendente, não publicado, sem destaque; consentimento fica registrado', async () => {
  const id = await insertTestimonial();
  const r = (await db.query('select status, published, featured_position, consent_version, consent_at, consent_publication from testimonials where id=$1', [id])).rows[0];
  assert.equal(r.status, 'pending'); assert.equal(r.published, false); assert.equal(r.featured_position, null);
  assert.equal(r.consent_version, 'v1-2026-10'); assert.ok(r.consent_at); assert.equal(r.consent_publication, true);
  const h = (await db.query("select action from testimonial_history where testimonial_id=$1", [id])).rows.map((x) => x.action);
  assert.deepEqual(h, ['received']);
});

test('banco rejeita consentimento ausente e foto sem autorização', async () => {
  await rejects(db.query(`insert into testimonials (author_name, display_choice, display_name, body, original_body, consent_own_experience, consent_publication, consent_version)
    values ('Ana','full','Ana','${'x'.repeat(40)}','${'x'.repeat(40)}', false, true, 'v1-2026-10')`), /consent_own_experience/);
  await rejects(insertTestimonial({ photo: 'a/b.jpg', photo_consent: false }), /photo_requires_consent/);
});

test('admin: aprovar, publicar, destacar, ocultar, recusar e excluir', async () => {
  const id = await insertTestimonial();
  await as('authenticated', ADMIN, async () => {
    assert.equal((await db.query('select public.is_admin() a')).rows[0].a, true);
    assert.equal((await db.query('select * from testimonials where id=$1', [id])).rows.length, 1);
    // não dá para publicar sem aprovar: o banco neutraliza a tentativa
    await db.query("update testimonials set published=true where id=$1", [id]);
    assert.equal((await db.query('select published p from testimonials where id=$1', [id])).rows[0].p, false);
    await db.query("update testimonials set status='approved' where id=$1", [id]);
    await db.query("update testimonials set published=true where id=$1", [id]);
    await db.query('select set_featured_testimonials(array[$1]::uuid[])', [id]);
    let r = (await db.query('select status, published, featured_position, published_at, reviewed_by from testimonials where id=$1', [id])).rows[0];
    assert.equal(r.status, 'approved'); assert.equal(r.published, true); assert.equal(r.featured_position, 1);
    assert.ok(r.published_at); assert.equal(r.reviewed_by, ADMIN);
    // ocultar remove o destaque automaticamente
    await db.query("update testimonials set published=false where id=$1", [id]);
    r = (await db.query('select published, featured_position from testimonials where id=$1', [id])).rows[0];
    assert.deepEqual(r, { published: false, featured_position: null });
    // recusar mantém oculto
    await db.query("update testimonials set published=true where id=$1", [id]);
    await db.query("update testimonials set status='rejected' where id=$1", [id]);
    r = (await db.query('select status, published from testimonials where id=$1', [id])).rows[0];
    assert.deepEqual(r, { status: 'rejected', published: false });
    const d = await db.query('delete from testimonials where id=$1', [id]);
    assert.equal(d.affectedRows, 1);
  });
  const acts = (await db.query('select action from testimonial_history where testimonial_id=$1 order by id', [id])).rows.map((x) => x.action);
  for (const a of ['received', 'approved', 'published', 'featured', 'unpublished', 'unfeatured', 'rejected', 'deleted']) {
    assert.ok(acts.includes(a), `histórico deveria conter "${a}" (tem: ${acts})`);
  }
  const hist = (await db.query('select details::text d from testimonial_history where testimonial_id=$1', [id])).rows.map((x) => x.d).join('');
  assert.ok(!hist.includes('masterclass'), 'histórico não deve copiar o texto do depoimento');
});

test('admin não consegue alterar campos protegidos (autor, consentimentos, texto original, destaque direto)', async () => {
  const id = await insertTestimonial();
  await as('authenticated', ADMIN, async () => {
    for (const col of ["author_name='Outro'", 'consent_publication=true', "original_body='falso falso falso falso falso falso'", 'featured_position=1', "consent_version='v9'"]) {
      await rejects(db.query(`update testimonials set ${col} where id=$1`, [id]), /permission denied/);
    }
    await rejects(db.query("update testimonials set photo_consent=true where id=$1", [id]), /só pode ser concedida pelo participante/);
    await rejects(db.query("insert into testimonials (author_name) values ('x')"), /permission denied/);
  });
});

test('correção ortográfica não exige confirmação; reescrita substancial exige e bloqueia publicação', async () => {
  const id = await insertTestimonial();
  const id2 = await insertTestimonial();
  await as('authenticated', ADMIN, async () => {
    await db.query("update testimonials set status='approved' where id=$1", [id]);
    await db.query("update testimonials set body='O conteúdo da masterclass foi muito claro e me ajudou bastante na prática!' where id=$1", [id]);
    let r = (await db.query('select needs_author_confirmation n from testimonials where id=$1', [id])).rows[0];
    assert.equal(r.n, false);
    await db.query("update testimonials set published=true where id=$1", [id]);
    // reescrita grande
    await db.query("update testimonials set body='Esta foi a melhor experiência de formação que já tive, recomendo para todo mundo sem exceção, mudou minha carreira inteira.' where id=$1", [id]);
    r = (await db.query('select needs_author_confirmation n, published p from testimonials where id=$1', [id])).rows[0];
    assert.equal(r.n, true); assert.equal(r.p, false, 'deve sair da exibição pública');
    await rejects(db.query("update testimonials set published=true where id=$1", [id]), /confirma/i);
    // não dá para limpar a pendência diretamente
    await rejects(db.query("update testimonials set needs_author_confirmation=false where id=$1", [id]), /confirmação do autor/);
    // registrar confirmação libera
    await db.query("select confirm_author_change($1, 'Autor confirmou por WhatsApp')", [id]);
    await db.query("update testimonials set published=true where id=$1", [id]);
    r = (await db.query('select needs_author_confirmation n, published p, author_confirmed_at a, admin_note from testimonials where id=$1', [id])).rows[0];
    assert.equal(r.n, false); assert.equal(r.p, true); assert.ok(r.a); assert.match(r.admin_note, /WhatsApp/);
    // restaurar o texto original também resolve a pendência
    await db.query("update testimonials set body='Texto totalmente diferente, escrito pela administração, com outras palavras e ideias.' where id=$1", [id2]);
    assert.equal((await db.query('select needs_author_confirmation n from testimonials where id=$1', [id2])).rows[0].n, true);
    await db.query("update testimonials set body=original_body where id=$1", [id2]);
    assert.equal((await db.query('select needs_author_confirmation n from testimonials where id=$1', [id2])).rows[0].n, false);
    // marcação manual
    await db.query("update testimonials set needs_author_confirmation=true where id=$1", [id2]);
    assert.equal((await db.query('select needs_author_confirmation n from testimonials where id=$1', [id2])).rows[0].n, true);
  });
});

test('destaques: máximo 5, só aprovados+publicados, ordem definida pela administração', async () => {
  await db.exec('delete from testimonials');
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push(await insertTestimonial({ name: `Pessoa ${i}` }));
  await db.exec(`update testimonials set status='approved', published=true where id in ('${ids.slice(0, 6).join("','")}')`);
  await as('authenticated', ADMIN, async () => {
    await rejects(db.query('select set_featured_testimonials($1::uuid[])', [ids.slice(0, 6)]), /No máximo 5/);
    await rejects(db.query('select set_featured_testimonials($1::uuid[])', [[ids[0], ids[6]]]), /aprovados e publicados/);
    await rejects(db.query('select set_featured_testimonials($1::uuid[])', [[ids[0], ids[0]]]), /repetido/);
    const order = [ids[3], ids[0], ids[5], ids[1], ids[4]];
    await db.query('select set_featured_testimonials($1::uuid[])', [order]);
    let rows = (await db.query('select id from testimonials where featured_position is not null order by featured_position')).rows.map((r) => r.id);
    assert.deepEqual(rows, order);
    // reordenar
    const order2 = [ids[4], ids[3]];
    await db.query('select set_featured_testimonials($1::uuid[])', [order2]);
    rows = (await db.query('select id from testimonials where featured_position is not null order by featured_position')).rows.map((r) => r.id);
    assert.deepEqual(rows, order2);
    // ocultar um destaque libera a vaga
    await db.query('update testimonials set published=false where id=$1', [ids[4]]);
    rows = (await db.query('select id from testimonials where featured_position is not null order by featured_position')).rows.map((r) => r.id);
    assert.deepEqual(rows, [ids[3]]);
    // lista vazia limpa tudo
    await db.query('select set_featured_testimonials(array[]::uuid[])');
    assert.equal((await db.query('select count(*)::int c from testimonials where featured_position is not null')).rows[0].c, 0);
  });
});

test('autorização de foto: administração não pode conceder; revogar exige remover a foto', async () => {
  const id = await insertTestimonial({ photo: 'x/foto.jpg', photo_consent: true });
  const id2 = await insertTestimonial();
  await as('authenticated', ADMIN, async () => {
    await rejects(db.query('update testimonials set photo_consent=false where id=$1', [id]), /Remova a foto/);
    await db.query('update testimonials set photo_path=null, photo_consent=false where id=$1', [id]);
    await rejects(db.query('update testimonials set photo_path=$2 where id=$1', [id2, 'y/z.jpg']), /photo_requires_consent/);
  });
  const acts = (await db.query('select action from testimonial_history where testimonial_id=$1', [id])).rows.map((x) => x.action);
  assert.ok(acts.includes('photo_removed') && acts.includes('photo_consent_revoked'));
});

test('bucket de fotos é privado, com limite e tipos permitidos; só admin acessa objetos', async () => {
  const b = (await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id='testimonial-photos'")).rows[0];
  assert.equal(b.public, false); assert.equal(Number(b.file_size_limit), 5242880);
  assert.deepEqual(b.allowed_mime_types, ['image/jpeg', 'image/png', 'image/webp']);
  await db.exec("insert into storage.objects (bucket_id, name) values ('testimonial-photos', 'a/b.jpg')");
  await as('anon', null, async () => assert.equal((await db.query('select * from storage.objects')).rows.length, 0));
  await as('authenticated', OUTSIDER, async () => {
    assert.equal((await db.query('select * from storage.objects')).rows.length, 0);
    await rejects(db.query("insert into storage.objects (bucket_id, name) values ('testimonial-photos','hack.jpg')"), /row-level security/);
  });
  await as('authenticated', ADMIN, async () => assert.equal((await db.query('select * from storage.objects')).rows.length, 1));
});

test('textos de consentimento da migração = textos exibidos no formulário', async () => {
  const html = readFileSync(new URL('../enviar-depoimento/index.html', import.meta.url), 'utf8');
  const row = (await db.query("select * from consent_texts where version='v1-2026-10'")).rows[0];
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const txt of [row.own_experience_text, row.publication_text, row.photo_text]) {
    assert.ok(decode(html).replace(/\s+/g, ' ').includes(txt), `Texto não encontrado no formulário: ${txt.slice(0, 60)}…`);
  }
});
