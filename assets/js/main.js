/* Masterclass - scripts leves e seguros (sem bibliotecas externas, sem innerHTML) */
(function () {
  'use strict';

  // Proteção contra "clickjacking": impede que o site seja aberto dentro de outro site.
  try {
    if (window.top !== window.self) {
      window.top.location = window.self.location;
    }
  } catch (e) {
    document.documentElement.style.display = 'none';
  }

  document.documentElement.classList.add('js');

  // Ano automático no rodapé
  var ano = document.getElementById('ano');
  if (ano) ano.textContent = String(new Date().getFullYear());

  // ---------- Vídeo (carrega só quando a pessoa clica = economiza memória e dados) ----------
  var box = document.getElementById('video-box');
  if (box) {
    var id = (box.getAttribute('data-video-id') || '').trim();
    var title = box.getAttribute('data-video-title') || 'Vídeo de apresentação';

    // Aceita somente o formato válido de ID do YouTube (11 caracteres)
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
      var placeholder = document.getElementById('video-placeholder');
      if (placeholder) placeholder.remove();

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'video__thumb';
      btn.setAttribute('aria-label', 'Reproduzir vídeo: ' + title);

      var img = document.createElement('img');
      img.src = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 480;
      img.height = 360;

      var play = document.createElement('span');
      play.className = 'video__play';
      var svgNS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '38');
      svg.setAttribute('height', '38');
      svg.setAttribute('aria-hidden', 'true');
      var path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', 'M8 5v14l11-7L8 5Z');
      path.setAttribute('fill', 'currentColor');
      svg.appendChild(path);
      play.appendChild(svg);

      btn.appendChild(img);
      btn.appendChild(play);
      box.appendChild(btn);

      btn.addEventListener('click', function () {
        var iframe = document.createElement('iframe');
        iframe.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0&modestbranding=1';
        iframe.title = title;
        iframe.allow = 'accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen';
        iframe.allowFullscreen = true;
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        btn.remove();
        box.appendChild(iframe);
      });
    }
  }

  // ---------- Medição: cliques nos botões que levam ao checkout da Hotmart ----------
  // Dois eventos no mesmo clique, ambos SEM dados pessoais e SEM valor de compra:
  // 1) clique_checkout_hotmart — evento interno já existente (local do CTA).
  // 2) conversion do Google Ads — intenção de abrir o checkout (NÃO é compra).
  // A compra efetiva continua sendo medida só pela integração Hotmart já configurada.
  // A tag global AW-18537932244 já está em gtag-init.js; daqui só disparamos o evento.
  var ADS_CLICK_SEND_TO = 'AW-18537932244/0FoaCOflyK4dENTLyYdF';
  var ADS_CLICK_TIMEOUT_MS = 2000;

  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[data-cta]') : null;
    if (!a) return;

    var url = a.href || '';
    var opensNewTab = String(a.getAttribute('target') || '').toLowerCase() === '_blank';
    var conversionSent = false;
    var leftPage = false;

    function sendAdsClickConversion(onDone) {
      var finished = false;
      function done() {
        if (finished) return;
        finished = true;
        if (typeof onDone === 'function') onDone();
      }

      if (conversionSent) {
        done();
        return;
      }
      conversionSent = true;

      if (typeof window.gtag !== 'function') {
        done();
        return;
      }

      try {
        window.gtag('event', 'conversion', {
          send_to: ADS_CLICK_SEND_TO,
          event_callback: done,
          event_timeout: ADS_CLICK_TIMEOUT_MS
        });
      } catch (e) {
        done();
        return;
      }

      // Se a tag não responder (bloqueada, lenta, etc.), não prende o usuário.
      window.setTimeout(done, ADS_CLICK_TIMEOUT_MS);
    }

    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'clique_checkout_hotmart', { cta_local: a.getAttribute('data-cta') || 'desconhecido' });
      }
    } catch (e) { /* medição nunca pode atrapalhar a navegação */ }

    // Nova aba: o navegador segue o link no gesto do clique. Só medimos em paralelo.
    // Sem preventDefault — senão o checkout pode ser bloqueado como pop-up.
    if (opensNewTab) {
      sendAdsClickConversion(null);
      return;
    }

    // Mesma aba (defesa, caso algum CTA perca o target=_blank): espera a tag com teto de 2s.
    if (!url) return;
    ev.preventDefault();
    sendAdsClickConversion(function () {
      if (leftPage) return;
      leftPage = true;
      window.location.href = url;
    });
  });

  // ---------- Animações de entrada ----------
  var items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target); // libera memória: para de observar após aparecer
        }
      });
    }, { threshold: 0.12 });
    items.forEach(function (el) { io.observe(el); });
  } else {
    items.forEach(function (el) { el.classList.add('in'); });
  }

  // ---------- Botão fixo no celular ----------
  var sticky = document.getElementById('sticky');
  var hero = document.getElementById('inicio');
  if (sticky && hero && 'IntersectionObserver' in window) {
    var link = sticky.querySelector('a');
    var so = new IntersectionObserver(function (entries) {
      var visible = !entries[0].isIntersecting;
      sticky.classList.toggle('is-on', visible);
      sticky.setAttribute('aria-hidden', visible ? 'false' : 'true');
      if (link) link.tabIndex = visible ? 0 : -1;
    }, { threshold: 0 });
    so.observe(hero);
  }
})();
