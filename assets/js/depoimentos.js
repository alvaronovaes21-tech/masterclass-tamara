/* Depoimentos na landing page.
 * Busca a lista PÚBLICA (somente aprovados + publicados) na Edge Function e monta os cards
 * com createElement/textContent (nunca innerHTML), então o conteúdo enviado por alunos não executa código.
 * Não existem depoimentos de exemplo: sem dados, a seção mostra só um convite discreto. */
(function () {
  'use strict';

  var section = document.getElementById('depoimentos');
  if (!section) return;

  var cfg = window.SITE_CONFIG || {};
  var elFeatured = document.getElementById('dep-destaques');
  var elAll = document.getElementById('dep-todos');
  var elMoreWrap = document.getElementById('dep-mais-wrap');
  var elMore = document.getElementById('dep-mais');
  var elEmpty = document.getElementById('dep-vazio');
  var elCta = document.getElementById('dep-cta');
  var MAX_FEATURED = 5;

  function track(name) {
    try { if (typeof window.gtag === 'function') window.gtag('event', name); } catch (e) { /* ignora */ }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    var d = new Date(iso + 'T12:00:00');
    if (isNaN(d.getTime())) return null;
    try { return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); } catch (e) { return null; }
  }

  function safePhotoUrl(u) {
    // só aceita imagens servidas pelo próprio projeto Supabase configurado
    try {
      var x = new URL(u);
      var base = new URL(cfg.supabaseUrl);
      var local = /^(localhost|127\.0\.0\.1)$/.test(x.hostname);   // http só em desenvolvimento local
      return (x.protocol === 'https:' || local) && x.host === base.host ? x.href : null;
    } catch (e) { return null; }
  }

  function avatar(item) {
    var wrap = el('span', 'testi__avatar');
    var initial = (item.name || '?').trim().charAt(0).toLocaleUpperCase('pt-BR');
    var url = item.photo_url ? safePhotoUrl(item.photo_url) : null;
    if (url) {
      var img = document.createElement('img');
      img.src = url;
      img.alt = 'Foto de ' + item.name;
      img.width = 56; img.height = 56;
      img.loading = 'lazy'; img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () {
        img.remove();
        wrap.textContent = initial;
        wrap.classList.add('testi__avatar--initial');
      });
      wrap.appendChild(img);
    } else {
      wrap.textContent = initial;
      wrap.classList.add('testi__avatar--initial');
    }
    return wrap;
  }

  var uid = 0;
  function card(item) {
    var art = el('article', 'testi__card');
    art.setAttribute('role', 'listitem');

    var quote = el('blockquote', 'testi__quote');
    var p = el('p', 'testi__text', item.text);
    var pid = 'dep-txt-' + (++uid);
    p.id = pid;
    quote.appendChild(p);
    art.appendChild(quote);

    if ((item.text || '').length > 280) {
      p.classList.add('is-clamped');
      var btn = el('button', 'testi__toggle', 'Ler depoimento completo');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', pid);
      btn.addEventListener('click', function () {
        var open = p.classList.toggle('is-clamped') === false;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = open ? 'Mostrar menos' : 'Ler depoimento completo';
      });
      art.appendChild(btn);
    }

    var foot = el('footer', 'testi__author');
    foot.appendChild(avatar(item));
    var who = el('div', 'testi__who');
    who.appendChild(el('strong', 'testi__name', item.name));
    var meta = [item.profession, item.cohort].filter(Boolean).join(' · ');
    if (meta) who.appendChild(el('span', 'testi__meta', meta));
    // Curso ou evento a que o depoimento se refere (texto montado e autorizado pelo servidor; ausente em depoimentos antigos)
    if (typeof item.course === 'string' && item.course) who.appendChild(el('span', 'testi__course', item.course));
    var when = fmtDate(item.date);
    if (when) {
      var t = el('time', 'testi__date', when);
      t.setAttribute('datetime', item.date);
      who.appendChild(t);
    }
    foot.appendChild(who);
    art.appendChild(foot);
    return art;
  }

  function fill(container, items) {
    container.textContent = '';
    items.forEach(function (it) { container.appendChild(card(it)); });
    container.setAttribute('data-count', String(items.length));
  }

  function render(data) {
    var featured = Array.isArray(data.featured) ? data.featured : [];
    var others = Array.isArray(data.others) ? data.others : [];

    // Sem destaques escolhidos na administração? Mostra os mais recentes até a administração escolher.
    if (featured.length === 0 && others.length > 0) {
      featured = others.slice(0, MAX_FEATURED);
      others = others.slice(MAX_FEATURED);
    }
    if (featured.length === 0) return; // nada aprovado: mantém só o convite discreto

    fill(elFeatured, featured);
    elFeatured.hidden = false;
    elEmpty.hidden = true;
    elCta.hidden = false;
    section.classList.remove('is-empty');

    if (others.length > 0) {
      fill(elAll, others);
      elMoreWrap.hidden = false;
      elMore.addEventListener('click', function () {
        var open = elAll.hidden;
        elAll.hidden = !open;
        elMore.setAttribute('aria-expanded', open ? 'true' : 'false');
        elMore.textContent = open ? 'Mostrar menos depoimentos' : 'Ver todos os depoimentos';
        if (open) track('abriu_todos_depoimentos');
      });
    }

    // Evento analítico simples (sem texto nem dados pessoais): a seção foi vista.
    if ('IntersectionObserver' in window) {
      var seen = new IntersectionObserver(function (es) {
        if (es[0].isIntersecting) { track('viu_depoimentos'); seen.disconnect(); }
      }, { threshold: 0.3 });
      seen.observe(section);
    }
  }

  function load() {
    if (!cfg.supabaseUrl || !/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(cfg.supabaseUrl)) return; // ainda não configurado
    var ctrl = 'AbortController' in window ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    fetch(cfg.supabaseUrl + '/functions/v1/testimonials', { method: 'GET', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(render)
      .catch(function () { /* falha silenciosa: a página continua normal, com o convite discreto */ })
      .then(function () { if (timer) clearTimeout(timer); });
  }

  // Só busca quando a seção está perto da tela (não pesa o carregamento inicial).
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      if (es[0].isIntersecting) { io.disconnect(); load(); }
    }, { rootMargin: '800px 0px' });
    io.observe(section);
  } else {
    load();
  }
})();
