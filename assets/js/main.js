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
  // Evento separado e SEM dados pessoais. Isto NÃO é uma compra: a compra efetiva continua
  // sendo medida pela integração já existente (Hotmart/Google), não por este clique.
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[data-cta]') : null;
    if (!a || typeof window.gtag !== 'function') return;
    try {
      window.gtag('event', 'clique_checkout_hotmart', { cta_local: a.getAttribute('data-cta') || 'desconhecido' });
    } catch (e) { /* medição nunca pode atrapalhar a navegação */ }
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
