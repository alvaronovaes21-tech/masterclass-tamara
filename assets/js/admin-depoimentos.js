/* Painel de moderação de depoimentos (/admin/depoimentos).
 *
 * Segurança: esta página é só uma interface. Quem decide o que cada pessoa pode ler/alterar é o BANCO
 * (Supabase Auth + RLS + permissões por coluna + triggers). Mesmo que alguém altere este arquivo no navegador,
 * sem ser administrador cadastrado nenhuma operação funciona (veja supabase/migrations).
 * Todo conteúdo é inserido com textContent/createElement (nunca innerHTML) para evitar XSS. */
(function () {
  'use strict';

  try { if (window.top !== window.self) { document.documentElement.style.display = 'none'; return; } }
  catch (e) { document.documentElement.style.display = 'none'; return; }

  var cfg = window.SITE_CONFIG || {};
  var BASE = (cfg.supabaseUrl && /^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(cfg.supabaseUrl)) ? cfg.supabaseUrl : null;
  var KEY = cfg.supabaseAnonKey || '';
  var BUCKET = 'testimonial-photos';
  var SKEY = 'mc_admin_session';
  var IDLE_MS = 30 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };

  // ---------- Pequeno helper de DOM ----------
  function h(tag, props) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === false || v == null) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(n, arguments[i]);
    return n;
  }
  function append(n, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(n, x); }); return; }
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function fmtDT(iso) { try { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return iso || ''; } }
  function fmtD(iso) { try { return new Date(iso).toLocaleDateString('pt-BR'); } catch (e) { return iso || ''; } }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 4500);
  }
  function panelMsg(msg) { var m = $('panel-msg'); m.textContent = msg || ''; m.hidden = !msg; }

  // ---------- Sessão e chamadas à API ----------
  var session = null;
  function saveSession(s) {
    session = s;
    try { if (s) sessionStorage.setItem(SKEY, JSON.stringify(s)); else sessionStorage.removeItem(SKEY); } catch (e) { /* ignora */ }
  }
  function loadSession() {
    try { var s = JSON.parse(sessionStorage.getItem(SKEY) || 'null'); return s && s.access_token && s.refresh_token ? s : null; } catch (e) { return null; }
  }
  function fromToken(j, email) {
    saveSession({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      email: (j.user && j.user.email) || email || (session && session.email) || '' });
  }
  function errMsg(data, status) {
    var m = data && (data.message || data.error_description || data.msg || data.error);
    return typeof m === 'string' && m ? m : 'Erro ' + status;
  }
  function refresh() {
    if (!session) return Promise.reject(new Error('Sessão expirada.'));
    return fetch(BASE + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (r) { if (!r.ok) throw new Error('Sessão expirada. Entre novamente.'); return r.json(); }).then(function (j) { fromToken(j); });
  }
  function rawFetch(path, opts) {
    var headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + session.access_token }, opts.headers || {});
    return fetch(BASE + path, { method: opts.method || 'GET', headers: headers, body: opts.body, credentials: 'omit' });
  }
  function api(path, opts) {
    opts = opts || {};
    if (!session) return Promise.reject(new Error('Faça login.'));
    var pre = session.expires_at - Date.now() < 60000 ? refresh() : Promise.resolve();
    return pre.then(function () { return rawFetch(path, opts); }).then(function (r) {
      if (r.status !== 401) return r;
      return refresh().then(function () { return rawFetch(path, opts); });
    }).then(function (r) {
      return r.text().then(function (t) {
        var data = null; try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!r.ok) { var e = new Error(errMsg(data, r.status)); e.status = r.status; throw e; }
        return data;
      });
    });
  }
  function rest(path, o) {
    o = o || {};
    var headers = { 'Content-Type': 'application/json' };
    if (o.prefer) headers.Prefer = o.prefer;
    return api('/rest/v1/' + path, { method: o.method || 'GET', headers: headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  }
  function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

  // ---------- Estado ----------
  var items = [], byId = {}, urls = {}, filter = 'pending', selectedId = null;
  var FILTERS = [
    ['pending', 'Pendentes', function (t) { return t.status === 'pending'; }],
    ['approved', 'Aprovados', function (t) { return t.status === 'approved'; }],
    ['published', 'Publicados', function (t) { return t.published; }],
    ['featured', 'Em destaque', function (t) { return t.featured_position != null; }],
    ['rejected', 'Recusados', function (t) { return t.status === 'rejected'; }],
    ['all', 'Todos', function () { return true; }]
  ];

  function loadAll() {
    return rest('testimonials?select=*&order=created_at.desc&limit=1000').then(function (rows) {
      items = rows || []; byId = {};
      items.forEach(function (t) { byId[t.id] = t; });
      return signPhotos();
    }).then(function () { renderAll(); });
  }
  function signPhotos() {
    var paths = items.map(function (t) { return t.photo_path; }).filter(Boolean);
    urls = {};
    if (!paths.length) return Promise.resolve();
    var chunks = []; for (var i = 0; i < paths.length; i += 100) chunks.push(paths.slice(i, i + 100));
    return Promise.all(chunks.map(function (c) {
      return api('/storage/v1/object/sign/' + BUCKET, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600, paths: c }) })
        .then(function (res) {
          (res || []).forEach(function (x) {
            if (x && x.signedURL && x.path) urls[x.path] = BASE + (x.signedURL.indexOf('/storage/v1') === 0 ? '' : '/storage/v1') + x.signedURL;
          });
        });
    })).catch(function () { /* imagens indisponíveis não impedem a moderação */ });
  }

  // ---------- Renderização geral ----------
  function renderAll() { renderFeatured(); renderFilters(); renderList(); renderEditor(); }

  function statusPills(t) {
    var p = [];
    if (t.status === 'pending') p.push(h('span', { class: 'pill pill--pending', text: 'Recebido · pendente' }));
    if (t.status === 'approved') p.push(h('span', { class: 'pill pill--approved', text: 'Aprovado' }));
    if (t.status === 'rejected') p.push(h('span', { class: 'pill pill--rejected', text: 'Recusado' }));
    if (t.published) p.push(h('span', { class: 'pill pill--published', text: 'Publicado' }));
    else if (t.status === 'approved') p.push(h('span', { class: 'pill', text: 'Oculto' }));
    if (t.featured_position != null) p.push(h('span', { class: 'pill pill--featured', text: 'Destaque #' + t.featured_position }));
    if (t.needs_author_confirmation) p.push(h('span', { class: 'pill pill--warn', text: 'Aguarda confirmação do autor' }));
    if (t.photo_path) p.push(h('span', { class: 'pill', text: 'Foto' }));
    return p;
  }

  function renderFilters() {
    var box = $('filtros'); box.textContent = '';
    FILTERS.forEach(function (f) {
      var n = items.filter(f[2]).length;
      box.appendChild(h('button', { type: 'button', class: 'chip', 'aria-pressed': filter === f[0] ? 'true' : 'false',
        onclick: function () { filter = f[0]; renderFilters(); renderList(); } }, f[1], h('small', { text: String(n) })));
    });
  }

  function renderList() {
    var box = $('lista'); box.textContent = '';
    var pred = FILTERS.filter(function (f) { return f[0] === filter; })[0][2];
    var rows = items.filter(pred);
    if (filter === 'featured') rows.sort(function (a, b) { return a.featured_position - b.featured_position; });
    if (!rows.length) { box.appendChild(h('p', { class: 'adm-empty', text: 'Nenhum depoimento nesta categoria.' })); return; }
    rows.forEach(function (t) {
      box.appendChild(h('button', { type: 'button', class: 'adm-item', role: 'listitem', 'aria-current': t.id === selectedId ? 'true' : 'false',
        onclick: function () { selectedId = t.id; renderList(); renderEditor(); window.scrollTo({ top: 0 }); } },
        h('span', { class: 'adm-item__top' }, h('strong', { text: t.display_name }), h('time', { datetime: t.created_at, text: fmtD(t.created_at) })),
        h('p', { text: t.body }),
        h('span', { class: 'pills' }, statusPills(t))));
    });
  }

  // ---------- Destaques ----------
  function featuredIds() {
    return items.filter(function (t) { return t.featured_position != null; })
      .sort(function (a, b) { return a.featured_position - b.featured_position; }).map(function (t) { return t.id; });
  }
  function setFeatured(ids, okMsg) {
    return rest('rpc/set_featured_testimonials', { method: 'POST', body: { p_ids: ids } })
      .then(function () { return loadAll(); })
      .then(function () { toast(okMsg || 'Destaques atualizados.'); })
      .catch(function (e) { panelMsg(e.message); toast('Não foi possível atualizar os destaques.'); });
  }
  function renderFeatured() {
    var list = $('feat-list'); list.textContent = '';
    var ids = featuredIds();
    $('feat-vazio').hidden = ids.length > 0;
    ids.forEach(function (id, i) {
      var t = byId[id];
      function move(d) { var n = ids.slice(); var x = n.splice(i, 1)[0]; n.splice(i + d, 0, x); setFeatured(n, 'Ordem atualizada.'); }
      list.appendChild(h('li', { class: 'feat-item' },
        h('span', { class: 'feat-item__name', text: t.display_name }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Subir ' + t.display_name, disabled: i === 0, onclick: function () { move(-1); } }, '↑'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Descer ' + t.display_name, disabled: i === ids.length - 1, onclick: function () { move(1); } }, '↓'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remover ' + t.display_name + ' dos destaques',
          onclick: function () { setFeatured(ids.filter(function (x) { return x !== id; }), 'Removido dos destaques.'); } }, '✕')));
    });
  }

  // ---------- Editor ----------
  var HISTORY_LABEL = {
    received: 'Depoimento recebido', approved: 'Aprovado', rejected: 'Recusado', returned_to_pending: 'Voltou para pendente',
    published: 'Publicado', unpublished: 'Ocultado da exibição pública', featured: 'Destacado', unfeatured: 'Removido dos destaques',
    body_edited: 'Texto editado', identification_edited: 'Identificação pública editada', photo_replaced: 'Foto substituída',
    photo_removed: 'Foto removida', photo_consent_revoked: 'Autorização de uso da foto revogada',
    author_confirmation_required: 'Marcado como exigindo confirmação do autor', author_confirmed: 'Confirmação do autor registrada',
    note_edited: 'Observação interna editada', deleted: 'Excluído'
  };

  function field(id, label, control, help) {
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), control, help ? h('p', { class: 'help', text: help }) : null);
  }

  function renderEditor() {
    var box = $('editor-corpo'); box.textContent = '';
    var layout = $('layout');
    var it = selectedId ? byId[selectedId] : null;
    layout.classList.toggle('is-editing', !!it);
    if (!it) { box.appendChild(h('p', { class: 'adm-empty', text: 'Selecione um depoimento para visualizar e moderar.' })); return; }

    var msg = h('div', { class: 'adm-msg notice notice--error', role: 'alert', hidden: true });
    function showMsg(text, kind) { msg.textContent = text || ''; msg.hidden = !text; msg.className = 'adm-msg notice ' + (kind || 'notice--error'); if (text) msg.scrollIntoView({ block: 'nearest' }); }

    var inDisplay = h('input', { type: 'text', id: 'ed-display', maxlength: '80', value: it.display_name });
    var inProf = h('input', { type: 'text', id: 'ed-prof', maxlength: '80', value: it.profession || '' });
    var inCohort = h('input', { type: 'text', id: 'ed-cohort', maxlength: '80', value: it.cohort || '' });
    var inBody = h('textarea', { id: 'ed-body', rows: '8', maxlength: '1200' }); inBody.value = it.body;
    var inNote = h('textarea', { id: 'ed-note', rows: '2', maxlength: '1000' }); inNote.value = it.admin_note || '';
    inNote.style.minHeight = '70px';
    var counter = h('p', { class: 'help', text: it.body.length + ' caracteres' });
    inBody.addEventListener('input', function () { counter.textContent = inBody.value.length + ' caracteres'; });
    var chkFlag = it.needs_author_confirmation ? null : h('input', { type: 'checkbox', id: 'ed-flag' });

    function dirtyPatch() {
      var p = {};
      var dn = clean(inDisplay.value); if (dn !== it.display_name) p.display_name = dn;
      var pr = clean(inProf.value) || null; if (pr !== (it.profession || null)) p.profession = pr;
      var co = clean(inCohort.value) || null; if (co !== (it.cohort || null)) p.cohort = co;
      var bd = inBody.value.replace(/\r\n?/g, '\n').trim(); if (bd !== it.body) p.body = bd;
      var nt = inNote.value.trim() || null; if (nt !== (it.admin_note || null)) p.admin_note = nt;
      if (chkFlag && chkFlag.checked) p.needs_author_confirmation = true;
      return p;
    }
    function check(p) {
      if ('display_name' in p && (p.display_name.length < 2 || p.display_name.length > 80)) return 'O nome público deve ter de 2 a 80 caracteres.';
      if ('body' in p && (p.body.length < 30 || p.body.length > 1200)) return 'O texto deve ter de 30 a 1200 caracteres.';
      if (p.profession && p.profession.length > 80) return 'Profissão: no máximo 80 caracteres.';
      if (p.cohort && p.cohort.length > 80) return 'Turma: no máximo 80 caracteres.';
      return null;
    }

    var buttons = [];
    function busy(b) { buttons.forEach(function (x) { x.disabled = b; }); }
    function btn(label, cls, fn, title) {
      var b = h('button', { type: 'button', class: 'btn btn--sm ' + (cls || ''), title: title, onclick: function () { fn(b); } }, label);
      buttons.push(b); return b;
    }

    // Salva campos editados + alterações extras em uma única atualização
    function save(extra, okMsg) {
      var p = Object.assign(dirtyPatch(), extra || {});
      if (!Object.keys(p).length) { toast('Nada para salvar.'); return Promise.resolve(); }
      var bad = check(p); if (bad) { showMsg(bad); return Promise.resolve(); }
      showMsg(''); busy(true);
      var wasFlagged = it.needs_author_confirmation;
      return rest('testimonials?id=eq.' + encodeURIComponent(it.id), { method: 'PATCH', body: p, prefer: 'return=representation' }).then(function (rows) {
        if (!rows || !rows.length) throw new Error('Nenhum registro foi atualizado (sem permissão ou registro inexistente).');
        var n = rows[0]; byId[n.id] = n; items = items.map(function (x) { return x.id === n.id ? n : x; });
        renderAll();
        if (n.needs_author_confirmation && !wasFlagged) {
          var again = $('editor-corpo').querySelector('.adm-msg');
          if (again) { again.className = 'adm-msg notice notice--warn'; again.textContent = 'O texto foi alterado além de correções ortográficas (ou marcado manualmente): o depoimento saiu da exibição pública até o autor confirmar a mudança.'; again.hidden = false; }
        }
        toast(okMsg || 'Alterações salvas.');
      }).catch(function (e) { busy(false); showMsg(e.message); });
    }
    function withSave(fn) {
      var p = dirtyPatch();
      if (!Object.keys(p).length) return fn();
      var bad = check(p); if (bad) { showMsg(bad); return Promise.resolve(); }
      return save(null, 'Alterações salvas.').then(function () { return fn(); });
    }

    // ----- Cabeçalho -----
    box.appendChild(h('h2', { text: it.display_name }));
    box.appendChild(h('div', { class: 'pills' }, statusPills(it)));

    box.appendChild(h('div', { class: 'adm-private' },
      h('h3', { text: 'Dados privados (não aparecem no site)' }),
      h('dl', null,
        h('dt', { text: 'Nome informado' }), h('dd', { text: it.author_name }),
        h('dt', { text: 'Contato' }), h('dd', { text: it.author_contact || 'não informado' }),
        h('dt', { text: 'Identificação escolhida' }), h('dd', { text: ({ full: 'Nome completo', first: 'Primeiro nome', first_initial: 'Nome e inicial do sobrenome', custom: 'Outra forma (personalizada)' })[it.display_choice] || it.display_choice }),
        h('dt', { text: 'Recebido em' }), h('dd', { text: fmtDT(it.created_at) }),
        h('dt', { text: 'Consentimento' }), h('dd', { text: 'texto ' + fmtDT(it.consent_at) + ' (versão ' + it.consent_version + ')' }),
        h('dt', { text: 'Uso da foto' }), h('dd', { text: it.photo_consent ? 'autorizado em ' + fmtDT(it.photo_consent_at) : 'não autorizado' }))));

    box.appendChild(msg);

    if (it.needs_author_confirmation) {
      var how = h('input', { type: 'text', id: 'ed-how', maxlength: '300', placeholder: 'Ex.: autor confirmou por WhatsApp em 29/10' });
      var cb = btn('Registrar confirmação do autor', 'btn--ok', function () {
        var v = how.value.trim(); if (v.length < 3) { showMsg('Descreva como o autor confirmou (obrigatório para o registro).'); return; }
        withSave(function () {
          busy(true);
          return rest('rpc/confirm_author_change', { method: 'POST', body: { p_id: it.id, p_note: v } })
            .then(function () { return loadAll(); }).then(function () { toast('Confirmação registrada.'); })
            .catch(function (e) { busy(false); showMsg(e.message); });
        });
      });
      box.appendChild(h('div', { class: 'notice notice--warn' },
        h('strong', { text: 'Aguardando confirmação do autor. ' }),
        'O texto foi alterado além de correções ortográficas e de digitação (ou marcado manualmente). Enquanto o autor não confirmar a nova versão, o depoimento não pode ser publicado. Entre em contato com o autor' + (it.author_contact ? ' (' + it.author_contact + ')' : '') + ', ou restaure o texto original.',
        h('div', { class: 'field' }, h('label', { for: 'ed-how', text: 'Como o autor confirmou?' }), how),
        cb));
    }

    // ----- Campos -----
    box.appendChild(h('div', { class: 'adm-grid2' },
      field('ed-display', 'Nome público', inDisplay, 'Respeite a escolha do participante (veja “Identificação escolhida”).'),
      field('ed-prof', 'Profissão / área', inProf),
      field('ed-cohort', 'Turma / modalidade', inCohort)));
    box.appendChild(field('ed-body', 'Texto do depoimento', inBody));
    box.appendChild(counter);
    box.appendChild(h('p', { class: 'help', text: 'Corrija apenas ortografia e digitação. Não mude o sentido nem acrescente declarações. Mudanças maiores exigem a confirmação do autor antes da publicação.' }));

    if (it.body !== it.original_body) {
      box.appendChild(h('details', { class: 'adm-orig' }, h('summary', { text: 'Ver texto original enviado pelo participante' }), h('p', { text: it.original_body })));
    }
    if (chkFlag) {
      box.appendChild(h('div', { class: 'field field--check' }, h('label', { class: 'check-row', for: 'ed-flag' }, chkFlag,
        h('span', { text: 'Marcar como “exige confirmação do autor” (use se a edição mudou o sentido do relato).' }))));
    }
    box.appendChild(field('ed-note', 'Observação interna (privada)', inNote));

    // ----- Foto -----
    var photoBox = h('div', { class: 'adm-photo' });
    if (it.photo_path) {
      var u = urls[it.photo_path];
      photoBox.appendChild(u ? h('img', { src: u, alt: 'Foto enviada por ' + it.display_name, width: '120', height: '120' }) : h('p', { class: 'help', text: 'Foto enviada (pré-visualização indisponível).' }));
      var fileIn = h('input', { type: 'file', class: 'sr-only', accept: 'image/jpeg,image/png,image/webp', tabindex: '-1', 'aria-hidden': 'true' });
      fileIn.addEventListener('change', function () {
        var f = fileIn.files && fileIn.files[0]; fileIn.value = ''; if (!f) return;
        showMsg(''); busy(true);
        window.PhotoTools.process(f).then(function (blob) {
          var rnd = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
          var path = it.id + '/' + rnd + '.jpg', old = it.photo_path;
          return api('/storage/v1/object/' + BUCKET + '/' + encPath(path), { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }, body: blob })
            .then(function () { return rest('testimonials?id=eq.' + encodeURIComponent(it.id), { method: 'PATCH', body: { photo_path: path }, prefer: 'return=representation' }); })
            .then(function (rows) {
              if (!rows || !rows.length) throw new Error('Não foi possível atualizar o registro.');
              return api('/storage/v1/object/' + BUCKET, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [old] }) }).catch(function () { /* arquivo antigo: tentativa */ });
            });
        }).then(function () { return loadAll(); }).then(function () { toast('Foto substituída.'); })
          .catch(function (e) { busy(false); showMsg(e.code ? window.PhotoTools.message(e) : e.message); });
      });
      var removePhoto = function (revoke) {
        showMsg(''); busy(true);
        var old = it.photo_path, p = { photo_path: null }; if (revoke) p.photo_consent = false;
        rest('testimonials?id=eq.' + encodeURIComponent(it.id), { method: 'PATCH', body: p, prefer: 'return=representation' }).then(function (rows) {
          if (!rows || !rows.length) throw new Error('Não foi possível atualizar o registro.');
          return api('/storage/v1/object/' + BUCKET, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [old] }) });
        }).then(function () { return loadAll(); }).then(function () { toast('Foto removida.'); })
          .catch(function (e) { busy(false); showMsg(e.message); loadAll(); });
      };
      photoBox.appendChild(h('div', { class: 'photo__actions' },
        btn('Substituir foto', 'btn--ghost', function () { fileIn.click(); }, 'Use apenas uma versão da mesma foto enviada pelo participante (ex.: recorte)'),
        btn('Remover foto', 'btn--ghost', function () { removePhoto(false); }),
        btn('Remover foto e registrar revogação do uso de imagem', 'btn--ghost', function () { removePhoto(true); }),
        fileIn));
    } else {
      photoBox.appendChild(h('p', { class: 'help', text: it.photo_consent ? 'Sem foto no momento.' : 'O participante não enviou foto ou não autorizou o uso de imagem.' }));
    }
    box.appendChild(h('h3', { class: 'adm-h3', text: 'Foto' }));
    box.appendChild(photoBox);

    // ----- Ações -----
    var canPublish = it.status === 'approved' && !it.needs_author_confirmation;
    var ids = featuredIds();
    var acts = h('div', { class: 'adm-actions' }, h('p', { class: 'adm-actions__label', text: 'Moderação' }));
    if (it.status !== 'approved') {
      acts.appendChild(btn('Aprovar', 'btn--ok', function () { save({ status: 'approved' }, 'Aprovado.'); }));
      if (!it.needs_author_confirmation) acts.appendChild(btn('Aprovar e publicar', 'btn--ok', function () { save({ status: 'approved', published: true }, 'Aprovado e publicado.'); }));
    }
    if (it.status !== 'rejected') acts.appendChild(btn('Recusar', 'btn--danger', function () { save({ status: 'rejected' }, 'Recusado (fora da exibição pública).'); }));
    if (it.status !== 'pending') acts.appendChild(btn('Voltar para pendente', 'btn--ghost', function () { save({ status: 'pending' }, 'Voltou para pendente.'); }));
    acts.appendChild(h('p', { class: 'adm-actions__label', text: 'Exibição pública' }));
    if (it.published) acts.appendChild(btn('Ocultar do site', 'btn--ghost', function () { save({ published: false }, 'Ocultado do site.'); }));
    else acts.appendChild(btn('Publicar', '', function () { save({ published: true }, 'Publicado.'); }, canPublish ? '' : 'Só depoimentos aprovados e sem pendência de confirmação podem ser publicados'));
    if (!it.published && !canPublish) acts.lastChild.disabled = true;
    if (it.published) {
      if (it.featured_position == null) {
        var full = ids.length >= 5;
        var bf = btn('Destacar na página', '', function () { withSave(function () { return setFeatured(ids.concat([it.id]), 'Depoimento destacado.'); }); }, full ? 'Já existem 5 destaques: remova um antes' : '');
        if (full) bf.disabled = true;
        acts.appendChild(bf);
      } else {
        acts.appendChild(btn('Remover dos destaques', 'btn--ghost', function () { withSave(function () { return setFeatured(ids.filter(function (x) { return x !== it.id; }), 'Removido dos destaques.'); }); }));
      }
    }
    box.appendChild(acts);

    var saveBtn = btn('Salvar alterações', '', function () { save(null, 'Alterações salvas.'); });
    box.appendChild(h('div', { class: 'adm-actions' }, saveBtn));

    // ----- Exclusão (2 etapas) -----
    var zone = h('div', { class: 'adm-danger' });
    var delBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Excluir depoimento…' });
    zone.appendChild(delBtn);
    buttons.push(delBtn);
    delBtn.addEventListener('click', function () {
      zone.textContent = '';
      zone.appendChild(h('p', { class: 'help adm-danger__txt', text: 'Excluir apaga o depoimento e a foto de forma definitiva. Essa ação não pode ser desfeita.' }));
      var yes = h('button', { type: 'button', class: 'btn btn--danger btn--sm', text: 'Sim, excluir definitivamente' });
      var no = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Cancelar', onclick: function () { renderEditor(); } });
      zone.appendChild(yes); zone.appendChild(no); no.focus();
      yes.addEventListener('click', function () {
        yes.disabled = true; no.disabled = true;
        var rmPhoto = it.photo_path
          ? api('/storage/v1/object/' + BUCKET, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [it.photo_path] }) })
          : Promise.resolve();
        rmPhoto.then(function () { return rest('testimonials?id=eq.' + encodeURIComponent(it.id), { method: 'DELETE', prefer: 'return=representation' }); })
          .then(function (rows) {
            if (!rows || !rows.length) throw new Error('Nenhum registro foi excluído (sem permissão).');
            selectedId = null; return loadAll();
          }).then(function () { toast('Depoimento excluído.'); })
          .catch(function (e) { renderEditor(); var m = $('editor-corpo').querySelector('.adm-msg'); if (m) { m.textContent = 'Não foi possível excluir: ' + e.message; m.hidden = false; } });
      });
    });
    box.appendChild(zone);

    // ----- Histórico -----
    var hist = h('div', { class: 'adm-history' }, h('h3', { text: 'Histórico de ações' }), h('p', { class: 'help', text: 'Carregando…' }));
    box.appendChild(hist);
    rest('testimonial_history?testimonial_id=eq.' + encodeURIComponent(it.id) + '&order=created_at.desc&limit=60').then(function (rows) {
      if (selectedId !== it.id) return;
      hist.lastChild.remove();
      if (!rows || !rows.length) { hist.appendChild(h('p', { class: 'help', text: 'Sem registros.' })); return; }
      hist.appendChild(h('ol', null, rows.map(function (r) {
        var label = HISTORY_LABEL[r.action] || r.action;
        if (r.action === 'featured' && r.details && r.details.position) label += ' (posição ' + r.details.position + ')';
        if (r.action === 'body_edited' && r.details && r.details.substantial) label += ' — alteração substancial';
        return h('li', null, h('time', { datetime: r.created_at, text: fmtDT(r.created_at) }), label, r.actor_email ? ' · ' + r.actor_email : '');
      })));
    }).catch(function () { if (hist.lastChild) hist.lastChild.textContent = 'Não foi possível carregar o histórico.'; });
  }

  $('btn-voltar').addEventListener('click', function () { selectedId = null; renderList(); renderEditor(); });

  // ---------- Login / sessão ----------
  var idleTimer = null;
  function resetIdle() { clearTimeout(idleTimer); if (session) idleTimer = setTimeout(function () { signOut('Sessão encerrada por inatividade.'); }, IDLE_MS); }
  ['click', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, resetIdle, { passive: true }); });

  function show(view) { $('login-view').hidden = view !== 'login'; $('panel-view').hidden = view !== 'panel'; }
  function loginError(msg) { var e = $('l-erro'); e.textContent = msg || ''; e.hidden = !msg; }

  function signOut(reason) {
    var s = session;
    if (s && BASE) fetch(BASE + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + s.access_token } }).catch(function () { /* ignora */ });
    saveSession(null); items = []; byId = {}; urls = {}; selectedId = null; clearTimeout(idleTimer);
    // remove dados pessoais da tela ao sair (a página fica aberta, mas sem nada dentro)
    ['lista', 'editor-corpo', 'feat-list', 'filtros'].forEach(function (id) { $(id).textContent = ''; });
    $('layout').classList.remove('is-editing'); $('user-email').textContent = ''; panelMsg('');
    $('l-pass').value = '';
    show('login'); loginError(reason || '');
  }
  $('btn-sair').addEventListener('click', function () { signOut(''); });

  function enterPanel() {
    return rest('rpc/is_admin', { method: 'POST', body: {} }).then(function (ok) {
      if (ok !== true) { signOut('Esta conta não tem permissão de administrador.'); return; }
      $('user-email').textContent = session.email || '';
      show('panel'); panelMsg(''); resetIdle();
      return loadAll();
    });
  }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault(); loginError('');
    var email = clean($('l-email').value), pass = $('l-pass').value;
    if (!email || !pass) { loginError('Informe e-mail e senha.'); return; }
    var b = $('l-btn'); b.disabled = true; b.textContent = 'Entrando…';
    fetch(BASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: pass }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error('E-mail ou senha incorretos.'); e.status = r.status; throw e; } return j; }); })
      .then(function (j) { fromToken(j, email); $('l-pass').value = ''; return enterPanel(); })
      .catch(function (e) { loginError(e.status ? e.message : 'Não foi possível entrar. Verifique a conexão e tente novamente.'); })
      .then(function () { b.disabled = false; b.textContent = 'Entrar'; });
  });

  // ---------- Início ----------
  if (!BASE || !KEY) {
    show('login'); $('cfg-aviso').hidden = false;
    Array.prototype.forEach.call($('login-form').elements, function (c) { c.disabled = true; });
    return;
  }
  session = loadSession();
  if (session) {
    show('panel'); $('panel-view').hidden = true; // evita piscar o painel antes de validar
    enterPanel().catch(function () { signOut(''); });
  } else {
    show('login');
  }
})();
