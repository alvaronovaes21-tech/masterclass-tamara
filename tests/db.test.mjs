// Testa a migração SQL em um Postgres real (PGlite/WASM) com um "shim" mínimo
// dos objetos que o Supabase fornece (schemas auth/storage e papéis).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, MIGRATION_FILES, readMigration } from './helpers/db.mjs';

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
  db = await createDb({ adminId: ADMIN, otherIds: [OUTSIDER] }); // TODAS as migrações, em ordem
});

test('migrações são idempotentes (podem ser executadas novamente)', async () => {
  for (let i = 0; i < MIGRATION_FILES.length; i++) await db.exec(readMigration(i));
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

test('textos de consentimento da migração (v2) = textos exibidos no formulário; v1 continua registrada', async () => {
  const html = readFileSync(new URL('../enviar-depoimento/index.html', import.meta.url), 'utf8');
  const version = /data-consent-version="([^"]+)"/.exec(html)[1];
  assert.equal(version, 'v2-2026-10');
  const row = (await db.query('select * from consent_texts where version=$1', [version])).rows[0];
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const page = decode(html).replace(/\s+/g, ' ');
  for (const txt of [row.own_experience_text, row.publication_text, row.photo_text]) {
    assert.ok(page.includes(txt), `Texto não encontrado no formulário: ${txt.slice(0, 60)}…`);
  }
  // frases exigidas
  assert.equal(row.own_experience_text, 'Declaro que este depoimento relata uma experiência real que tive em um curso, evento ou formação ministrado por Tâmara San’Galo ou por sua equipe.');
  assert.equal(row.publication_text, 'Autorizo que meu depoimento seja analisado pela administração e, se aprovado, publicado neste site com a identificação pública que escolhi. Estou ciente de que a publicação é opcional, que o texto poderá receber correções ortográficas e de digitação sem alteração do seu sentido e que posso solicitar a retirada do depoimento pelo e-mail informado na Política de Privacidade.');
  // a v1 NÃO foi alterada (depoimentos antigos continuam apontando para o texto que aceitaram)
  const v1 = (await db.query("select own_experience_text from consent_texts where version='v1-2026-10'")).rows[0];
  assert.match(v1.own_experience_text, /minha própria experiência como participante da Masterclass/);
  assert.ok(!page.includes(v1.own_experience_text), 'texto antigo não pode continuar no formulário');
});

// ---------------------------------------------------------------------
// Curso ou evento
async function insertV2(over = {}) {
  const t = { key: 'weekend_pass', detail: null, name: 'Pessoa V2', body: 'Participei do evento e o conteúdo foi muito claro e aplicável ao meu dia a dia.', ...over };
  const r = await db.query(
    `insert into testimonials (author_name, display_choice, display_name, body, original_body, consent_own_experience, consent_publication,
       consent_version, course_key, course_detail)
     values ($1,'first','Pessoa',$2,$2,true,true,'v2-2026-10',$3,$4) returning id`, [t.name, t.body, t.key, t.detail]);
  return r.rows[0].id;
}
const courseRow = async (id) => (await db.query('select course_key, course_detail, course_detail_public, course_key_original, course_detail_original from testimonials where id=$1', [id])).rows[0];

test('curso/evento: cada opção é aceita; "outro" e "varios" exigem o complemento; nas demais ele não existe', async () => {
  for (const key of ['masterclass', 'at_pratica', 'weekend_pass', 'imersao_crise']) {
    const id = await insertV2({ key });
    assert.deepEqual(await courseRow(id), { course_key: key, course_detail: null, course_detail_public: false, course_key_original: key, course_detail_original: null });
  }
  const o = await insertV2({ key: 'outro', detail: '  Curso   de   ABA  ' });
  assert.deepEqual(await courseRow(o), { course_key: 'outro', course_detail: 'Curso de ABA', course_detail_public: false, course_key_original: 'outro', course_detail_original: 'Curso de ABA' });
  const v = await insertV2({ key: 'varios', detail: 'Weekend Pass e A.T. na Prática' });
  assert.equal((await courseRow(v)).course_detail, 'Weekend Pass e A.T. na Prática');
  // o complemento enviado junto de uma opção que não o usa é descartado pelo banco
  const w = await insertV2({ key: 'weekend_pass', detail: 'lixo' });
  assert.equal((await courseRow(w)).course_detail, null);
  // regras de integridade
  await rejects(insertV2({ key: 'outro', detail: null }), /testimonials_course_detail_rule/);
  await rejects(insertV2({ key: 'varios', detail: ' ' }), /testimonials_course_detail_rule/);
  await rejects(insertV2({ key: 'outro', detail: 'x' }), /testimonials_course_detail_rule/);
  await rejects(insertV2({ key: 'outro', detail: 'x'.repeat(201) }), /testimonials_course_detail_rule/);
  await rejects(insertV2({ key: 'curso_inventado' }), /testimonials_course_key(_original)?_valid/);
  await rejects(insertV2({ key: null }), /testimonials_course_required_since_v2/);
});

test('curso/evento: depoimentos antigos (v1) são preservados e ficam sem curso ("não informado")', async () => {
  const old = await insertTestimonial();                       // formato antigo: v1, sem curso
  assert.deepEqual(await courseRow(old), { course_key: null, course_detail: null, course_detail_public: false, course_key_original: null, course_detail_original: null });
  // continuam podendo ser aprovados e publicados sem inventar curso
  await as('authenticated', ADMIN, async () => {
    await db.query("update testimonials set status='approved', published=true where id=$1", [old]);
    assert.equal((await courseRow(old)).course_key, null);
  });
});

test('migração 2 sobre um banco já em uso: preserva depoimentos, destaques e consentimentos (v1)', async () => {
  const db1 = await createDb({ adminId: ADMIN, otherIds: [OUTSIDER], migrations: 1 });   // estado de produção ANTES da atualização
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await db1.query(
      `insert into testimonials (author_name, display_choice, display_name, body, original_body, consent_own_experience, consent_publication, consent_version,
         status, published, published_at, profession)
       values ($1,'first',$1,$2,$2,true,true,'v1-2026-10','approved',true,now(),'Psicóloga') returning id`,
      [`Antigo${i}`, `Texto antigo número ${i} publicado antes da atualização do formulário.`]);
    ids.push(r.rows[0].id);
  }
  await db1.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: ADMIN, email: 'a@x.com' })}', false); set role authenticated`);
  await db1.query('select set_featured_testimonials($1::uuid[])', [[ids[2], ids[0]]]);
  await db1.exec('reset role');
  const before = (await db1.query('select id, display_name, body, status, published, featured_position, consent_version, consent_at, profession from testimonials order by display_name')).rows;
  assert.equal(before.length, 3);

  await db1.exec(readMigration(1));                                                          // aplica a atualização
  const after = (await db1.query('select id, display_name, body, status, published, featured_position, consent_version, consent_at, profession from testimonials order by display_name')).rows;
  assert.deepEqual(after, before, 'nenhum campo existente pode mudar');
  assert.deepEqual((await db1.query('select featured_position p from testimonials where featured_position is not null order by featured_position')).rows.length, 2);
  const c = (await db1.query('select course_key, course_detail, course_detail_public, course_key_original from testimonials')).rows;
  assert.ok(c.every((r) => r.course_key === null && r.course_detail === null && r.course_detail_public === false && r.course_key_original === null), 'nenhum curso é atribuído retroativamente');
  // e a nova versão do texto convive com a antiga
  assert.deepEqual((await db1.query('select version from consent_texts order by version')).rows.map((r) => r.version), ['v1-2026-10', 'v2-2026-10']);
  await db1.close();
});

test('curso/evento: administração corrige a identificação sem alterar o que o participante informou nem o relato', async () => {
  const id = await insertV2({ key: 'outro', detail: 'Curso de Aba' });
  await as('authenticated', ADMIN, async () => {
    await db.query("update testimonials set status='approved', published=true where id=$1", [id]);
    // corrige o nome do curso (ex.: ortografia) e publica
    await db.query("update testimonials set course_detail='Curso de ABA' where id=$1", [id]);
    let r = await courseRow(id);
    assert.equal(r.course_detail, 'Curso de ABA'); assert.equal(r.course_detail_original, 'Curso de Aba', 'o informado originalmente permanece');
    // troca para uma opção padrão: o complemento some
    await db.query("update testimonials set course_key='weekend_pass' where id=$1", [id]);
    r = await courseRow(id);
    assert.deepEqual(r, { course_key: 'weekend_pass', course_detail: null, course_detail_public: false, course_key_original: 'outro', course_detail_original: 'Curso de Aba' });
    // "varios": a lista só é pública se a administração autorizar; nas outras opções não é possível
    await db.query("update testimonials set course_key='varios', course_detail='Weekend Pass e Imersão' where id=$1", [id]);
    assert.equal((await courseRow(id)).course_detail_public, false);
    await db.query("update testimonials set course_detail_public=true where id=$1", [id]);
    assert.equal((await courseRow(id)).course_detail_public, true);
    await db.query("update testimonials set course_key='masterclass' where id=$1", [id]);
    assert.equal((await courseRow(id)).course_detail_public, false, 'autorização de lista não sobrevive à troca de opção');
    // edição do curso não mexe no relato nem em publicação
    const t = (await db.query('select body, original_body, published, needs_author_confirmation n from testimonials where id=$1', [id])).rows[0];
    assert.equal(t.body, t.original_body); assert.equal(t.published, true); assert.equal(t.n, false);
    // campos protegidos
    for (const col of ["course_key_original='masterclass'", "course_detail_original='x'"]) {
      await rejects(db.query(`update testimonials set ${col} where id=$1`, [id]), /permission denied/);
    }
    // não pode voltar a "não informado" nem a uma opção inventada
    await rejects(db.query('update testimonials set course_key=null where id=$1', [id]), /testimonials_course_required_since_v2/);
    await rejects(db.query("update testimonials set course_key='inventado' where id=$1", [id]), /testimonials_course_key_valid/);
  });
  // sem permissão: público e conta comum não alteram
  await as('authenticated', OUTSIDER, async () => {
    const u = await db.query("update testimonials set course_key='at_pratica' where id=$1", [id]);
    assert.equal(u.affectedRows, 0);
  });
  await as('anon', null, async () => rejects(db.query("update testimonials set course_key='at_pratica'"), /permission denied/));
  const acts = (await db.query('select action, details::text d from testimonial_history where testimonial_id=$1 and action=$2', [id, 'course_edited'])).rows;
  assert.ok(acts.length >= 4, 'cada correção do curso fica no histórico');
  assert.ok(!acts.map((a) => a.d).join('').includes('ABA'), 'histórico não copia o texto informado');
});
