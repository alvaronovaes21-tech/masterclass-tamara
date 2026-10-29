/* Preparação segura de fotos no navegador (usada pelo formulário e pelo painel).
 * Confere o TIPO REAL do arquivo (bytes iniciais, não a extensão), tamanho e dimensões, reduz para no máximo
 * 1024 px e regrava em JPEG num <canvas> (o que descarta EXIF/GPS). Rejeita qualquer coisa que não seja
 * JPEG, PNG ou WebP. O servidor valida tudo de novo. */
(function () {
  'use strict';

  var MAX_INPUT_BYTES = 10 * 1024 * 1024;
  var MAX_OUTPUT_BYTES = 4.5 * 1024 * 1024;
  var MIN_SIDE = 200, MAX_INPUT_SIDE = 12000, OUT_SIDE = 1024;

  function fail(code) { var e = new Error(code); e.code = code; return e; }

  function readHead(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(fail('read')); };
      fr.readAsArrayBuffer(file.slice(0, 16));
    });
  }
  function realType(h) {
    if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'jpeg';
    if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'png';
    if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) return 'webp';
    return null;
  }
  function viaImg(file) {
    return new Promise(function (resolve, reject) {
      var u = URL.createObjectURL(file), im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); resolve(im); };
      im.onerror = function () { URL.revokeObjectURL(u); reject(fail('read')); };
      im.src = u;
    });
  }
  function decode(file) {
    if ('createImageBitmap' in window) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return viaImg(file); });
    }
    return viaImg(file);
  }
  function toJpeg(canvas, q) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', q); });
  }

  var MESSAGES = {
    too_big: 'A foto é muito grande (máximo de 10 MB). Escolha outra imagem.',
    type: 'Formato não aceito. Envie uma foto JPEG, PNG ou WebP (fotos HEIC do iPhone devem ser salvas como JPEG).',
    small: 'A foto é muito pequena (mínimo de 200×200 pixels).',
    large: 'A foto tem dimensões grandes demais.',
    size: 'Não foi possível reduzir a foto o suficiente. Escolha outra imagem.',
    read: 'Não foi possível ler essa imagem. Tente outra foto.'
  };

  function processPhoto(file) {
    if (!file) return Promise.reject(fail('read'));
    if (file.size > MAX_INPUT_BYTES) return Promise.reject(fail('too_big'));
    return readHead(file).then(function (head) {
      if (!realType(head)) throw fail('type');
      return decode(file);
    }).then(function (img) {
      var w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
      if (w < MIN_SIDE || h < MIN_SIDE) throw fail('small');
      if (w > MAX_INPUT_SIDE || h > MAX_INPUT_SIDE) throw fail('large');
      var scale = Math.min(1, OUT_SIDE / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);   // transparência -> fundo branco
      ctx.drawImage(img, 0, 0, cw, ch);
      if (img.close) img.close();
      return toJpeg(canvas, 0.86).then(function (blob) {
        if (blob && blob.size > MAX_OUTPUT_BYTES) return toJpeg(canvas, 0.6);
        return blob;
      });
    }).then(function (blob) {
      if (!blob || blob.size > MAX_OUTPUT_BYTES) throw fail('size');
      return blob;
    });
  }

  window.PhotoTools = {
    process: processPhoto,
    message: function (err) { return MESSAGES[err && err.code] || MESSAGES.read; }
  };
})();
