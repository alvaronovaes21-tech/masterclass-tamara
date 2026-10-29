// Testes de ponta a ponta: navegador real (Chromium via Playwright, com emulação de celulares) +
// servidor de teste (Postgres real + migração real + Edge Function real). Veja tests/helpers/server.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium, devices } from 'playwright';
import { startServer, ADMIN, OTHER, ANON_KEY } from './helpers/server.mjs';

const HOTMART = 'https://pay.hotmart.com/H107524355I?bid=1792577203766';
const TMP = fileURLToPath(new URL('./.tmp/', import.meta.url));
const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let server, browser, origin, files = new Map();
const consoleErrors = [];
const GOOD_BODY = 'A masterclass foi muito clara e me ajudou a organizar a minha prática com as crianças.';

before(async () => {
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); mkdirSync(SHOTS, { recursive: true });
  server = await startServer({ dataDir: TMP + 'pgdata', files });
  origin = server.origin;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

async function newPage(deviceName, opts = {}) {
  const ctx = await browser.newContext(deviceName ? { ...devices[deviceName] } : { viewport: { width: 1366, height: 800 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !opts.allowErrors) consoleErrors.push(`${m.text()} @ ${page.url()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message} @ ${page.url()}`));
  // recursos externos (Google Tag, miniatura do YouTube) são respondidos vazios para o teste ser offline e determinístico
  await page.route(/googletagmanager\.com|google-analytics|doubleclick/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await page.route(/i\.ytimg\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG1 }));
  return page;
}

async function submitDirect(over = {}, photo = null, ip = '198.51.100.1') {
  const fd = new FormData();
  const base = { author_name: 'Ana Paula Costa', display_choice: 'first_initial', custom_name: '', profession: 'Professora', cohort: 'Turma 2', contact: '', body: GOOD_BODY,
    course: 'masterclass', course_detail: '', consent_own: 'true', consent_publication: 'true', photo_consent: 'false', consent_version: 'v2-2026-10', website: '', elapsed: '60000' };
  for (const [k, v] of Object.entries({ ...base, ...over })) fd.append(k, v);
  if (photo) fd.append('photo', new Blob([photo.bytes], { type: photo.type || 'image/jpeg' }), photo.name || 'foto.jpg');
  const r = await fetch(origin + '/functions/v1/testimonials', { method: 'POST', body: fd, headers: { 'x-test-ip': ip } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const rows = async (sql, p) => (await server.sql(sql, p)).rows;
const strip0 = (l) => ({ f: l.featured.map((x) => x.name), o: l.others.map((x) => x.name) });
const publicList = async () => (await fetch(origin + '/functions/v1/testimonials')).json();

async function jpeg(w, h, noise = false) {
  const base = noise ? { create: { width: w, height: h, channels: 3, background: '#888', noise: { type: 'gaussian', mean: 128, sigma: 40 } } } : { create: { width: w, height: h, channels: 3, background: '#4488cc' } };
  return sharp(base).jpeg({ quality: 92 }).toBuffer();
}

// =====================================================================
test('1. Landing (desktop): primeira tela em 2 colunas, textos, vídeo e botões de compra → Hotmart', async () => {
  const page = await newPage();
  await page.goto(origin + '/');
  await page.waitForLoadState('networkidle');

  assert.equal((await page.locator('h1').innerText()).replace(/\s+/g, ' '), 'Por trás de cada comportamento, existe algo que precisa ser compreendido.');
  assert.match(await page.locator('.lead').innerText(), /Aprenda a identificar as 4 funções do comportamento e conheça estratégias práticas para lidar com situações desafiadoras na escola e na clínica\./);
  const facts = await page.locator('.hero__details').innerText();
  for (const t of [/Masterclass online/, /2 horas/, /R\$\s?22,00/, /profissionais e estudantes da saúde e da educação/, /Acesso conforme as condições informadas na oferta/]) assert.match(facts, t);
  assert.match((await page.locator('.hero__cta .btn').innerText()).replace(/\s+/g, ' '), /Quero acessar a Masterclass por R\$ 22/);

  // duas colunas: vídeo à direita do texto principal, ambos na primeira tela
  const main = await page.locator('.hero__main').boundingBox(), media = await page.locator('.hero__media').boundingBox();
  assert.ok(media.x > main.x + main.width * 0.8, 'vídeo deve ficar na coluna da direita');
  assert.ok(media.y < 800 && main.y < 800, 'ambos visíveis na primeira tela');
  await page.waitForSelector('.video__thumb'); // vídeo atual preservado (YouTube data-video-id)
  assert.equal(await page.getAttribute('#video-box', 'data-video-id'), 'A9B94ZTYWag');
  await page.screenshot({ path: SHOTS + 'landing-desktop.png' });

  // todos os links de compra apontam para o MESMO checkout atual
  const hrefs = await page.$$eval('a[href*="hotmart"]', (as) => as.map((a) => ({ href: a.href, target: a.target, rel: a.rel })));
  assert.ok(hrefs.length >= 6, 'botões de compra em pontos estratégicos: ' + hrefs.length);
  for (const a of hrefs) { assert.equal(a.href, HOTMART); assert.equal(a.target, '_blank'); assert.match(a.rel, /noopener/); }
  // nenhum outro link de pagamento inventado
  assert.equal(await page.$$eval('a[href*="pay."], a[href*="checkout"]', (as) => as.filter((a) => !a.href.startsWith('https://pay.hotmart.com/H107524355I')).length), 0);

  // clique em um botão: abre o checkout em nova aba + evento SEPARADO e SEM dados pessoais (não é compra)
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.hero__cta .btn').click()]);
  assert.equal(popup.url(), HOTMART);
  const dl = await page.evaluate(() => window.dataLayer.map((x) => Array.from(x)));
  const ev = dl.find((x) => x[0] === 'event' && x[1] === 'clique_checkout_hotmart');
  assert.ok(ev, 'evento clique_checkout_hotmart');
  assert.deepEqual(ev[2], { cta_local: 'hero' });
  assert.ok(!dl.some((x) => x[0] === 'event' && /purchase|compra|conversion/i.test(String(x[1]))), 'clique NÃO pode virar compra/conversão');
  await popup.close();

  // tags de rastreamento não duplicadas
  assert.equal(await page.locator('script[src*="googletagmanager"]').count(), 1);
  assert.equal(await page.locator('script[src*="gtag-init"]').count(), 1);

  // Instagram: nova aba, atributos de segurança, ícone SVG inline (sem dependência)
  const ig = page.locator('#autora a.link-ig');
  assert.equal(await ig.getAttribute('href'), 'https://www.instagram.com/tamarasangalo.psicologa/');
  assert.equal(await ig.getAttribute('target'), '_blank');
  assert.match(await ig.getAttribute('rel'), /noopener/); assert.match(await ig.getAttribute('rel'), /noreferrer/);
  assert.match(await ig.innerText(), /Conheça mais do meu trabalho no Instagram/);
  assert.equal(await ig.locator('svg').count(), 1);
  const [igPage] = await Promise.all([page.waitForEvent('popup'), ig.click()]);
  assert.match(igPage.url(), /^https:\/\/www\.instagram\.com\/tamarasangalo\.psicologa\/?/);
  await igPage.close();
  const footIg = page.locator('footer a[href*="instagram.com/tamarasangalo.psicologa"]');
  assert.equal(await footIg.getAttribute('target'), '_blank'); assert.match(await footIg.getAttribute('rel'), /noopener/);

  // foto da Tâmara (WebP com fallback JPEG) carrega
  await page.locator('#autora').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#autora img')?.complete);
  assert.equal(await page.locator('#autora img').evaluate((i) => i.naturalWidth > 0), true);
  assert.match(await page.locator('#autora img').getAttribute('alt'), /Tâmara San'Galo Novaes/);

  // ordem das seções: depoimentos depois do conteúdo e antes da autora
  const order = await page.$$eval('main > section', (s) => s.map((x) => x.id || x.className));
  assert.ok(order.indexOf('conteudo') < order.indexOf('depoimentos') && order.indexOf('depoimentos') < order.indexOf('autora'), order.join(','));

  // sem depoimentos aprovados: nenhum card, só convite discreto
  assert.equal(await page.locator('.testi__card').count(), 0);
  await page.locator('#depoimentos').scrollIntoViewIfNeeded();
  assert.match(await page.locator('#dep-vazio').innerText(), /compartilhe a sua experiência/);
  assert.equal(await page.locator('#dep-destaques').isVisible(), false);
  assert.equal(await page.locator('#dep-titulo').isVisible(), false);
  assert.equal(await page.locator('#dep-vazio a').getAttribute('href'), 'enviar-depoimento/');

  // texto sem afirmações absolutas removidas
  const all = await page.locator('main').innerText();
  assert.doesNotMatch(all, /porque está desregulada|apenas exaustão|validados|raramente é falta de vontade|modo de defesa/i);
  await page.context().close();
});

test('2. Landing (celular Android e iPhone): vídeo logo no início, ordem vertical e sem rolagem lateral', async () => {
  for (const dev of ['Pixel 7', 'iPhone 13']) {
    const page = await newPage(dev);
    await page.goto(origin + '/'); await page.waitForLoadState('networkidle');
    const vh = page.viewportSize().height;
    const h1 = await page.locator('h1').boundingBox(), cta = await page.locator('.hero__cta .btn').boundingBox(), vid = await page.locator('#video-box').boundingBox();
    assert.ok(h1.y < cta.y && cta.y < vid.y, `${dev}: título → botão → vídeo`);
    assert.ok(vid.y < vh * 1.5, `${dev}: vídeo aparece cedo (y=${Math.round(vid.y)}, tela=${vh})`);
    assert.ok(cta.y + cta.height < vh + 40, `${dev}: botão de compra na primeira tela`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${dev}: sem rolagem horizontal`);
    // botão fixo aparece depois de sair da primeira tela, com o mesmo checkout
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)); await page.waitForTimeout(500);
    assert.equal(await page.locator('#sticky a').getAttribute('href'), HOTMART);
    assert.equal(await page.locator('#sticky').evaluate((e) => e.classList.contains('is-on')), true);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300);
    await page.screenshot({ path: SHOTS + `landing-${dev.replace(' ', '')}.png` });
    await page.context().close();
  }
});

test('3. Formulário (celular): campos, contador, validação clara e consentimentos desmarcados', async () => {
  const page = await newPage('iPhone 13');
  await page.goto(origin + '/enviar-depoimento/'); await page.waitForLoadState('networkidle');
  assert.match(await page.locator('.lead-dark').innerText(), /Você participou de algum curso, evento ou formação da Tâmara San’Galo\? Conte como foi sua experiência!/);
  assert.equal(await page.locator('meta[name=robots]').getAttribute('content'), 'noindex, nofollow');
  assert.equal(await page.locator('script[src*="googletagmanager"], script[src*="gtag"]').count(), 0, 'sem rastreadores na página de coleta de dados');

  // nenhum consentimento pré-marcado; nenhuma opção de identificação pré-marcada
  for (const sel of ['#f-consent_own', '#f-consent_publication', '#f-photo_consent']) assert.equal(await page.locator(sel).isChecked(), false);
  assert.equal(await page.locator('input[name=display_choice]:checked').count(), 0);
  assert.equal(await page.locator('input[name=course]:checked').count(), 0, 'nenhum curso pré-selecionado');
  assert.equal(await page.locator('#course-detail-wrap').isVisible(), false);
  // foto: galeria e câmera
  assert.equal(await page.locator('#in-camera').getAttribute('capture'), 'user');
  assert.match(await page.locator('#in-galeria').getAttribute('accept'), /image\/jpeg,image\/png,image\/webp/);
  // consentimento da foto só aparece depois de escolher uma foto
  assert.equal(await page.locator('#photo-consent-wrap').isVisible(), false);
  // campos de 16px (evita zoom do iPhone) e áreas de toque ≥ 44px
  assert.ok(await page.locator('#f-author_name').evaluate((e) => parseFloat(getComputedStyle(e).fontSize) >= 16));
  assert.ok((await page.locator('#btn-enviar').boundingBox()).height >= 44);

  // enviar vazio → erros claros, nada vai para o servidor
  const before = server.log.filter((l) => l.startsWith('POST /functions')).length;
  await page.click('#btn-enviar');
  await page.waitForSelector('#resumo-erros:not([hidden])');
  const summary = await page.locator('#resumo-lista').innerText();
  for (const t of [/Nome: Informe seu nome/, /Identificação pública: Escolha como deseja/, /Depoimento: Escreva pelo menos 30 caracteres/, /Curso ou evento: Selecione o curso ou evento que você realizou/, /Confirmação do relato: Confirme que o depoimento relata uma experiência real que você teve em um curso, evento ou formação/, /autorizar a análise e a possível publicação/]) assert.match(summary, t);
  assert.match(await page.locator('#e-author_name').innerText(), /Informe seu nome/);
  assert.equal(await page.locator('#f-author_name').getAttribute('aria-invalid'), 'true');
  assert.equal(server.log.filter((l) => l.startsWith('POST /functions')).length, before);

  // contador e pré-visualização do nome público
  await page.fill('#f-author_name', 'Maria Souza Lima');
  await page.check('input[value=first_initial]');
  assert.match(await page.locator('#preview-nome').innerText(), /Maria L\./);
  await page.check('input[value=custom]'); await page.fill('#f-custom_name', 'Mãe da Ana');
  assert.match(await page.locator('#preview-nome').innerText(), /Mãe da Ana/);
  await page.fill('#f-body', 'abc'); assert.equal(await page.locator('#contador-n').innerText(), '3');
  await page.fill('#f-body', 'x'.repeat(1200)); assert.equal(await page.locator('#contador-n').innerText(), '1000', 'limite de 1000 caracteres');
  // links no texto são recusados com mensagem clara
  await page.fill('#f-body', 'Ótimo curso, acesse http://spam.com para ganhar dinheiro agora mesmo');
  await page.check('#f-consent_own'); await page.check('#f-consent_publication');
  await page.click('#btn-enviar');
  assert.match(await page.locator('#e-body').innerText(), /não aceitamos links/);
  // contato inválido
  await page.fill('#f-body', GOOD_BODY); await page.fill('#f-contact', 'isso não é contato');
  await page.click('#btn-enviar');
  assert.match(await page.locator('#e-contact').innerText(), /e-mail ou telefone válido/);
  await page.screenshot({ path: SHOTS + 'form-erros-iPhone13.png', fullPage: true });
  await page.context().close();
});

test('4. Formulário: fotos inválidas/perigosas são rejeitadas no navegador; foto válida é reduzida e pré-visualizada', async () => {
  const page = await newPage('Pixel 7');
  await page.goto(origin + '/enviar-depoimento/'); await page.waitForLoadState('networkidle');
  const err = () => page.locator('#e-photo');
  const pick = (name, buffer, mimeType = 'image/jpeg') => page.setInputFiles('#in-galeria', { name, mimeType, buffer });

  await pick('virus.jpg', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(5000)]));                       // executável disfarçado
  await page.waitForFunction(() => !document.getElementById('e-photo').hidden); assert.match(await err().innerText(), /Formato não aceito/);
  await pick('desenho.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>' + ' '.repeat(100)), 'image/svg+xml');
  await page.waitForTimeout(300); assert.match(await err().innerText(), /Formato não aceito/);
  await pick('anim.gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(3000)]), 'image/gif');
  await page.waitForTimeout(300); assert.match(await err().innerText(), /Formato não aceito/);
  await pick('pequena.png', await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).png().toBuffer(), 'image/png');
  await page.waitForTimeout(500); assert.match(await err().innerText(), /muito pequena/);
  const huge = Buffer.concat([await jpeg(300, 300), Buffer.alloc(10.5 * 1024 * 1024)]);
  await pick('enorme.jpg', huge);
  await page.waitForTimeout(500); assert.match(await err().innerText(), /muito grande \(máximo de 10 MB\)/);
  assert.equal(await page.locator('#photo-preview').isVisible(), false, 'nenhuma foto inválida pode ser aceita');
  assert.equal(await page.locator('#photo-consent-wrap').isVisible(), false);

  // foto grande válida (iPhone/Android: 4000×3000): reduzida e com pré-visualização
  const big = await jpeg(4000, 3000, true);
  assert.ok(big.length > 1.5 * 1024 * 1024, 'foto de teste grande: ' + big.length);
  await pick('minha-foto.jpg', big);
  await page.waitForSelector('#photo-preview:not([hidden])');
  assert.equal(await err().isVisible(), false);
  const info = await page.locator('#photo-img').evaluate((i) => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 5) }));
  assert.equal(info.src, 'blob:'); assert.ok(Math.max(info.w, info.h) <= 1024, 'reduzida para ≤1024px: ' + JSON.stringify(info));
  assert.equal(await page.locator('#photo-consent-wrap').isVisible(), true);
  // substituir por outra e remover
  await pick('outra.png', await sharp({ create: { width: 600, height: 600, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 0.5 } } }).png().toBuffer(), 'image/png');
  await page.waitForTimeout(600); assert.equal(await page.locator('#photo-preview').isVisible(), true);
  await page.click('#btn-remover');
  assert.equal(await page.locator('#photo-preview').isVisible(), false); assert.equal(await page.locator('#photo-consent-wrap').isVisible(), false);
  await page.context().close();
});

let firstSubmissionId;
test('5. Envio pelo celular (com foto): confirmação, fica PENDENTE, foto privada, consentimentos registrados', async () => {
  const page = await newPage('Pixel 7');
  await page.goto(origin + '/enviar-depoimento/'); await page.waitForLoadState('networkidle');
  await page.fill('#f-author_name', 'Maria Souza Lima');
  await page.check('input[value=first_initial]');
  await page.fill('#f-profession', 'Psicopedagoga'); await page.fill('#f-cohort', 'Turma de outubro');
  await page.fill('#f-contact', 'maria@exemplo.com');
  await page.check('input[name=course][value=weekend_pass]');
  await page.fill('#f-body', 'Gostei muito da masterclass. As funções do comportamento ficaram claras e já estou usando as ferramentas visuais no consultório.');
  await page.setInputFiles('#in-camera', { name: 'selfie.jpg', mimeType: 'image/jpeg', buffer: await jpeg(1600, 1200, true) });
  await page.waitForSelector('#photo-preview:not([hidden])');

  // foto enviada exige a autorização específica da imagem (separada do texto)
  await page.check('#f-consent_own'); await page.check('#f-consent_publication');
  await page.waitForTimeout(4500); // preenchimento humano (o servidor descarta envios instantâneos de robôs)
  await page.click('#btn-enviar');
  assert.match(await page.locator('#e-photo_consent').innerText(), /autorize o uso público da imagem, ou remova a foto/);
  assert.equal(await rows('select count(*)::int c from testimonials').then((r) => r[0].c), 0, 'nada gravado sem a autorização da foto');

  await page.check('#f-photo_consent');
  await page.screenshot({ path: SHOTS + 'form-preenchido-Pixel7.png', fullPage: true });
  await page.click('#btn-enviar');
  await page.waitForSelector('#sucesso:not([hidden])');
  const ok = await page.locator('#sucesso').innerText();
  assert.match(ok, /Obrigado por compartilhar sua experiência!/);
  assert.match(ok, /Seu depoimento foi recebido e será analisado antes de qualquer publicação\./);
  assert.equal(await page.locator('#form').isVisible(), false);

  const [r] = await rows('select * from testimonials');
  firstSubmissionId = r.id;
  assert.equal(r.status, 'pending'); assert.equal(r.published, false); assert.equal(r.featured_position, null);
  assert.equal(r.display_name, 'Maria L.'); assert.equal(r.author_name, 'Maria Souza Lima'); assert.equal(r.author_contact, 'maria@exemplo.com');
  assert.equal(r.profession, 'Psicopedagoga'); assert.equal(r.cohort, 'Turma de outubro');
  assert.equal(r.consent_own_experience, true); assert.equal(r.consent_publication, true); assert.equal(r.photo_consent, true);
  assert.equal(r.consent_version, 'v2-2026-10'); assert.ok(r.consent_at); assert.ok(r.photo_consent_at);
  assert.deepEqual([r.course_key, r.course_detail, r.course_key_original], ['weekend_pass', null, 'weekend_pass']);
  assert.equal(r.body, r.original_body);
  // foto guardada em bucket privado, com extensão decidida pelo servidor (nunca pelo nome enviado), e comprimida
  assert.match(r.photo_path, new RegExp(`^${r.id}/[0-9a-f-]{36}\\.jpg$`));
  const f = files.get(r.photo_path); assert.ok(f && f.type === 'image/jpeg' && f.bytes.length < 600 * 1024, 'foto reduzida: ' + JSON.stringify({ has: !!f, type: f?.type, len: f?.bytes?.length, keys: [...files.keys()], path: r.photo_path }));
  assert.deepEqual((await rows('select action from testimonial_history where testimonial_id=$1', [r.id])).map((x) => x.action), ['received']);

  // pendente NÃO aparece publicamente (nem texto, nem nome, nem foto)
  const pub = JSON.stringify(await publicList());
  assert.ok(!/Maria|masterclass|selfie|Psicopedagoga/i.test(pub), pub);
  assert.deepEqual(await publicList(), { featured: [], others: [] });
  await page.context().close();
});

test('6. Servidor valida tudo de novo (tentativas de burlar o navegador)', async () => {
  const ip = '198.51.100.50';
  const n0 = (await rows('select count(*)::int c from testimonials'))[0].c;
  const bad = async (over, photo, field, re) => {
    const r = await submitDirect(over, photo, ip + Math.floor(Math.random() * 99));
    assert.equal(r.status, 400, JSON.stringify(r));
    assert.match(r.json.errors[field], re, field);
  };
  await bad({ consent_publication: 'false' }, null, 'consent_publication', /autorizar/);
  await bad({ consent_own: 'false' }, null, 'consent_own', /experiência real/);
  await bad({ consent_version: 'v1-2026-10' }, null, 'consent_version', /desatualizada/);   // texto antigo não é mais aceito em novos envios
  await bad({ course: '' }, null, 'course', /Selecione o curso ou evento/);
  await bad({ course: 'curso_inventado' }, null, 'course', /opções da lista/);
  await bad({ course: 'outro', course_detail: '' }, null, 'course_detail', /nome do curso/);
  await bad({ course: 'varios', course_detail: '  ' }, null, 'course_detail', /Informe quais cursos/);
  await bad({ course: 'outro', course_detail: '<script>alert(1)</script>' }, null, 'course_detail', /não permitidos/);
  await bad({ consent_version: 'v0' }, null, 'consent_version', /desatualizada/);
  await bad({ body: 'curto' }, null, 'body', /pelo menos 30/);
  await bad({ body: 'x'.repeat(1001) }, null, 'body', /no máximo 1000/);
  await bad({ body: 'Texto com <script>alert(1)</script> dentro do depoimento enviado' }, null, 'body', /não permitidos/);
  await bad({ author_name: '<img src=x onerror=alert(1)>' }, null, 'author_name', /não permitidos/);
  await bad({ display_choice: 'admin' }, null, 'display_choice', /Escolha/);
  await bad({ photo_consent: 'false' }, { bytes: await jpeg(500, 500) }, 'photo_consent', /autorize o uso público/);
  // fotos: o servidor confere o conteúdo real, ignorando nome e Content-Type declarados
  const okc = { photo_consent: 'true' };
  await bad(okc, { bytes: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4000)]), name: 'a.jpg', type: 'image/jpeg' }, 'photo', /Formato de imagem não aceito/);
  await bad(okc, { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' + ' '.repeat(100)), name: 'a.png', type: 'image/png' }, 'photo', /Formato de imagem não aceito/);
  await bad(okc, { bytes: Buffer.from('<?php system($_GET[1]); ?>' + ' '.repeat(100)), name: 'a.jpg', type: 'image/jpeg' }, 'photo', /Formato de imagem não aceito/);
  await bad(okc, { bytes: await sharp({ create: { width: 120, height: 120, channels: 3, background: '#fff' } }).png().toBuffer(), name: 'a.png', type: 'image/png' }, 'photo', /muito pequena/);
  await bad(okc, { bytes: Buffer.concat([await jpeg(300, 300), Buffer.alloc(5.5 * 1024 * 1024)]) }, 'photo', /5 MB/);
  assert.equal((await rows('select count(*)::int c from testimonials'))[0].c, n0, 'nenhum envio inválido pode ser gravado');
  assert.equal(files.size, 1, 'nenhum arquivo inválido guardado no bucket');

  // robôs: campo-isca e preenchimento instantâneo respondem "ok" mas NÃO gravam nada
  assert.equal((await submitDirect({ website: 'http://spam' }, null, '198.51.100.51')).status, 201);
  assert.equal((await submitDirect({ elapsed: '200' }, null, '198.51.100.52')).status, 201);
  assert.equal((await rows('select count(*)::int c from testimonials'))[0].c, n0);

  // texto sem foto também é aceito (foto é opcional)
  const ok = await submitDirect({ author_name: 'Carlos Eduardo', display_choice: 'first', body: 'Conteúdo objetivo e muito aplicável ao dia a dia da escola. Recomendo.' }, null, '198.51.100.53');
  assert.equal(ok.status, 201);
  const [c] = await rows("select * from testimonials where author_name='Carlos Eduardo'");
  assert.equal(c.display_name, 'Carlos'); assert.equal(c.photo_path, null); assert.equal(c.photo_consent, false); assert.equal(c.status, 'pending');
});

test('7. Segurança: visitantes e contas comuns não leem nem alteram nada; fotos não são públicas', async () => {
  const [t] = await rows('select id, photo_path from testimonials where photo_path is not null');
  const H = (tok) => ({ apikey: ANON_KEY, ...(tok ? { Authorization: 'Bearer ' + tok } : {}), 'Content-Type': 'application/json', Prefer: 'return=representation' });
  const login = async (u) => (await (await fetch(origin + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password }) })).json()).access_token;
  const outsider = await login(OTHER);

  // visitante anônimo
  let r = await fetch(origin + '/rest/v1/testimonials?select=*', { headers: H() }); assert.equal(r.status, 403);
  r = await fetch(origin + '/rest/v1/testimonials?id=eq.' + t.id, { method: 'PATCH', headers: H(), body: JSON.stringify({ status: 'approved', published: true }) }); assert.equal(r.status, 403);
  r = await fetch(origin + '/rest/v1/testimonials?id=eq.' + t.id, { method: 'DELETE', headers: H() }); assert.equal(r.status, 403);
  r = await fetch(origin + '/rest/v1/testimonials', { method: 'POST', headers: H(), body: JSON.stringify({ author_name: 'x', display_name: 'x', body: 'x'.repeat(40), original_body: 'x', display_choice: 'full', consent_own_experience: true, consent_publication: true, consent_version: 'v1-2026-10' }) }); assert.equal(r.status, 403, 'não se grava direto na tabela (só pela função validada)');
  r = await fetch(origin + '/rest/v1/testimonial_history', { headers: H() }); assert.equal(r.status, 403);
  r = await fetch(origin + '/rest/v1/rpc/set_featured_testimonials', { method: 'POST', headers: H(), body: JSON.stringify({ p_ids: [] }) }); assert.equal(r.status, 403);
  // conta autenticada que NÃO é administradora
  r = await fetch(origin + '/rest/v1/testimonials?select=*', { headers: H(outsider) }); assert.deepEqual(await r.json(), []);
  r = await fetch(origin + '/rest/v1/testimonials?id=eq.' + t.id, { method: 'PATCH', headers: H(outsider), body: JSON.stringify({ status: 'approved', published: true }) }); assert.deepEqual(await r.json(), []);
  r = await fetch(origin + '/rest/v1/testimonials?id=eq.' + t.id, { method: 'DELETE', headers: H(outsider) }); assert.deepEqual(await r.json(), []);
  r = await fetch(origin + '/rest/v1/rpc/is_admin', { method: 'POST', headers: H(outsider), body: '{}' }); assert.equal(await r.json(), false);
  r = await fetch(origin + '/rest/v1/rpc/set_featured_testimonials', { method: 'POST', headers: H(outsider), body: JSON.stringify({ p_ids: [] }) }); assert.equal(r.status, 403);
  assert.deepEqual((await rows('select status, published from testimonials where id=$1', [t.id]))[0], { status: 'pending', published: false });
  // token inventado
  r = await fetch(origin + '/rest/v1/testimonials?select=*', { headers: H('jwt.inventado') }); assert.equal(r.status, 403);

  // fotos: bucket privado
  for (const tok of [null, outsider]) {
    r = await fetch(origin + '/storage/v1/object/sign/testimonial-photos', { method: 'POST', headers: H(tok), body: JSON.stringify({ expiresIn: 60, paths: [t.photo_path] }) }); assert.equal(r.status, 403);
    r = await fetch(origin + '/storage/v1/object/testimonial-photos/hack.jpg', { method: 'POST', headers: { ...H(tok), 'Content-Type': 'image/jpeg' }, body: await jpeg(300, 300) }); assert.equal(r.status, 403);
    r = await fetch(origin + '/storage/v1/object/testimonial-photos', { method: 'DELETE', headers: H(tok), body: JSON.stringify({ prefixes: [t.photo_path] }) }); assert.equal(r.status, 403);
  }
  r = await fetch(origin + '/storage/v1/object/public/testimonial-photos/' + t.photo_path); assert.equal(r.status, 400);
  r = await fetch(origin + '/storage/v1/object/sign/testimonial-photos/' + t.photo_path + '?token=adivinhado'); assert.equal(r.status, 400);
  assert.ok(files.has(t.photo_path));
});

// ---------------------------------------------------------------------
// Painel administrativo
async function adminLogin(page, user = ADMIN) {
  await page.goto(origin + '/admin/depoimentos/'); await page.waitForLoadState('networkidle');
  await page.fill('#l-email', user.email); await page.fill('#l-pass', user.password); await page.click('#l-btn');
}
const itemByName = (page, name) => page.locator('.adm-item', { has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) });
const act = (page, name) => page.getByRole('button', { name, exact: true });
const toastText = (page) => page.locator('#toast');

test('8. Admin: sem login nada aparece; senha errada e conta sem permissão são recusadas; admin entra', async () => {
  const logStart = server.log.length;
  const page = await newPage();
  await page.goto(origin + '/admin/depoimentos/'); await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#login-view').isVisible(), true); assert.equal(await page.locator('#panel-view').isVisible(), false);
  assert.equal(await page.locator('meta[name=robots]').getAttribute('content'), 'noindex, nofollow, noarchive');
  assert.equal(server.log.slice(logStart).filter((l) => /\/rest\/|\/storage\//.test(l)).length, 0, 'sem login, o painel nem consulta os dados');
  assert.equal((await page.locator('body').innerText()).includes('Maria'), false);

  await page.fill('#l-email', ADMIN.email); await page.fill('#l-pass', 'senha-errada'); await page.click('#l-btn');
  await page.waitForSelector('#l-erro:not([hidden])'); assert.match(await page.locator('#l-erro').innerText(), /E-mail ou senha incorretos/);
  assert.equal(await page.locator('#panel-view').isVisible(), false);

  await page.fill('#l-email', OTHER.email); await page.fill('#l-pass', OTHER.password); await page.click('#l-btn');
  await page.waitForFunction(() => /não tem permissão de administrador/.test(document.getElementById('l-erro').textContent));
  assert.equal(await page.locator('#panel-view').isVisible(), false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('mc_admin_session')), null, 'sessão da conta sem permissão é descartada');
  assert.equal(await page.locator('.adm-item').count(), 0);

  // sessão forjada no navegador também não adianta (o banco recusa)
  await page.evaluate(() => sessionStorage.setItem('mc_admin_session', JSON.stringify({ access_token: 'jwt.forjado', refresh_token: 'rt.forjado', expires_at: Date.now() + 3e6, email: 'x@x' })));
  await page.reload(); await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#panel-view').isVisible(), false); assert.equal(await page.locator('#login-view').isVisible(), true);

  await page.fill('#l-email', ADMIN.email); await page.fill('#l-pass', ADMIN.password); await page.click('#l-btn');
  await page.waitForSelector('#panel-view:not([hidden])');
  assert.equal(await page.locator('#user-email').innerText(), ADMIN.email);
  await page.screenshot({ path: SHOTS + 'admin-lista.png' });
  await page.context().close();
});

test('9. Admin: editar, aprovar, publicar, ocultar; histórico; só aprovados+publicados aparecem no site', async () => {
  // massa de teste: mais 6 envios reais (pela função), com identificação personalizada
  for (const [i, n] of ['Aluno A', 'Aluno B', 'Aluno C', 'Aluno D', 'Aluno E', 'Aluno F'].entries()) {
    const r = await submitDirect({ author_name: 'Participante ' + n, display_choice: 'custom', custom_name: n, profession: '', cohort: '',
      body: `Depoimento de teste do ${n}: o conteúdo foi muito útil para a minha prática profissional.` }, null, '198.51.100.' + (100 + i));
    assert.equal(r.status, 201);
  }
  const page = await newPage('Pixel 7');
  await adminLogin(page); await page.waitForSelector('#panel-view:not([hidden])');
  // celular: abre a lista e o item (layout em uma coluna)
  assert.match(await page.locator('.chip[aria-pressed=true]').innerText(), /Pendentes/);
  assert.equal(await page.locator('.adm-item').count(), 8);
  await itemByName(page, 'Maria L.').click();
  assert.equal(await page.locator('#editor h2').innerText(), 'Maria L.');
  const priv = await page.locator('.adm-private').innerText();
  assert.match(priv, /Maria Souza Lima/); assert.match(priv, /maria@exemplo\.com/); assert.match(priv, /autorizado em/);
  assert.match(priv, /Curso ou evento informado pelo participante[\s\S]*Weekend Pass/);
  assert.equal(await page.locator('#ed-course').inputValue(), 'weekend_pass');
  await page.waitForSelector('.adm-photo img'); // foto privada vista pela administração via URL assinada
  assert.equal(await page.locator('.adm-photo img').evaluate((i) => i.naturalWidth > 0), true);
  await page.screenshot({ path: SHOTS + 'admin-editor-Pixel7.png', fullPage: true });

  // Publicar exige aprovação antes
  assert.equal(await act(page, 'Publicar').isDisabled(), true);
  // correção de digitação (não exige confirmação do autor)
  await page.fill('#ed-body', 'Gostei muito da masterclass. As funções do comportamento ficaram claras e já estou usando as ferramentas visuais no meu consultório.');
  await act(page, 'Salvar alterações').click(); await page.waitForFunction(() => /Alterações salvas/.test(document.getElementById('toast').textContent));
  let [r] = await rows('select body, original_body, needs_author_confirmation n from testimonials where id=$1', [firstSubmissionId]);
  assert.ok(r.body.includes('no meu consultório') && r.original_body.includes('no consultório') && !r.n);
  assert.equal(await page.locator('.adm-orig').count(), 1, 'texto original continua visível para conferência');

  await act(page, 'Aprovar').click(); await page.waitForFunction(() => /Aprovado\./.test(document.getElementById('toast').textContent));
  assert.equal((await rows('select status, published from testimonials where id=$1', [firstSubmissionId]))[0].published, false, 'aprovado ≠ publicado');
  assert.deepEqual(await publicList(), { featured: [], others: [] }, 'aprovado mas não publicado: ainda invisível');
  await act(page, 'Publicar').click(); await page.waitForFunction(() => /Publicado\./.test(document.getElementById('toast').textContent));
  let pub = await publicList();
  assert.equal(pub.others.length, 1); assert.equal(pub.others[0].name, 'Maria L.'); assert.match(pub.others[0].text, /no meu consultório/);
  assert.ok(pub.others[0].photo_url.startsWith(origin + '/storage/v1/object/sign/testimonial-photos/'), 'foto só por URL assinada');
  // a API pública só devolve os campos autorizados
  assert.deepEqual(Object.keys(pub.others[0]).sort(), ['cohort', 'course', 'date', 'name', 'photo_url', 'profession', 'text']);
  assert.equal(pub.others[0].course, 'Participante do Weekend Pass');
  assert.ok(!/maria@exemplo|Souza|author|consent|id"/.test(JSON.stringify(pub)), JSON.stringify(pub));
  assert.equal((await fetch(pub.others[0].photo_url)).status, 200);

  // ocultar
  await act(page, 'Ocultar do site').click(); await page.waitForFunction(() => /Ocultado/.test(document.getElementById('toast').textContent));
  assert.deepEqual(await publicList(), { featured: [], others: [] });
  // recusar → fora do site; voltar a pendente
  await act(page, 'Recusar').click(); await page.waitForFunction(() => /Recusado/.test(document.getElementById('toast').textContent));
  assert.equal(await act(page, 'Publicar').isDisabled(), true);
  await act(page, 'Aprovar e publicar').click(); await page.waitForFunction(() => /Aprovado e publicado/.test(document.getElementById('toast').textContent));
  assert.equal((await publicList()).others.length, 1);

  const hist = (await rows('select action from testimonial_history where testimonial_id=$1 order by id', [firstSubmissionId])).map((x) => x.action);
  for (const a of ['received', 'body_edited', 'approved', 'published', 'unpublished', 'rejected']) assert.ok(hist.includes(a), a + ' em ' + hist);
  await page.waitForSelector('.adm-history li');
  assert.match(await page.locator('.adm-history').innerText(), /Publicado/);
  assert.match(await page.locator('.adm-history').innerText(), /admin@teste\.com/);
  await page.context().close();
});

test('10. Admin: escolhe os 5 destaques e a ordem; o site mostra exatamente isso; "Ver todos" lista os demais', async () => {
  // aprova e publica A..F e deixa o "Aluno F" pendente, "Aluno E" aprovado mas oculto
  await server.sql("update testimonials set status='approved' where display_name in ('Aluno A','Aluno B','Aluno C','Aluno D','Aluno E')");
  await server.sql("update testimonials set published=true where display_name in ('Aluno A','Aluno B','Aluno C','Aluno D')");
  const page = await newPage();
  await adminLogin(page); await page.waitForSelector('#panel-view:not([hidden])');
  await page.getByRole('button', { name: /Publicados/ }).click();
  assert.equal(await page.locator('.adm-item').count(), 5, 'Maria + A..D');

  // Destacar na ordem: C, A, D, B (usando botões da interface)
  for (const n of ['Aluno C', 'Aluno A', 'Aluno D', 'Aluno B']) {
    await itemByName(page, n).click(); await act(page, 'Destacar na página').click();
    await page.waitForFunction(() => /Depoimento destacado/.test(document.getElementById('toast').textContent));
    await page.waitForFunction((t) => document.querySelector('.feat-list').textContent.includes(t), n);
  }
  const names = () => page.$$eval('.feat-item__name', (e) => e.map((x) => x.textContent));
  assert.deepEqual(await names(), ['Aluno C', 'Aluno A', 'Aluno D', 'Aluno B']);
  // reordenar: sobe o "Aluno B" duas posições e remove o "Aluno A"
  await page.getByRole('button', { name: 'Subir Aluno B' }).click(); await page.waitForFunction(() => /Ordem atualizada/.test(document.getElementById('toast').textContent));
  await page.getByRole('button', { name: 'Subir Aluno B' }).click(); await page.waitForTimeout(500);
  assert.deepEqual(await names(), ['Aluno C', 'Aluno B', 'Aluno A', 'Aluno D']);
  await page.getByRole('button', { name: 'Remover Aluno A dos destaques' }).click(); await page.waitForTimeout(600);
  assert.deepEqual(await names(), ['Aluno C', 'Aluno B', 'Aluno D']);
  // inclui a Maria como 4º e o limite de 5
  await itemByName(page, 'Maria L.').click(); await act(page, 'Destacar na página').click(); await page.waitForTimeout(600);
  await itemByName(page, 'Aluno A').click(); await act(page, 'Destacar na página').click(); await page.waitForTimeout(600);
  assert.deepEqual(await names(), ['Aluno C', 'Aluno B', 'Aluno D', 'Maria L.', 'Aluno A']);
  assert.deepEqual((await rows('select display_name from testimonials where featured_position is not null order by featured_position')).map((r) => r.display_name), ['Aluno C', 'Aluno B', 'Aluno D', 'Maria L.', 'Aluno A']);
  // publica o E: já existem 5 destaques → não dá para destacar mais um
  await page.getByRole('button', { name: /Aprovados/ }).click(); await itemByName(page, 'Aluno E').click();
  await act(page, 'Publicar').click(); await page.waitForFunction(() => /Publicado\./.test(document.getElementById('toast').textContent));
  assert.equal(await act(page, 'Destacar na página').isDisabled(), true);
  await page.screenshot({ path: SHOTS + 'admin-destaques.png' });

  // === site público ===
  const pub = await publicList();
  assert.deepEqual(pub.featured.map((x) => x.name), ['Aluno C', 'Aluno B', 'Aluno D', 'Maria L.', 'Aluno A'], 'destaques = escolha da administração, na ordem');
  assert.deepEqual(pub.others.map((x) => x.name), ['Aluno E']);
  const text = JSON.stringify(pub);
  assert.ok(!text.includes('Aluno F'), 'pendente não vaza'); assert.ok(!/Carlos/.test(text));

  const site = await newPage();
  await site.goto(origin + '/'); await site.locator('#depoimentos').scrollIntoViewIfNeeded();
  await site.waitForSelector('#dep-destaques:not([hidden])');
  assert.deepEqual(await site.$$eval('#dep-destaques .testi__name', (e) => e.map((x) => x.textContent)), ['Aluno C', 'Aluno B', 'Aluno D', 'Maria L.', 'Aluno A']);
  assert.equal(await site.locator('#dep-titulo').isVisible(), true);
  assert.match(await site.locator('#dep-titulo').innerText(), /Quem já participou conta como foi a experiência/);
  assert.equal(await site.locator('#dep-vazio').isVisible(), false);
  const maria = site.locator('#dep-destaques .testi__card', { hasText: 'Maria L.' });
  assert.match(await maria.innerText(), /Psicopedagoga · Turma de outubro/);
  assert.equal(await maria.locator('.testi__course').innerText(), 'Participante do Weekend Pass');
  assert.equal(await site.locator('#dep-destaques .testi__course', { hasText: 'Participante da Masterclass — Do Comportamento à Aprendizagem' }).count(), 4, 'os demais declararam a Masterclass');
  assert.equal(await maria.locator('img').getAttribute('alt'), 'Foto de Maria L.');
  await site.waitForFunction(() => document.querySelector('#dep-destaques img')?.complete);
  assert.equal(await maria.locator('img').evaluate((i) => i.naturalWidth > 0), true, 'foto autorizada aparece');
  assert.equal(await site.locator('#dep-destaques .testi__card:not(:has(img)) .testi__avatar--initial').count(), 4, 'sem foto: inicial do nome');
  // "Ver todos os depoimentos": só os aprovados+publicados que não são destaque
  assert.equal(await site.locator('#dep-todos').isVisible(), false);
  await site.getByRole('button', { name: 'Ver todos os depoimentos' }).click();
  assert.deepEqual(await site.$$eval('#dep-todos .testi__name', (e) => e.map((x) => x.textContent)), ['Aluno E']);
  assert.equal(await site.locator('#dep-mais').getAttribute('aria-expanded'), 'true');
  const html = await site.content(); assert.ok(!html.includes('Aluno F'));
  await site.screenshot({ path: SHOTS + 'landing-depoimentos-desktop.png', clip: await site.locator('#depoimentos').boundingBox() });
  await site.context().close();

  // celular: cards legíveis, deslizáveis (sem avanço automático)
  const m = await newPage('iPhone 13');
  await m.goto(origin + '/'); await m.locator('#depoimentos').scrollIntoViewIfNeeded(); await m.waitForSelector('#dep-destaques:not([hidden])');
  const box = await m.locator('#dep-destaques').boundingBox(), card = await m.locator('#dep-destaques .testi__card').first().boundingBox();
  assert.ok(card.width > box.width * 0.8 && card.width <= box.width, 'um card por vez, legível');
  assert.equal(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const x0 = await m.locator('#dep-destaques').evaluate((e) => e.scrollLeft); await m.waitForTimeout(3500);
  assert.equal(await m.locator('#dep-destaques').evaluate((e) => e.scrollLeft), x0, 'sem rotação automática');
  await m.screenshot({ path: SHOTS + 'landing-depoimentos-iPhone13.png', clip: await m.locator('#depoimentos').boundingBox() });
  await m.context().close();
  await page.context().close();
});

test('11. Admin: edição que muda o sentido exige confirmação do autor; só então pode publicar', async () => {
  const page = await newPage();
  await adminLogin(page); await page.waitForSelector('#panel-view:not([hidden])');
  await page.getByRole('button', { name: /Publicados/ }).click();
  await itemByName(page, 'Aluno D').click();
  assert.equal((await rows("select featured_position p from testimonials where display_name='Aluno D'"))[0].p, 3);
  await page.fill('#ed-body', 'Esta foi a melhor formação da minha vida inteira, mudou completamente a minha carreira e a de todos os meus colegas de trabalho.');
  await act(page, 'Salvar alterações').click();
  await page.waitForSelector('.adm-msg.notice--warn:not([hidden])');
  assert.match(await page.locator('.adm-msg').innerText(), /saiu da exibição pública até o autor confirmar/);
  const [d] = await rows("select published, featured_position p, needs_author_confirmation n, status from testimonials where display_name='Aluno D'");
  assert.deepEqual(d, { published: false, p: null, n: true, status: 'approved' });
  const pub = await publicList(); assert.ok(!JSON.stringify(pub).includes('Aluno D'), 'sai do site imediatamente');
  assert.equal(await act(page, 'Publicar').isDisabled(), true);
  // exige descrever como o autor confirmou
  await act(page, 'Registrar confirmação do autor').click();
  assert.match(await page.locator('.adm-msg').innerText(), /Descreva como o autor confirmou/);
  await page.fill('#ed-how', 'Autor confirmou por WhatsApp em 29/10');
  await act(page, 'Registrar confirmação do autor').click(); await page.waitForFunction(() => /Confirmação registrada/.test(document.getElementById('toast').textContent));
  await act(page, 'Publicar').click(); await page.waitForFunction(() => /Publicado\./.test(document.getElementById('toast').textContent));
  assert.ok(JSON.stringify(await publicList()).includes('Aluno D'));
  const hist = (await rows("select action from testimonial_history where testimonial_id=(select id from testimonials where display_name='Aluno D') order by id")).map((r) => r.action);
  for (const a of ['author_confirmation_required', 'author_confirmed']) assert.ok(hist.includes(a), a);
  await page.context().close();
});

test('12. Conteúdo malicioso nunca executa (XSS) — nem na landing, nem no painel', async () => {
  const evil = '<img src=x onerror="window.__xss=1"> e <script>window.__xss=2</script> texto perigoso mas apenas texto';
  // entra por fora das validações (SQL direto) para provar que a exibição também escapa
  await server.sql(`insert into testimonials (author_name, display_choice, display_name, body, original_body, consent_own_experience, consent_publication, consent_version, status, published, profession)
    values ('Hacker', 'custom', $1, $2, $2, true, true, 'v1-2026-10', 'approved', true, $3)`, ['<b onmouseover=alert(1)>Mal</b>', evil, '<i>área</i>']);
  const site = await newPage(null, { allowErrors: true });
  await site.goto(origin + '/'); await site.locator('#depoimentos').scrollIntoViewIfNeeded(); await site.waitForSelector('#dep-destaques:not([hidden])');
  await site.getByRole('button', { name: 'Ver todos os depoimentos' }).click();
  const card = site.locator('#dep-todos .testi__card', { hasText: 'texto perigoso' });
  assert.match(await card.innerText(), /<img src=x onerror="window\.__xss=1">/, 'aparece como texto literal');
  assert.equal(await card.locator('img, script, b, i').count(), 0);
  assert.equal(await card.locator('.testi__course').count(), 0, 'depoimento antigo (sem curso): nada é inventado');
  assert.equal(await site.evaluate(() => window.__xss), undefined);
  await site.context().close();
  const page = await newPage(null, { allowErrors: true });
  await adminLogin(page); await page.waitForSelector('#panel-view:not([hidden])');
  await page.getByRole('button', { name: /Todos/ }).click();
  const legacyItem = page.locator('.adm-item', { hasText: 'texto perigoso' });
  assert.match(await legacyItem.innerText(), /Curso ou evento não informado/);
  await legacyItem.click();
  assert.equal(await page.locator('#ed-course').inputValue(), '', 'registro antigo: sem curso confirmado');
  assert.match(await page.locator('.adm-private').innerText(), /Curso ou evento informado pelo participante[\s\S]*Curso ou evento não informado/);
  assert.equal(await page.locator('#ed-course-detail').isVisible(), false);
  assert.equal(await page.locator('#editor-corpo img, #editor-corpo script, #editor-corpo b').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  // limpa: exclui pelo painel (com confirmação em 2 etapas)
  await act(page, 'Excluir depoimento…').click();
  assert.equal((await rows("select count(*)::int c from testimonials where author_name='Hacker'"))[0].c, 1, 'ainda não excluiu sem confirmar');
  await act(page, 'Cancelar').click();
  assert.equal((await rows("select count(*)::int c from testimonials where author_name='Hacker'"))[0].c, 1);
  await page.context().close();
});

test('13. Admin: substituir/remover foto, revogar uso de imagem e excluir (com confirmação)', async () => {
  const page = await newPage();
  await adminLogin(page); await page.waitForSelector('#panel-view:not([hidden])');
  await page.getByRole('button', { name: /Todos/ }).click(); await itemByName(page, 'Maria L.').click();
  const [before] = await rows('select photo_path from testimonials where id=$1', [firstSubmissionId]);
  const nFiles = files.size;
  await page.setInputFiles('.adm-photo input[type=file]', { name: 'nova.png', mimeType: 'image/png', buffer: await sharp({ create: { width: 700, height: 700, channels: 3, background: '#2a9d8f' } }).png().toBuffer() });
  await page.waitForFunction(() => /Foto substituída/.test(document.getElementById('toast').textContent));
  const [after] = await rows('select photo_path from testimonials where id=$1', [firstSubmissionId]);
  assert.notEqual(after.photo_path, before.photo_path); assert.equal(files.has(before.photo_path), false, 'foto antiga removida'); assert.equal(files.get(after.photo_path).type, 'image/jpeg'); assert.equal(files.size, nFiles);
  // foto inválida no painel também é barrada
  await page.setInputFiles('.adm-photo input[type=file]', { name: 'x.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('MZ' + 'x'.repeat(3000)) });
  await page.waitForFunction(() => /Formato não aceito/.test(document.querySelector('.adm-msg').textContent));
  assert.equal((await rows('select photo_path from testimonials where id=$1', [firstSubmissionId]))[0].photo_path, after.photo_path);

  await act(page, 'Remover foto e registrar revogação do uso de imagem').click(); await page.waitForFunction(() => /Foto removida/.test(document.getElementById('toast').textContent));
  const [m] = await rows('select photo_path, photo_consent from testimonials where id=$1', [firstSubmissionId]);
  assert.deepEqual(m, { photo_path: null, photo_consent: false }); assert.equal(files.has(after.photo_path), false);
  assert.equal((await publicList()).featured.find((x) => x.name === 'Maria L.').photo_url, null, 'sem foto no site');
  assert.ok((await rows('select action from testimonial_history where testimonial_id=$1', [firstSubmissionId])).some((x) => x.action === 'photo_consent_revoked'));

  // exclusão definitiva (com confirmação)
  await act(page, 'Excluir depoimento…').click(); await act(page, 'Sim, excluir definitivamente').click();
  await page.waitForFunction(() => /Depoimento excluído/.test(document.getElementById('toast').textContent));
  assert.equal((await rows('select count(*)::int c from testimonials where id=$1', [firstSubmissionId]))[0].c, 0);
  assert.ok(!(await publicList()).featured.some((x) => x.name === 'Maria L.'));
  assert.ok((await rows('select action from testimonial_history where testimonial_id=$1', [firstSubmissionId])).some((x) => x.action === 'deleted'));
  await page.context().close();
});

test('14. Limite de envios por IP (antiabuso): 5º envio em sequência é barrado (429)', async () => {
  const ip = '192.0.2.77';
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await submitDirect({ author_name: 'Spam ' + i, body: GOOD_BODY + ' ' + i }, null, ip)).status);
  assert.deepEqual(codes, [201, 201, 201, 201, 429]);
  assert.equal((await rows("select count(*)::int c from testimonials where author_name like 'Spam%'"))[0].c, 4);
  // sem IP em comum, outro visitante continua podendo enviar
  assert.equal((await submitDirect({ author_name: 'Visitante Legítimo' }, null, '192.0.2.78')).status, 201);
});

test('15. Persistência: depoimentos, fotos e destaques sobrevivem a recarregar e a reiniciar o servidor', async () => {
  const before = await publicList();
  assert.ok(before.featured.length >= 3 && before.others.length >= 1, JSON.stringify(strip0(before)));
  const pageBefore = await newPage();
  await adminLogin(pageBefore); await pageBefore.waitForSelector('#panel-view:not([hidden])');
  await pageBefore.reload(); await pageBefore.waitForSelector('#panel-view:not([hidden])'); // sessão sobrevive ao recarregar
  assert.ok(await pageBefore.locator('.chip').count() >= 6);
  await pageBefore.context().close();

  await server.close();                                   // "reinicia" o servidor: novo processo de banco sobre o mesmo disco
  server = await startServer({ dataDir: TMP + 'pgdata', files });
  origin = server.origin;
  const after = await publicList();
  const strip = (l) => ({ f: l.featured.map((x) => x.name), o: l.others.map((x) => x.name) });
  assert.deepEqual(strip(after), strip(before));
  const site = await newPage();
  await site.goto(origin + '/'); await site.locator('#depoimentos').scrollIntoViewIfNeeded(); await site.waitForSelector('#dep-destaques:not([hidden])');
  assert.deepEqual(await site.$$eval('#dep-destaques .testi__name', (e) => e.map((x) => x.textContent)), before.featured.map((x) => x.name));
  await site.context().close();
  const page = await newPage();
  await adminLogin(page); await page.waitForSelector('#panel-view:not([hidden])');
  assert.deepEqual(await page.$$eval('.feat-item__name', (e) => e.map((x) => x.textContent)), before.featured.map((x) => x.name));
  await page.context().close();
});

test('16. Sessão do painel renova sozinha e encerra ao sair', async () => {
  server.setShortTokens(true);              // token de 2 s para forçar a renovação
  const page = await newPage();
  await adminLogin(page); await page.waitForSelector('#panel-view:not([hidden])');
  await page.waitForTimeout(2500);          // o token expirou
  await page.getByRole('button', { name: /Pendentes/ }).click();
  await page.locator('.adm-item').first().click();   // exige chamadas autenticadas (histórico) → renova via refresh_token
  await page.waitForSelector('.adm-history li');
  assert.ok(server.log.some((l) => l === 'POST /auth/v1/token'), 'renovou o token');
  server.setShortTokens(false);
  await page.getByRole('button', { name: 'Sair' }).click();
  assert.equal(await page.locator('#login-view').isVisible(), true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('mc_admin_session')), null);
  assert.equal(await page.locator('.adm-item').count(), 0);
  await page.context().close();
});

test('17. Sem configuração do Supabase: site continua normal e o formulário avisa (sem fingir sucesso)', async () => {
  server.setConfigured(false);
  const page = await newPage();
  await page.goto(origin + '/'); await page.waitForLoadState('networkidle'); await page.locator('#depoimentos').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.testi__card').count(), 0); assert.equal(await page.locator('#dep-vazio').isVisible(), true);
  assert.equal(await page.locator('a[href*="hotmart"]').count() >= 6, true);
  await page.goto(origin + '/enviar-depoimento/'); await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#aviso-config').isVisible(), true); assert.equal(await page.locator('#btn-enviar').isDisabled(), true);
  await page.goto(origin + '/admin/depoimentos/'); await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#cfg-aviso').isVisible(), true);
  server.setConfigured(true);
  await page.context().close();
});

// ---------------------------------------------------------------------
// Curso ou evento
const COURSE_CASES = [
  { key: 'masterclass', label: 'Masterclass — Do Comportamento à Aprendizagem', pub: 'Participante da Masterclass — Do Comportamento à Aprendizagem' },
  { key: 'at_pratica', label: 'A.T. na Prática', pub: 'Participante do A.T. na Prática' },
  { key: 'weekend_pass', label: 'Weekend Pass', pub: 'Participante do Weekend Pass' },
  { key: 'imersao_crise', label: 'Imersão em Gerenciamento de Crise', pub: 'Participante da Imersão em Gerenciamento de Crise' },
  { key: 'outro', label: 'Outro curso ou evento', detail: 'Formação em Análise do Comportamento Aplicada', pub: 'Participante de: Formação em Análise do Comportamento Aplicada' },
  { key: 'varios', label: 'Mais de um curso ou evento', detail: 'Weekend Pass e Imersão em Gerenciamento de Crise', pub: 'Participante de múltiplas formações', pubList: 'Participante de: Weekend Pass e Imersão em Gerenciamento de Crise' },
];
const courseName = (c) => `Curso ${c.key}`;
const courseCase = (key) => COURSE_CASES.find((c) => c.key === key);

test('18. Formulário (celular): envio de depoimento para CADA curso ou evento, com o complemento quando necessário', async () => {
  const n0 = (await rows('select count(*)::int c from testimonials'))[0].c;
  for (const [i, c] of COURSE_CASES.entries()) {
    const page = await newPage('Pixel 7');
    await page.context().setExtraHTTPHeaders({ 'x-test-ip': `192.0.2.${150 + i}` });   // IP diferente por envio (o limite de envios é por IP)
    await page.goto(origin + '/enviar-depoimento/'); await page.waitForLoadState('networkidle');
    await page.fill('#f-author_name', `Participante ${c.key}`);
    await page.check('input[value=custom]'); await page.fill('#f-custom_name', courseName(c));
    await page.check(`input[name=course][value=${c.key}]`);
    assert.equal(await page.locator('#course-detail-wrap').isVisible(), !!c.detail, `${c.key}: complemento visível só em "outro" e "varios"`);
    if (c.detail) {
      assert.match(await page.locator('#course-detail-label').innerText(), c.key === 'outro' ? /Qual curso ou evento\?/ : /Quais cursos ou eventos você deseja mencionar\?/);
      await page.fill('#f-course_detail', c.detail);
    }
    await page.fill('#f-body', `Depoimento sobre ${c.label}: o conteúdo foi muito útil para a minha prática profissional.`);
    await page.check('#f-consent_own'); await page.check('#f-consent_publication');
    if (c.key === 'varios') await page.screenshot({ path: SHOTS + 'form-curso-varios-Pixel7.png', fullPage: true });
    await page.waitForTimeout(4300);   // preenchimento humano
    await page.click('#btn-enviar');
    await page.waitForSelector('#sucesso:not([hidden])');
    assert.match(await page.locator('#sucesso').innerText(), /Seu depoimento foi recebido e será analisado antes de qualquer publicação\./);
    const [r] = await rows('select * from testimonials where author_name=$1', [`Participante ${c.key}`]);
    assert.ok(r, c.key + ' gravado');
    assert.deepEqual([r.course_key, r.course_detail, r.course_key_original, r.course_detail_original], [c.key, c.detail ?? null, c.key, c.detail ?? null], c.key);
    assert.equal(r.consent_version, 'v2-2026-10'); assert.equal(r.status, 'pending'); assert.equal(r.published, false); assert.equal(r.consent_own_experience, true);
    await page.context().close();
  }
  assert.equal((await rows('select count(*)::int c from testimonials'))[0].c, n0 + 6);
  // pendentes não aparecem no site (nem nome, nem texto, nem curso)
  const pub = JSON.stringify(await publicList());
  assert.ok(!/Curso (masterclass|at_pratica|weekend_pass|imersao_crise|outro|varios)|Formação em Análise|múltiplas formações|Imersão/.test(pub), pub);
});

test('19. Formulário: opções, campos complementares e bloqueio do envio sem os itens obrigatórios', async () => {
  const page = await newPage('iPhone 13');
  await page.context().setExtraHTTPHeaders({ 'x-test-ip': '192.0.2.200' });
  await page.goto(origin + '/enviar-depoimento/'); await page.waitForLoadState('networkidle');
  const posts = () => server.log.filter((l) => l.startsWith('POST /functions')).length;
  const p0 = posts();

  // seis opções exatamente como pedido, nenhuma marcada, antes das confirmações
  assert.deepEqual(await page.$$eval('#course-group > .choice span', (e) => e.map((x) => x.textContent)), COURSE_CASES.map((c) => c.label));
  assert.deepEqual(await page.$$eval('input[name=course]', (e) => e.map((x) => x.value)), COURSE_CASES.map((c) => c.key));
  assert.equal(await page.locator('input[name=course]:checked').count(), 0);
  assert.match(await page.locator('#course-group legend').first().innerText(), /Qual curso ou evento você realizou\?/);
  const yCourse = (await page.locator('#course-group').boundingBox()).y, yConsent = (await page.locator('#f-consent_own').boundingBox()).y;
  assert.ok(yCourse < yConsent, 'campo do curso vem antes das confirmações');

  // preenche tudo, menos curso e confirmações
  await page.fill('#f-author_name', 'Teste Bloqueio'); await page.check('input[value=first]');
  await page.fill('#f-body', 'Texto de teste suficientemente longo para passar da validação mínima de caracteres.');
  await page.click('#btn-enviar');
  await page.waitForSelector('#resumo-erros:not([hidden])');
  const s1 = await page.locator('#resumo-lista').innerText();
  assert.match(s1, /Curso ou evento: Selecione o curso ou evento que você realizou/);
  assert.match(await page.locator('#e-course').innerText(), /Selecione o curso ou evento/);
  assert.match(s1, /Confirmação do relato/); assert.match(s1, /Autorização de publicação/);
  assert.equal(posts(), p0, 'nada é enviado ao servidor');

  // com curso escolhido, mas as confirmações continuam desmarcadas → continua bloqueado (cada uma obrigatória)
  await page.check('input[name=course][value=weekend_pass]');
  assert.equal(await page.locator('#e-course').isVisible(), false, 'erro some ao escolher');
  await page.click('#btn-enviar');
  const s2 = await page.locator('#resumo-lista').innerText();
  assert.doesNotMatch(s2, /Curso ou evento/); assert.match(s2, /Confirmação do relato/); assert.match(s2, /Autorização de publicação/);
  await page.check('#f-consent_own');
  await page.click('#btn-enviar');
  const s3 = await page.locator('#resumo-lista').innerText();
  assert.doesNotMatch(s3, /Confirmação do relato/); assert.match(s3, /Autorização de publicação/);
  assert.equal(posts(), p0);

  // "Outro curso ou evento": aparece o complemento obrigatório
  await page.check('input[name=course][value=outro]');
  assert.equal(await page.locator('#f-course_detail').isVisible(), true);
  await page.check('#f-consent_publication');
  await page.click('#btn-enviar');
  assert.match(await page.locator('#e-course_detail').innerText(), /Informe o nome do curso ou evento/);
  assert.equal(await page.locator('#f-course_detail').getAttribute('aria-invalid'), 'true');
  assert.equal(posts(), p0);
  await page.fill('#f-course_detail', 'confira www.spam.com');
  await page.click('#btn-enviar');
  assert.match(await page.locator('#e-course_detail').innerText(), /não aceita links/);

  // "Mais de um": complemento diferente, também obrigatório
  await page.check('input[name=course][value=varios]');
  assert.match(await page.locator('#course-detail-label').innerText(), /Quais cursos ou eventos você deseja mencionar\?/);
  assert.match(await page.locator('#h-course_detail').innerText(), /Participante de múltiplas formações/);
  assert.equal(await page.locator('#f-course_detail').inputValue(), 'confira www.spam.com', 'texto digitado é mantido ao trocar entre as duas opções com complemento');
  await page.fill('#f-course_detail', '');
  await page.click('#btn-enviar');
  assert.match(await page.locator('#e-course_detail').innerText(), /Informe quais cursos ou eventos/);
  assert.equal(posts(), p0);

  // voltar a uma opção padrão: complemento some e é descartado
  await page.fill('#f-course_detail', 'texto que não deve ser enviado');
  await page.check('input[name=course][value=at_pratica]');
  assert.equal(await page.locator('#course-detail-wrap').isVisible(), false);
  await page.check('input[name=course][value=outro]');
  assert.equal(await page.locator('#f-course_detail').inputValue(), '', 'campo é limpo ao esconder');
  await page.screenshot({ path: SHOTS + 'form-curso-outro-iPhone13.png', fullPage: true });
  await page.context().close();
  assert.equal((await rows("select count(*)::int c from testimonials where author_name='Teste Bloqueio'"))[0].c, 0);
});

test('20. Painel: mostra o curso informado, permite conferir/corrigir antes de publicar e o site exibe a identificação correta', async () => {
  const feat0 = (await publicList()).featured.map((x) => x.name);
  assert.ok(feat0.length >= 3, 'há destaques a preservar: ' + feat0);
  const page = await newPage('Pixel 7');
  await adminLogin(page); await page.waitForSelector('#panel-view:not([hidden])');
  await page.getByRole('button', { name: /Todos/ }).click();
  const item = (key) => itemByName(page, courseName(courseCase(key)));
  // no celular a lista some enquanto um depoimento está aberto: volta à lista antes de abrir outro
  const open = async (key) => { if (!(await item(key).isVisible())) await page.click('#btn-voltar'); await item(key).click(); };
  // limpa o aviso anterior antes de agir (o texto do aviso antigo ficaria na tela e confundiria a espera)
  const press = async (name, re) => {
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await act(page, name).click();
    await page.waitForFunction((s) => new RegExp(s).test(document.getElementById('toast').textContent), re);
  };
  const pubFind = async (key) => (await publicList()).others.concat((await publicList()).featured).find((x) => x.name === courseName(courseCase(key)));

  // a lista mostra o curso/evento de cada envio
  for (const c of COURSE_CASES) {
    assert.equal(await item(c.key).locator('.adm-item__course').innerText(), c.detail ? `${c.label}: ${c.detail}` : c.label, c.key);
  }
  await page.screenshot({ path: SHOTS + 'admin-lista-curso-Pixel7.png', fullPage: true });

  // ---- "Mais de um": a lista só é pública se a administração autorizar ----
  await open('varios');
  assert.equal(await page.locator('#ed-course').inputValue(), 'varios');
  assert.equal(await page.locator('#ed-course-detail').inputValue(), courseCase('varios').detail);
  assert.equal(await page.locator('#ed-course-pub').isChecked(), false);
  assert.match(await page.locator('.adm-course-preview').innerText(), /Aparecerá no site como: Participante de múltiplas formações/);
  assert.match(await page.locator('.adm-private').innerText(), /Curso ou evento informado pelo participante[\s\S]*Mais de um curso ou evento: Weekend Pass e Imersão/);
  for (const dd of await page.locator('.adm-private dd').all()) assert.ok((await dd.evaluate((e) => e.getBoundingClientRect().width)) > 150, 'valores dos dados privados legíveis no celular');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'painel sem rolagem horizontal no celular');
  await page.screenshot({ path: SHOTS + 'admin-editor-curso-varios-Pixel7.png', fullPage: true });
  assert.equal(await pubFind('varios'), undefined, 'pendente: invisível');
  await press('Aprovar e publicar', 'Aprovado e publicado');
  let pv = await pubFind('varios');
  assert.equal(pv.course, 'Participante de múltiplas formações');
  assert.ok(!JSON.stringify(await publicList()).includes('Weekend Pass e Imersão'), 'lista de cursos não vaza sem autorização');
  await page.check('#ed-course-pub');
  assert.match(await page.locator('.adm-course-preview').innerText(), /Participante de: Weekend Pass e Imersão em Gerenciamento de Crise/);
  await press('Salvar alterações', 'Alterações salvas');
  assert.equal((await pubFind('varios')).course, courseCase('varios').pubList);
  assert.equal((await rows("select course_detail_public p from testimonials where author_name='Participante varios'"))[0].p, true);

  // ---- "Outro": nome informado é exibido após aprovação; administração pode corrigir a grafia ----
  await open('outro');
  assert.equal(await page.locator('#ed-course-pub').isVisible(), false, 'autorização de lista só existe em "varios"');
  await page.fill('#ed-course-detail', '');
  await act(page, 'Salvar alterações').click();
  assert.match(await page.locator('.adm-msg').innerText(), /Informe o nome do curso ou evento/);
  assert.equal((await rows("select course_detail d from testimonials where author_name='Participante outro'"))[0].d, courseCase('outro').detail, 'nada foi salvo');
  await page.fill('#ed-course-detail', 'Formação em ABA');
  await press('Aprovar e publicar', 'Aprovado e publicado');   // corrige e publica numa só ação
  assert.equal((await pubFind('outro')).course, 'Participante de: Formação em ABA');
  const [o] = await rows("select course_detail, course_detail_original, body, original_body from testimonials where author_name='Participante outro'");
  assert.deepEqual([o.course_detail, o.course_detail_original], ['Formação em ABA', courseCase('outro').detail], 'o informado originalmente é preservado');
  assert.equal(o.body, o.original_body, 'relato não foi alterado');
  assert.match(await page.locator('.adm-private').innerText(), /Curso ou evento informado pelo participante[\s\S]*Formação em Análise do Comportamento Aplicada/);

  // ---- corrige a opção antes de publicar (A.T. na Prática → Imersão), sem mexer no relato ----
  await open('at_pratica');
  await page.selectOption('#ed-course', 'imersao_crise');
  assert.match(await page.locator('.adm-course-preview').innerText(), /Participante da Imersão em Gerenciamento de Crise/);
  await press('Aprovar e publicar', 'Aprovado e publicado');
  assert.equal((await pubFind('at_pratica')).course, 'Participante da Imersão em Gerenciamento de Crise');
  const [a] = await rows("select course_key, course_key_original, body, original_body from testimonials where author_name='Participante at_pratica'");
  assert.deepEqual([a.course_key, a.course_key_original], ['imersao_crise', 'at_pratica']); assert.equal(a.body, a.original_body);
  await page.waitForSelector('.adm-history li');
  assert.match(await page.locator('.adm-history').innerText(), /Curso ou evento editado/);
  assert.match(await page.locator('.adm-private').innerText(), /Curso ou evento informado pelo participante[\s\S]*A\.T\. na Prática/);

  // ---- "Mais de um" → opção padrão: o complemento e a autorização da lista são descartados ----
  await open('varios');
  await page.selectOption('#ed-course', 'masterclass');
  assert.equal(await page.locator('#ed-course-detail').isVisible(), false);
  await press('Salvar alterações', 'Alterações salvas');
  assert.equal((await pubFind('varios')).course, 'Participante da Masterclass — Do Comportamento à Aprendizagem');
  assert.deepEqual((await rows("select course_detail, course_detail_public p, course_detail_original from testimonials where author_name='Participante varios'"))[0], { course_detail: null, p: false, course_detail_original: courseCase('varios').detail });
  await open('varios');
  await page.selectOption('#ed-course', 'varios');           // volta; o complemento precisa ser informado de novo
  await page.fill('#ed-course-detail', 'Weekend Pass e Imersão em Gerenciamento de Crise');
  await press('Salvar alterações', 'Alterações salvas');
  assert.equal((await pubFind('varios')).course, 'Participante de múltiplas formações', 'autorização de lista não é reaproveitada');

  // ---- persistência: recarrega o painel ----
  await page.reload(); await page.waitForSelector('#panel-view:not([hidden])');
  await page.getByRole('button', { name: /Todos/ }).click();
  await open('outro');
  assert.equal(await page.locator('#ed-course').inputValue(), 'outro'); assert.equal(await page.locator('#ed-course-detail').inputValue(), 'Formação em ABA');
  await open('at_pratica'); assert.equal(await page.locator('#ed-course').inputValue(), 'imersao_crise');
  assert.equal(await item('at_pratica').locator('.adm-item__course').innerText(), 'Imersão em Gerenciamento de Crise');
  await page.screenshot({ path: SHOTS + 'admin-editor-curso-corrigido-Pixel7.png', fullPage: true });

  // ---- permanecem pendentes (e invisíveis): masterclass, weekend_pass, imersao_crise ----
  const pubAll = JSON.stringify(await publicList());
  for (const k of ['masterclass', 'weekend_pass', 'imersao_crise']) assert.ok(!pubAll.includes(courseName(courseCase(k))), k + ' pendente não aparece');
  // destaques preservados
  assert.deepEqual((await publicList()).featured.map((x) => x.name), feat0, 'os 5 destaques continuam iguais');
  assert.deepEqual(await page.$$eval('.feat-item__name', (e) => e.map((x) => x.textContent)), feat0);
  await page.context().close();
});

test('21. Site público: curso/evento aparece junto ao depoimento; antigos não ganham curso; tudo persiste após reiniciar o servidor', async () => {
  const feat0 = (await publicList()).featured.map((x) => x.name);
  const expected = {
    'Curso outro': 'Participante de: Formação em ABA',
    'Curso at_pratica': 'Participante da Imersão em Gerenciamento de Crise',
    'Curso varios': 'Participante de múltiplas formações',
  };
  const check = async (label) => {
    const site = await newPage();
    await site.goto(origin + '/'); await site.locator('#depoimentos').scrollIntoViewIfNeeded(); await site.waitForSelector('#dep-destaques:not([hidden])');
    assert.deepEqual(await site.$$eval('#dep-destaques .testi__name', (e) => e.map((x) => x.textContent)), feat0, label + ': destaques');
    await site.getByRole('button', { name: /Ver todos os depoimentos|Mostrar menos/ }).click();
    for (const [name, text] of Object.entries(expected)) {
      const card = site.locator('#dep-todos .testi__card', { has: site.locator('.testi__name', { hasText: new RegExp('^' + name + '$') }) });
      assert.equal(await card.locator('.testi__course').innerText(), text, `${label}: ${name}`);
    }
    // depoimento antigo (sem curso confirmado): nenhuma identificação de curso foi inventada
    const legacy = site.locator('#dep-todos .testi__card', { hasText: 'texto perigoso' });
    assert.equal(await legacy.count(), 1); assert.equal(await legacy.locator('.testi__course').count(), 0);
    // pendentes não aparecem
    const html = await site.content();
    for (const k of ['Curso masterclass', 'Curso weekend_pass', 'Curso imersao_crise']) assert.ok(!html.includes(k), `${label}: ${k}`);
    await site.screenshot({ path: SHOTS + `landing-cursos-${label}.png`, clip: await site.locator('#depoimentos').boundingBox() });
    await site.context().close();
  };
  await check('antes');

  await server.close();                                   // "reinicia": novo processo de banco sobre o mesmo disco
  server = await startServer({ dataDir: TMP + 'pgdata', files });
  origin = server.origin;
  await check('depois');
  const [r] = await rows("select course_key, course_detail, course_key_original, course_detail_original from testimonials where author_name='Participante outro'");
  assert.deepEqual(r, { course_key: 'outro', course_detail: 'Formação em ABA', course_key_original: 'outro', course_detail_original: courseCase('outro').detail });
  // a API pública devolve só campos autorizados (o curso já vem pronto; nada do banco sobra)
  const pub = await publicList();
  for (const x of pub.featured.concat(pub.others)) assert.deepEqual(Object.keys(x).sort(), ['cohort', 'course', 'date', 'name', 'photo_url', 'profession', 'text']);
  assert.ok(!/course_|Participante varios|Weekend Pass e Imersão/.test(JSON.stringify(pub)));
});
test('22. Nenhum erro de console / violação de CSP durante os testes', async () => {
  const relevant = consoleErrors.filter((e) => !/Failed to load resource: the server responded with a status of (403|400|409|429|404)/.test(e));
  assert.deepEqual(relevant, []);
});
