-- =====================================================================
--  Depoimentos: curso ou evento do participante + novos textos de consentimento
--
--  Execute este arquivo UMA vez no SQL Editor do Supabase, DEPOIS da migração
--  20261029000000_depoimentos.sql (que já foi executada). Pode ser executado
--  de novo sem problemas.
--
--  O que muda:
--   * Nova versão do texto de consentimento: "v2-2026-10" (a v1 continua
--     registrada para os depoimentos antigos; nada é reescrito).
--   * Novas colunas em `testimonials` para registrar o curso/evento.
--     Depoimentos que já existiam ficam com curso NULO ("não informado"):
--     nenhum curso é atribuído retroativamente.
--   * O banco passa a EXIGIR o curso/evento para depoimentos enviados com o
--     texto novo (v2), independentemente da validação do navegador/servidor.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Nova versão dos textos de consentimento
--    IMPORTANTE: devem ser idênticos aos exibidos em enviar-depoimento/index.html.
-- ---------------------------------------------------------------------
insert into public.consent_texts (version, own_experience_text, publication_text, photo_text) values (
  'v2-2026-10',
  'Declaro que este depoimento relata uma experiência real que tive em um curso, evento ou formação ministrado por Tâmara San’Galo ou por sua equipe.',
  'Autorizo que meu depoimento seja analisado pela administração e, se aprovado, publicado neste site com a identificação pública que escolhi. Estou ciente de que a publicação é opcional, que o texto poderá receber correções ortográficas e de digitação sem alteração do seu sentido e que posso solicitar a retirada do depoimento pelo e-mail informado na Política de Privacidade.',
  'Autorizo o uso público da minha foto, enviada acima, junto ao meu depoimento neste site, caso ele seja aprovado e publicado. Esta autorização é separada da autorização do texto e pode ser retirada a qualquer momento pelo e-mail psicoepedagoga@gmail.com.'
) on conflict (version) do nothing;

-- ---------------------------------------------------------------------
-- 2. Curso ou evento
--    course_key              opção escolhida (NULA = depoimento antigo, "não informado")
--    course_detail           nome do curso (opção "outro") ou lista (opção "varios")
--    course_detail_public    a administração autoriza exibir a lista da opção "varios"
--    course_*_original       exatamente o que o participante informou (auditoria; ninguém edita)
-- ---------------------------------------------------------------------
alter table public.testimonials
  add column if not exists course_key             text,
  add column if not exists course_detail          text,
  add column if not exists course_detail_public   boolean not null default false,
  add column if not exists course_key_original    text,
  add column if not exists course_detail_original text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'testimonials_course_key_valid' and conrelid = 'public.testimonials'::regclass) then
    alter table public.testimonials add constraint testimonials_course_key_valid
      check (course_key is null or course_key in ('masterclass', 'at_pratica', 'weekend_pass', 'imersao_crise', 'outro', 'varios'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'testimonials_course_key_original_valid' and conrelid = 'public.testimonials'::regclass) then
    alter table public.testimonials add constraint testimonials_course_key_original_valid
      check (course_key_original is null or course_key_original in ('masterclass', 'at_pratica', 'weekend_pass', 'imersao_crise', 'outro', 'varios'));
  end if;
  -- "outro" e "varios" exigem o texto complementar; as demais opções não têm texto complementar.
  if not exists (select 1 from pg_constraint where conname = 'testimonials_course_detail_rule' and conrelid = 'public.testimonials'::regclass) then
    alter table public.testimonials add constraint testimonials_course_detail_rule
      check (case when course_key in ('outro', 'varios')
                  then course_detail is not null and char_length(course_detail) between 2 and 200
                  else course_detail is null end);
  end if;
  -- A lista da opção "varios" só pode ser pública se a administração autorizar; nas demais opções não se aplica.
  if not exists (select 1 from pg_constraint where conname = 'testimonials_course_public_rule' and conrelid = 'public.testimonials'::regclass) then
    alter table public.testimonials add constraint testimonials_course_public_rule
      check (not course_detail_public or course_key = 'varios');
  end if;
  -- Depoimentos enviados com o texto novo (v2 em diante) SEMPRE têm curso/evento. Os antigos (v1) ficam como estão.
  if not exists (select 1 from pg_constraint where conname = 'testimonials_course_required_since_v2' and conrelid = 'public.testimonials'::regclass) then
    alter table public.testimonials add constraint testimonials_course_required_since_v2
      check (consent_version = 'v1-2026-10' or course_key is not null);
  end if;
end $$;

-- A administração pode corrigir a identificação do curso, mas nunca o que o participante informou originalmente.
grant update (course_key, course_detail, course_detail_public) on public.testimonials to authenticated;

-- Normalização e proteção (executa antes de gravar)
create or replace function public.testimonials_course_norm()
returns trigger
language plpgsql
as $$
begin
  if new.course_detail is not null then
    new.course_detail := nullif(btrim(regexp_replace(new.course_detail, '\s+', ' ', 'g')), '');
  end if;
  -- Opções que não têm texto complementar: descarta o que sobrou de uma escolha anterior.
  if new.course_key is null or new.course_key not in ('outro', 'varios') then
    new.course_detail := null;
  end if;
  if new.course_key is distinct from 'varios' then
    new.course_detail_public := false;
  end if;
  -- No envio, guarda exatamente o que o participante informou.
  if tg_op = 'INSERT' then
    new.course_key_original := new.course_key;
    new.course_detail_original := new.course_detail;
  else
    new.course_key_original := old.course_key_original;
    new.course_detail_original := old.course_detail_original;
  end if;
  return new;
end;
$$;

drop trigger if exists testimonials_course_norm_trg on public.testimonials;
create trigger testimonials_course_norm_trg
  before insert or update on public.testimonials
  for each row execute function public.testimonials_course_norm();

-- Histórico: registra correções do curso/evento (sem copiar o texto informado)
create or replace function public.log_testimonial_course_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email, details)
  values (new.id, 'course_edited', auth.uid(), nullif(auth.jwt() ->> 'email', ''),
          jsonb_build_object('from', old.course_key, 'to', new.course_key,
                             'detail_changed', new.course_detail is distinct from old.course_detail,
                             'detail_public', new.course_detail_public));
  return new;
end;
$$;

drop trigger if exists testimonials_course_log_trg on public.testimonials;
create trigger testimonials_course_log_trg
  after update on public.testimonials
  for each row
  when (old.course_key is distinct from new.course_key
        or old.course_detail is distinct from new.course_detail
        or old.course_detail_public is distinct from new.course_detail_public)
  execute function public.log_testimonial_course_change();
