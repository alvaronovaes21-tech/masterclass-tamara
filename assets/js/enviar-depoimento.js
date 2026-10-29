/* Formulário público de depoimentos.
 * - Validação no navegador é só conforto: o servidor (Edge Function) valida tudo de novo.
 * - A foto é lida, conferida (tipo real, tamanho, dimensões), reduzida e regravada em JPEG num <canvas>,
 *   o que também descarta metadados (EXIF/GPS).
 * - Nada é guardado no navegador (sem localStorage). Nada é enviado a plataformas de anúncio. */
(function () {
  'use strict';

  var cfg = window.SITE_CONFIG || {};
  var ENDPOINT = (cfg.supabaseUrl && /^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(cfg.supabaseUrl))
    ? cfg.supabaseUrl + '/functions/v1/testimonials' : null;

  var BODY_MIN = 30, BODY_MAX = 1000;

  var form = document.getElementById('form');
  if (!form) return;
  var loadedAt = Date.now();
  var $ = function (id) { return document.getElementById(id); };

  var btnSend = $('btn-enviar'), statusEl = $('status');
  var photoBlob = null, photoUrl = null, photoBusy = false;
  var turnstileId = null;

  // ---------- Configuração ausente: não finge que funciona ----------
  if (!ENDPOINT) {
    $('aviso-config').hidden = false;
    btnSend.disabled = true;
    Array.prototype.forEach.call(form.elements, function (c) { c.disabled = true; });
    return;
  }

  // ---------- Utilidades de erro ----------
  var FIELD_LABEL = {
    author_name: 'Nome', display_choice: 'Identificação pública', custom_name: 'Identificação pública',
    profession: 'Profissão', cohort: 'Turma', contact: 'Contato', body: 'Depoimento',
    course: 'Curso ou evento', course_detail: 'Curso ou evento',
    photo: 'Foto', photo_consent: 'Autorização da foto', consent_own: 'Confirmação do relato',
    consent_publication: 'Autorização de publicação', captcha: 'Verificação de segurança', consent_version: 'Página', geral: 'Envio'
  };
  var FOCUS_ID = {
    author_name: 'f-author_name', display_choice: null, custom_name: 'f-custom_name', profession: 'f-profession', cohort: 'f-cohort',
    contact: 'f-contact', course: 'course-first', course_detail: 'f-course_detail', body: 'f-body', photo: 'btn-galeria', photo_consent: 'f-photo_consent', consent_own: 'f-consent_own',
    consent_publication: 'f-consent_publication', captcha: null, consent_version: null, geral: null
  };

  function setError(key, msg) {
    var e = $('e-' + key);
    var input = $('f-' + key);
    if (e) { e.textContent = msg || ''; e.hidden = !msg; }
    if (input) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  }
  function clearErrors() {
    Object.keys(FIELD_LABEL).forEach(function (k) { setError(k, ''); });
    var box = $('resumo-erros'); box.hidden = true; $('resumo-lista').textContent = '';
  }
  function showErrors(errors) {
    var list = $('resumo-lista'); list.textContent = '';
    var first = null;
    Object.keys(errors).forEach(function (k) {
      setError(k, errors[k]);
      var li = document.createElement('li');
      var focusId = FOCUS_ID[k];
      if (focusId) {
        var a = document.createElement('a'); a.href = '#' + focusId; a.textContent = (FIELD_LABEL[k] || k) + ': ' + errors[k];
        a.addEventListener('click', function (ev) { ev.preventDefault(); var t = $(focusId); if (t) t.focus(); });
        li.appendChild(a);
      } else { li.textContent = (FIELD_LABEL[k] || k) + ': ' + errors[k]; }
      list.appendChild(li);
      if (!first) first = k;
    });
    var box = $('resumo-erros'); box.hidden = false; box.focus();
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ---------- Nome público (pré-visualização) ----------
  function choice() { var r = form.querySelector('input[name="display_choice"]:checked'); return r ? r.value : ''; }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function publicName() {
    var name = clean($('f-author_name').value), parts = name.split(' ').filter(Boolean), c = choice();
    if (!name) return '';
    if (c === 'full') return name;
    if (c === 'first') return parts[0];
    if (c === 'first_initial') return parts.length > 1 ? parts[0] + ' ' + parts[parts.length - 1].charAt(0).toLocaleUpperCase('pt-BR') + '.' : parts[0];
    if (c === 'custom') return clean($('f-custom_name').value);
    return '';
  }
  function updatePreview() {
    $('custom-wrap').hidden = choice() !== 'custom';
    var n = publicName(), p = $('preview-nome');
    p.hidden = !n; p.textContent = n ? 'Seu nome será exibido assim: ' + n : '';
  }
  form.addEventListener('input', updatePreview);
  form.addEventListener('change', updatePreview);

  // ---------- Curso ou evento ----------
  // Mantenha os nomes iguais aos da Edge Function (validate.ts) e do painel.
  var COURSE_NEEDS_DETAIL = { outro: true, varios: true };
  function course() { var r = form.querySelector('input[name="course"]:checked'); return r ? r.value : ''; }
  function updateCourse() {
    var c = course(), wrap = $('course-detail-wrap'), input = $('f-course_detail');
    var need = !!COURSE_NEEDS_DETAIL[c];
    wrap.hidden = !need;
    input.required = need;
    if (!need) { input.value = ''; setError('course_detail', ''); return; }
    var lab = $('course-detail-label').firstChild;
    if (c === 'outro') {
      lab.textContent = 'Qual curso ou evento? ';
      input.maxLength = 120; input.placeholder = 'Nome do curso ou evento';
      $('h-course_detail').textContent = 'O nome informado poderá ser exibido junto ao seu depoimento, se ele for aprovado.';
    } else {
      lab.textContent = 'Quais cursos ou eventos você deseja mencionar? ';
      input.maxLength = 200; input.placeholder = 'Ex.: Weekend Pass e A.T. na Prática';
      $('h-course_detail').textContent = 'Os nomes serão analisados pela administração. Se não forem publicados, o depoimento aparece como “Participante de múltiplas formações”.';
    }
  }
  form.addEventListener('change', function (ev) {
    if (ev.target && ev.target.name === 'course') { setError('course', ''); updateCourse(); }
  });
  updateCourse();

  // ---------- Contador ----------
  var body = $('f-body');
  function updateCount() {
    var n = body.value.length; $('contador-n').textContent = String(n);
    $('contador').classList.toggle('is-low', n > 0 && n < BODY_MIN);
    $('contador').classList.toggle('is-max', n >= BODY_MAX);
  }
  body.addEventListener('input', updateCount);
  updateCount();

  // ---------- Foto ----------
  function processPhoto(file) {
    if (!file) return Promise.resolve();
    setError('photo', '');
    photoBusy = true; btnSend.disabled = true;
    return window.PhotoTools.process(file).then(function (blob) {
      setPhoto(blob);
    }).catch(function (err) {
      setError('photo', window.PhotoTools.message(err));
    }).then(function () { photoBusy = false; btnSend.disabled = false; });
  }

  function setPhoto(blob) {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoBlob = blob; photoUrl = URL.createObjectURL(blob);
    $('photo-img').src = photoUrl;
    $('photo-info').textContent = 'Foto pronta para envio (' + Math.max(1, Math.round(blob.size / 1024)) + ' KB).';
    $('photo-empty').hidden = true; $('photo-preview').hidden = false; $('photo-consent-wrap').hidden = false;
  }
  function removePhoto() {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoBlob = null; photoUrl = null; $('photo-img').removeAttribute('src');
    $('photo-empty').hidden = false; $('photo-preview').hidden = true; $('photo-consent-wrap').hidden = true;
    $('f-photo_consent').checked = false; setError('photo', ''); setError('photo_consent', '');
    $('in-galeria').value = ''; $('in-camera').value = '';
  }
  $('btn-galeria').addEventListener('click', function () { $('in-galeria').click(); });
  $('btn-camera').addEventListener('click', function () { $('in-camera').click(); });
  $('btn-trocar').addEventListener('click', function () { $('in-galeria').click(); });
  $('btn-remover').addEventListener('click', function () { removePhoto(); $('btn-galeria').focus(); });
  ['in-galeria', 'in-camera'].forEach(function (id) {
    $(id).addEventListener('change', function (ev) { var f = ev.target.files && ev.target.files[0]; processPhoto(f); ev.target.value = ''; });
  });

  // ---------- Validação (conforto; o servidor valida de novo) ----------
  var LINK = /(https?:\/\/|www\.)/i;
  function validate() {
    var e = {};
    var name = clean($('f-author_name').value);
    if (name.length < 2) e.author_name = 'Informe seu nome.';
    if (!choice()) e.display_choice = 'Escolha como deseja ser identificado(a).';
    if (choice() === 'custom') {
      var c = clean($('f-custom_name').value);
      if (c.length < 2) e.custom_name = 'Informe como deseja aparecer (mínimo de 2 caracteres).';
    }
    if (choice() && choice() !== 'custom' && publicName().length < 2) e.display_choice = 'Com essa opção o nome ficaria muito curto. Escolha outra.';
    var cs = course();
    if (!cs) e.course = 'Selecione o curso ou evento que você realizou.';
    else if (COURSE_NEEDS_DETAIL[cs]) {
      var cd = clean($('f-course_detail').value);
      if (cd.length < 2) e.course_detail = cs === 'outro' ? 'Informe o nome do curso ou evento.' : 'Informe quais cursos ou eventos você deseja mencionar.';
      else if (cd.length > (cs === 'outro' ? 120 : 200)) e.course_detail = 'Use no máximo ' + (cs === 'outro' ? 120 : 200) + ' caracteres.';
      else if (LINK.test(cd)) e.course_detail = 'Esse campo não aceita links.';
    }
    var txt = body.value.trim();
    if (txt.length < BODY_MIN) e.body = 'Escreva pelo menos ' + BODY_MIN + ' caracteres (você escreveu ' + txt.length + ').';
    else if (txt.length > BODY_MAX) e.body = 'O depoimento pode ter no máximo ' + BODY_MAX + ' caracteres.';
    else if (LINK.test(txt)) e.body = 'Por segurança, não aceitamos links no depoimento.';
    var contact = clean($('f-contact').value);
    if (contact) {
      var digits = contact.replace(/\D/g, '');
      var okMail = /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]{2,}$/.test(contact);
      var okTel = /^[\d\s()+\-.]+$/.test(contact) && digits.length >= 8 && digits.length <= 15;
      if (!okMail && !okTel) e.contact = 'Informe um e-mail ou telefone válido, ou deixe em branco.';
    }
    if (photoBlob && !$('f-photo_consent').checked) e.photo_consent = 'Para enviar a foto, autorize o uso público da imagem, ou remova a foto.';
    if (!$('f-consent_own').checked) e.consent_own = 'Confirme que o depoimento relata uma experiência real que você teve em um curso, evento ou formação da Tâmara San’Galo.';
    if (!$('f-consent_publication').checked) e.consent_publication = 'Para enviar, é necessário autorizar a análise e a possível publicação do texto.';
    if (cfg.turnstileSiteKey && window.turnstile && turnstileId !== null && !window.turnstile.getResponse(turnstileId)) e.captcha = 'Confirme a verificação de segurança.';
    return e;
  }

  // ---------- Turnstile opcional ----------
  if (cfg.turnstileSiteKey && /^[0-9A-Za-z_-]{8,}$/.test(cfg.turnstileSiteKey)) {
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    s.onload = function () {
      $('turnstile-box').hidden = false;
      turnstileId = window.turnstile.render('#turnstile-box', { sitekey: cfg.turnstileSiteKey, language: 'pt-BR' });
    };
    document.head.appendChild(s);
  }

  // ---------- Envio ----------
  function setBusy(b) {
    btnSend.disabled = b; btnSend.setAttribute('aria-busy', b ? 'true' : 'false');
    btnSend.textContent = b ? 'Enviando…' : 'Enviar meu depoimento';
    statusEl.textContent = b ? 'Enviando o seu depoimento, aguarde.' : '';
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (photoBusy) { statusEl.textContent = 'Aguarde: a foto ainda está sendo preparada.'; return; }
    clearErrors();
    var errs = validate();
    if (Object.keys(errs).length) { showErrors(errs); return; }

    var fd = new FormData();
    fd.append('author_name', clean($('f-author_name').value));
    fd.append('display_choice', choice());
    fd.append('custom_name', clean($('f-custom_name').value));
    fd.append('profession', clean($('f-profession').value));
    fd.append('cohort', clean($('f-cohort').value));
    fd.append('contact', clean($('f-contact').value));
    fd.append('course', course());
    fd.append('course_detail', COURSE_NEEDS_DETAIL[course()] ? clean($('f-course_detail').value) : '');
    fd.append('body', body.value.trim());
    fd.append('consent_own', $('f-consent_own').checked ? 'true' : 'false');
    fd.append('consent_publication', $('f-consent_publication').checked ? 'true' : 'false');
    fd.append('photo_consent', photoBlob && $('f-photo_consent').checked ? 'true' : 'false');
    fd.append('consent_version', form.getAttribute('data-consent-version'));
    fd.append('website', $('f-website').value);
    fd.append('elapsed', String(Date.now() - loadedAt));
    if (photoBlob) fd.append('photo', photoBlob, 'foto.jpg');
    if (turnstileId !== null && window.turnstile) fd.append('cf-turnstile-response', window.turnstile.getResponse(turnstileId) || '');

    setBusy(true);
    var ctrl = 'AbortController' in window ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 45000) : null;

    fetch(ENDPOINT, { method: 'POST', body: fd, credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, data: j }; }); })
      .then(function (res) {
        if (res.status === 201 && res.data && res.data.ok) { done(); return; }
        setBusy(false);
        if (res.data && res.data.errors) { showErrors(res.data.errors); return; }
        showErrors({ geral: (res.data && res.data.message) || 'Não foi possível enviar agora. Tente novamente em instantes.' });
      })
      .catch(function () {
        setBusy(false);
        showErrors({ geral: 'Não foi possível conectar. Verifique sua internet e tente novamente. Seus dados continuam preenchidos.' });
      })
      .then(function () { if (timer) clearTimeout(timer); });
  });

  function done() {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoBlob = null; photoUrl = null;
    form.reset(); form.hidden = true;
    $('intro').hidden = true; $('resumo-erros').hidden = true;
    var ok = $('sucesso'); ok.hidden = false; ok.focus();
    ok.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Aviso ao sair com texto não enviado
  window.addEventListener('beforeunload', function (e) {
    if (!form.hidden && body.value.trim().length > 0) { e.preventDefault(); e.returnValue = ''; }
  });
})();
