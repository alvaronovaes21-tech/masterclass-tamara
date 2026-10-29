// Lógica de validação PURA (sem dependências do Deno/Supabase) para poder ser testada em Node.
// Toda validação do formulário é refeita aqui, no servidor: o navegador nunca é confiável.

export const CONSENT_VERSION = 'v2-2026-10';
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
export const MIN_PHOTO_SIDE = 200;
export const MAX_PHOTO_SIDE = 8000;
export const MAX_PHOTO_PIXELS = 40_000_000;
export const BODY_MIN = 30;
export const BODY_MAX = 1000;

// ---------- Curso ou evento ----------
// Mantenha estes nomes iguais aos do formulário (enviar-depoimento/index.html) e do painel.
export const COURSES = {
  masterclass: 'Masterclass — Do Comportamento à Aprendizagem',
  at_pratica: 'A.T. na Prática',
  weekend_pass: 'Weekend Pass',
  imersao_crise: 'Imersão em Gerenciamento de Crise',
  outro: 'Outro curso ou evento',
  varios: 'Mais de um curso ou evento',
} as const;
export type CourseKey = keyof typeof COURSES;
export const COURSE_KEYS = Object.keys(COURSES) as CourseKey[];
export const COURSE_NEEDS_DETAIL: CourseKey[] = ['outro', 'varios'];
export const COURSE_OTHER_MAX = 120;
export const COURSE_MULTI_MAX = 200;

const PUBLIC_COURSE_LABEL: Record<string, string> = {
  masterclass: 'Participante da Masterclass — Do Comportamento à Aprendizagem',
  at_pratica: 'Participante do A.T. na Prática',
  weekend_pass: 'Participante do Weekend Pass',
  imersao_crise: 'Participante da Imersão em Gerenciamento de Crise',
};

/** Identificação PÚBLICA do curso/evento, decidida só no servidor. Retorna null quando não há o que exibir (depoimentos antigos, sem informação). */
export function publicCourseLabel(key: string | null | undefined, detail: string | null | undefined, detailPublic: boolean | null | undefined): string | null {
  if (!key) return null;
  if (PUBLIC_COURSE_LABEL[key]) return PUBLIC_COURSE_LABEL[key];
  if (key === 'outro') return detail ? `Participante de: ${detail}` : null;
  if (key === 'varios') return detailPublic && detail ? `Participante de: ${detail}` : 'Participante de múltiplas formações';
  return null;
}

export interface ImageInfo { type: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp'; width: number; height: number }

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o] * 2 ** 24) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));

/** Identifica o formato REAL pelo conteúdo (magic bytes) e lê as dimensões. Retorna null se não for JPEG/PNG/WebP válido. */
export function detectImage(b: Uint8Array): ImageInfo | null {
  if (b.length < 32) return null;

  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (ascii(b, 12, 4) !== 'IHDR') return null;
    return { type: 'image/png', ext: 'png', width: u32be(b, 16), height: u32be(b, 20) };
  }

  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      if (m === 0xd9 || m === 0xda) return null; // fim/scan sem ter achado SOF
      const len = u16be(b, o + 2);
      const isSOF = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (isSOF) return { type: 'image/jpeg', ext: 'jpg', height: u16be(b, o + 5), width: u16be(b, o + 7) };
      if (len < 2) return null;
      o += 2 + len;
    }
    return null;
  }

  // WebP
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const fmt = ascii(b, 12, 4);
    if (fmt === 'VP8 ') {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { type: 'image/webp', ext: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    if (fmt === 'VP8L') {
      if (b[20] !== 0x2f) return null;
      const width = 1 + (b[21] | ((b[22] & 0x3f) << 8));
      const height = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10));
      return { type: 'image/webp', ext: 'webp', width, height };
    }
    if (fmt === 'VP8X') {
      return { type: 'image/webp', ext: 'webp', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
    }
  }
  return null;
}

export function checkPhoto(bytes: Uint8Array): { ok: true; info: ImageInfo } | { ok: false; error: string } {
  if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, error: 'A foto é muito grande (máximo de 5 MB).' };
  const info = detectImage(bytes);
  if (!info) return { ok: false, error: 'Formato de imagem não aceito. Envie uma foto JPEG, PNG ou WebP.' };
  if (info.width < MIN_PHOTO_SIDE || info.height < MIN_PHOTO_SIDE) {
    return { ok: false, error: `A foto é muito pequena (mínimo de ${MIN_PHOTO_SIDE}×${MIN_PHOTO_SIDE} pixels).` };
  }
  if (info.width > MAX_PHOTO_SIDE || info.height > MAX_PHOTO_SIDE || info.width * info.height > MAX_PHOTO_PIXELS) {
    return { ok: false, error: 'A foto tem dimensões grandes demais. Envie uma versão menor.' };
  }
  return { ok: true, info };
}

// ---------- Texto ----------
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/;
const TAG_LIKE = /<\s*[a-zA-Z/!?]/;
const LINK_LIKE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|br|io|ru|xyz|top|info)\b)/i;

export function cleanLine(s: unknown): string {
  return String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}
export function cleanMultiline(s: unknown): string {
  return String(s ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function makeDisplayName(choice: string, fullName: string, custom: string): string {
  const parts = fullName.split(' ').filter(Boolean);
  if (choice === 'full') return fullName;
  if (choice === 'first') return parts[0];
  if (choice === 'first_initial') {
    if (parts.length < 2) return parts[0];
    const last = parts[parts.length - 1];
    return `${parts[0]} ${last.charAt(0).toLocaleUpperCase('pt-BR')}.`;
  }
  return custom;
}

export interface Submission {
  author_name: string; author_contact: string | null;
  display_choice: string; display_name: string;
  profession: string | null; cohort: string | null;
  course_key: CourseKey; course_detail: string | null;
  body: string; photo_consent: boolean;
}
export type FieldErrors = Record<string, string>;

export interface RawFields {
  author_name?: string; display_choice?: string; custom_name?: string; profession?: string; cohort?: string; contact?: string;
  course?: string; course_detail?: string;
  body?: string; consent_own?: string; consent_publication?: string; photo_consent?: string; consent_version?: string;
  website?: string; elapsed?: string;
}

export function validateSubmission(f: RawFields, hasPhoto: boolean): { bot: boolean; errors: FieldErrors; value?: Submission } {
  const errors: FieldErrors = {};

  // Antiabuso: campo-isca preenchido, ou preenchimento rápido demais para um humano.
  const elapsed = Number(f.elapsed);
  if (cleanLine(f.website) !== '') return { bot: true, errors };
  if (Number.isFinite(elapsed) && elapsed < 4000) return { bot: true, errors };

  const noBad = (s: string) => !CONTROL.test(s) && !TAG_LIKE.test(s);

  const name = cleanLine(f.author_name);
  if (name.length < 2 || name.length > 120) errors.author_name = 'Informe seu nome (de 2 a 120 caracteres).';
  else if (!noBad(name) || /[<>{}\[\]\\\/@]|https?:/i.test(name)) errors.author_name = 'O nome contém caracteres não permitidos.';

  const choice = cleanLine(f.display_choice);
  if (!['full', 'first', 'first_initial', 'custom'].includes(choice)) errors.display_choice = 'Escolha como deseja ser identificado(a).';

  const custom = cleanLine(f.custom_name);
  if (choice === 'custom') {
    if (custom.length < 2 || custom.length > 60) errors.custom_name = 'Informe como deseja ser identificado (de 2 a 60 caracteres).';
    else if (!noBad(custom) || LINK_LIKE.test(custom) || /[<>{}\[\]\\]/.test(custom)) errors.custom_name = 'Esse texto contém caracteres ou links não permitidos.';
  }

  const profession = cleanLine(f.profession);
  if (profession.length > 80) errors.profession = 'Use no máximo 80 caracteres.';
  else if (profession && (!noBad(profession) || LINK_LIKE.test(profession))) errors.profession = 'Esse campo contém caracteres ou links não permitidos.';

  const cohort = cleanLine(f.cohort);
  if (cohort.length > 80) errors.cohort = 'Use no máximo 80 caracteres.';
  else if (cohort && (!noBad(cohort) || LINK_LIKE.test(cohort))) errors.cohort = 'Esse campo contém caracteres ou links não permitidos.';

  // Curso ou evento (obrigatório; "outro" e "varios" exigem o texto complementar)
  const course = cleanLine(f.course) as CourseKey;
  const courseDetailRaw = cleanLine(f.course_detail);
  let courseDetail: string | null = null;
  if (!course) errors.course = 'Selecione o curso ou evento que você realizou.';
  else if (!COURSE_KEYS.includes(course)) errors.course = 'Selecione uma das opções da lista.';
  else if (COURSE_NEEDS_DETAIL.includes(course)) {
    const max = course === 'outro' ? COURSE_OTHER_MAX : COURSE_MULTI_MAX;
    if (courseDetailRaw.length < 2) {
      errors.course_detail = course === 'outro' ? 'Informe o nome do curso ou evento.' : 'Informe quais cursos ou eventos você deseja mencionar.';
    } else if (courseDetailRaw.length > max) {
      errors.course_detail = `Use no máximo ${max} caracteres.`;
    } else if (!noBad(courseDetailRaw) || LINK_LIKE.test(courseDetailRaw) || /[<>{}\[\]\\]/.test(courseDetailRaw)) {
      errors.course_detail = 'Esse campo contém caracteres ou links não permitidos.';
    } else courseDetail = courseDetailRaw;
  }
  // nas demais opções o texto complementar é ignorado (nunca é gravado)

  const contact = cleanLine(f.contact);
  if (contact) {
    const looksEmail = /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]{2,}$/.test(contact);
    const digits = contact.replace(/\D/g, '');
    const looksPhone = /^[\d\s()+\-.]+$/.test(contact) && digits.length >= 8 && digits.length <= 15;
    if (contact.length > 160 || (!looksEmail && !looksPhone)) errors.contact = 'Informe um e-mail ou telefone válido, ou deixe em branco.';
  }

  const body = cleanMultiline(f.body);
  if (body.length < BODY_MIN) errors.body = `Escreva pelo menos ${BODY_MIN} caracteres.`;
  else if (body.length > BODY_MAX) errors.body = `O depoimento pode ter no máximo ${BODY_MAX} caracteres.`;
  else if (!noBad(body)) errors.body = 'O texto contém caracteres não permitidos.';
  else if (LINK_LIKE.test(body)) errors.body = 'Por segurança, não aceitamos links no depoimento.';

  if (f.consent_own !== 'true') errors.consent_own = 'Confirme que o depoimento relata uma experiência real que você teve em um curso, evento ou formação da Tâmara San’Galo.';
  if (f.consent_publication !== 'true') errors.consent_publication = 'Para enviar, é necessário autorizar a análise e a possível publicação do texto.';
  if (f.consent_version !== CONSENT_VERSION) errors.consent_version = 'A página está desatualizada. Recarregue e tente novamente.';

  const photoConsent = f.photo_consent === 'true';
  if (hasPhoto && !photoConsent) errors.photo_consent = 'Para enviar uma foto, autorize o uso público da imagem ou remova a foto.';

  if (Object.keys(errors).length) return { bot: false, errors };

  const displayName = makeDisplayName(choice, name, custom);
  if (displayName.length < 2) {
    errors.display_choice = 'Com essa opção o nome público ficaria muito curto. Escolha outra opção.';
    return { bot: false, errors };
  }

  return {
    bot: false, errors,
    value: {
      author_name: name,
      author_contact: contact || null,
      display_choice: choice,
      display_name: displayName,
      profession: profession || null,
      cohort: cohort || null,
      course_key: course,
      course_detail: courseDetail,
      body,
      photo_consent: hasPhoto && photoConsent,
    },
  };
}
