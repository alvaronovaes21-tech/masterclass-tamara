import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detectImage, checkPhoto, validateSubmission, makeDisplayName, publicCourseLabel, CONSENT_VERSION, COURSES, COURSE_KEYS } from '../supabase/functions/testimonials/validate.ts';

const img = (w, h, fmt, opts = {}) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } })[fmt](opts).toBuffer().then((b) => new Uint8Array(b));

test('detecta JPEG, PNG e WebP reais e lê as dimensões', async () => {
  for (const [fmt, type] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
    const info = detectImage(await img(640, 480, fmt));
    assert.equal(info?.type, type, fmt);
    assert.deepEqual([info.width, info.height], [640, 480], fmt);
  }
  // WebP sem perdas (VP8L)
  const ll = detectImage(await img(333, 222, 'webp', { lossless: true }));
  assert.deepEqual([ll.type, ll.width, ll.height], ['image/webp', 333, 222]);
});

test('rejeita arquivos que NÃO são imagens, mesmo com nome/tipo falsos', async () => {
  const exe = new Uint8Array(2000); exe.set([0x4d, 0x5a, 0x90, 0x00]);               // "MZ" executável
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' + ' '.repeat(100) + '</svg>');
  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>' + ' '.repeat(100));
  const gif = new Uint8Array(2000); gif.set(new TextEncoder().encode('GIF89a'));
  const pdf = new Uint8Array(2000); pdf.set(new TextEncoder().encode('%PDF-1.7'));
  for (const [n, b] of Object.entries({ exe, svg, html, gif, pdf })) {
    assert.equal(checkPhoto(b).ok, false, n);
  }
  // JPEG truncado / cabeçalho corrompido
  const jpg = await img(300, 300, 'jpeg');
  assert.equal(detectImage(jpg.slice(0, 20)), null);
  // Executável anexado depois de um cabeçalho PNG falso não passa na checagem de IHDR
  const fake = new Uint8Array(100); fake.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(checkPhoto(fake).ok, false);
});

test('limites de tamanho e dimensões', async () => {
  assert.equal(checkPhoto(await img(800, 800, 'jpeg')).ok, true);
  const small = checkPhoto(await img(100, 100, 'png'));
  assert.equal(small.ok, false); assert.match(small.error, /pequena/);
  // PNG com cabeçalho declarando 20000x20000 (bomba de descompressão)
  const bomb = await img(300, 300, 'png');
  new DataView(bomb.buffer).setUint32(16, 20000); new DataView(bomb.buffer).setUint32(20, 20000);
  const big = checkPhoto(bomb);
  assert.equal(big.ok, false); assert.match(big.error, /dimensões/);
  // > 5 MB
  const huge = new Uint8Array(5 * 1024 * 1024 + 1); huge.set((await img(300, 300, 'jpeg')).slice(0, 200));
  const hr = checkPhoto(huge);
  assert.equal(hr.ok, false); assert.match(hr.error, /5 MB/);
});

const good = () => ({
  author_name: 'Maria Souza Lima', display_choice: 'first_initial', custom_name: '', profession: 'Psicopedagoga', cohort: 'Turma 1',
  contact: 'maria@exemplo.com', body: 'A masterclass foi muito clara e me ajudou a organizar minha prática com as crianças.',
  course: 'masterclass', course_detail: '',
  consent_own: 'true', consent_publication: 'true', photo_consent: 'false', consent_version: CONSENT_VERSION, website: '', elapsed: '45000',
});

test('envio válido gera o registro esperado', () => {
  const r = validateSubmission(good(), false);
  assert.equal(r.bot, false); assert.deepEqual(r.errors, {});
  assert.equal(r.value.display_name, 'Maria L.');
  assert.equal(r.value.photo_consent, false);
  assert.equal(r.value.author_contact, 'maria@exemplo.com');
});

test('opções de identificação pública', () => {
  assert.equal(makeDisplayName('full', 'Maria Souza Lima', ''), 'Maria Souza Lima');
  assert.equal(makeDisplayName('first', 'Maria Souza Lima', ''), 'Maria');
  assert.equal(makeDisplayName('first_initial', 'Maria Souza Lima', ''), 'Maria L.');
  assert.equal(makeDisplayName('first_initial', 'Maria', ''), 'Maria');
  assert.equal(makeDisplayName('custom', 'Maria Souza', 'Mãe da Ana'), 'Mãe da Ana');
  assert.equal(makeDisplayName('first_initial', 'Élida Ângelo', ''), 'Élida Â.');
});

test('consentimentos obrigatórios e separados; foto exige autorização própria', () => {
  const miss = (patch, field) => {
    const r = validateSubmission({ ...good(), ...patch }, patch.__photo === true);
    delete patch.__photo;
    assert.ok(r.errors[field], `esperava erro em ${field}`);
  };
  miss({ consent_own: 'false' }, 'consent_own');
  miss({ consent_publication: '' }, 'consent_publication');
  miss({ consent_version: 'v0' }, 'consent_version');
  // foto enviada sem autorização de imagem
  const r = validateSubmission({ ...good(), photo_consent: 'false' }, true);
  assert.ok(r.errors.photo_consent);
  // texto autorizado, foto não enviada: tudo bem, mesmo com photo_consent marcado fica falso
  const ok = validateSubmission({ ...good(), photo_consent: 'true' }, false);
  assert.equal(ok.value.photo_consent, false);
  // foto + autorização
  assert.equal(validateSubmission({ ...good(), photo_consent: 'true' }, true).value.photo_consent, true);
});

test('validações de texto: tamanho, XSS, links, contato', () => {
  const err = (patch, field) => assert.ok(validateSubmission({ ...good(), ...patch }, false).errors[field], `${field} ← ${JSON.stringify(patch)}`);
  err({ author_name: '' }, 'author_name');
  err({ author_name: '<script>alert(1)</script>' }, 'author_name');
  err({ body: 'curto demais' }, 'body');
  err({ body: 'a'.repeat(1001) }, 'body');
  err({ body: 'Muito bom <img src=x onerror=alert(1)> o curso, recomendo muito mesmo' }, 'body');
  err({ body: 'Ótimo curso, visite http://spam.example para ganhar dinheiro fácil' }, 'body');
  err({ body: 'Ótimo curso, visite www.spam para ganhar dinheiro fácil agora mesmo' }, 'body');
  err({ display_choice: 'hack' }, 'display_choice');
  err({ display_choice: 'custom', custom_name: '' }, 'custom_name');
  err({ display_choice: 'custom', custom_name: '<b>x</b>' }, 'custom_name');
  err({ contact: 'isso não é contato' }, 'contact');
  err({ profession: 'x'.repeat(81) }, 'profession');
  // "<3" (coração) e acentos são aceitos
  assert.deepEqual(validateSubmission({ ...good(), body: 'Adorei a masterclass, aprendi muito sobre comportamento e função <3 obrigada!' }, false).errors, {});
  // telefone aceito
  assert.deepEqual(validateSubmission({ ...good(), contact: '(11) 91234-5678' }, false).errors, {});
});

test('curso/evento: opções aceitas, obrigatoriedade e complementos (validação no servidor)', () => {
  assert.equal(CONSENT_VERSION, 'v2-2026-10');
  assert.deepEqual(COURSE_KEYS, ['masterclass', 'at_pratica', 'weekend_pass', 'imersao_crise', 'outro', 'varios']);
  for (const key of ['masterclass', 'at_pratica', 'weekend_pass', 'imersao_crise']) {
    const r = validateSubmission({ ...good(), course: key, course_detail: 'ignorado' }, false);
    assert.deepEqual(r.errors, {}, key); assert.equal(r.value.course_key, key); assert.equal(r.value.course_detail, null, 'complemento ignorado nas opções padrão');
  }
  const o = validateSubmission({ ...good(), course: 'outro', course_detail: '  Curso   de ABA ' }, false);
  assert.deepEqual(o.errors, {}); assert.equal(o.value.course_detail, 'Curso de ABA');
  const v = validateSubmission({ ...good(), course: 'varios', course_detail: 'Weekend Pass e A.T. na Prática' }, false);
  assert.deepEqual(v.errors, {}); assert.equal(v.value.course_detail, 'Weekend Pass e A.T. na Prática');

  const err = (patch, field) => assert.ok(validateSubmission({ ...good(), ...patch }, false).errors[field], `${field} ← ${JSON.stringify(patch)}`);
  err({ course: '' }, 'course');
  err({ course: undefined }, 'course');
  err({ course: 'curso_inventado' }, 'course');
  err({ course: '<script>' }, 'course');
  err({ course: 'outro', course_detail: '' }, 'course_detail');
  err({ course: 'outro', course_detail: 'x' }, 'course_detail');
  err({ course: 'outro', course_detail: 'x'.repeat(121) }, 'course_detail');
  err({ course: 'varios', course_detail: '' }, 'course_detail');
  err({ course: 'varios', course_detail: 'y'.repeat(201) }, 'course_detail');
  err({ course: 'outro', course_detail: '<b>Curso</b>' }, 'course_detail');
  err({ course: 'varios', course_detail: 'veja http://spam.example' }, 'course_detail');
  assert.equal(validateSubmission({ ...good(), course: 'outro', course_detail: 'y'.repeat(120) }, false).errors.course_detail, undefined);
  assert.match(validateSubmission({ ...good(), consent_own: 'false' }, false).errors.consent_own, /experiência real/);
});

test('curso/evento: identificação pública montada no servidor', () => {
  assert.equal(publicCourseLabel('masterclass'), 'Participante da Masterclass — Do Comportamento à Aprendizagem');
  assert.equal(publicCourseLabel('at_pratica'), 'Participante do A.T. na Prática');
  assert.equal(publicCourseLabel('weekend_pass'), 'Participante do Weekend Pass');
  assert.equal(publicCourseLabel('imersao_crise'), 'Participante da Imersão em Gerenciamento de Crise');
  assert.equal(publicCourseLabel('outro', 'Curso de ABA'), 'Participante de: Curso de ABA');
  assert.equal(publicCourseLabel('varios', 'Weekend Pass e A.T.', false), 'Participante de múltiplas formações');
  assert.equal(publicCourseLabel('varios', 'Weekend Pass e A.T.', true), 'Participante de: Weekend Pass e A.T.');
  assert.equal(publicCourseLabel('varios', null, true), 'Participante de múltiplas formações');
  // sem informação (depoimentos antigos) ou valor desconhecido: nada é inventado
  assert.equal(publicCourseLabel(null), null);
  assert.equal(publicCourseLabel(undefined, 'x', true), null);
  assert.equal(publicCourseLabel('inventado', 'x', true), null);
  assert.equal(publicCourseLabel('outro', null), null);
  assert.equal(COURSES.outro, 'Outro curso ou evento'); assert.equal(COURSES.varios, 'Mais de um curso ou evento');
});

test('antiabuso: campo-isca e preenchimento instantâneo são descartados como bot', () => {
  assert.equal(validateSubmission({ ...good(), website: 'http://spam' }, false).bot, true);
  assert.equal(validateSubmission({ ...good(), elapsed: '800' }, false).bot, true);
});
