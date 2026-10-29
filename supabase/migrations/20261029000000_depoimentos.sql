-- =====================================================================
--  Depoimentos de alunos - Masterclass "Do Comportamento à Aprendizagem"
--  Banco: PostgreSQL (Supabase). Execute este arquivo UMA vez no
--  SQL Editor do Supabase (ou via `supabase db push`).
--
--  Modelo de segurança:
--   * A tabela NÃO tem nenhuma política para o público (anon): ninguém
--     lê nem grava diretamente. O envio e a leitura pública passam pela
--     Edge Function `testimonials`, que valida tudo no servidor.
--   * Somente usuários listados em `admin_users` (e autenticados) leem,
--     editam e excluem. Isso é imposto pelo banco (RLS + GRANT por coluna),
--     não apenas pela interface.
--   * Fotos ficam em bucket PRIVADO; o público só as vê por URL assinada
--     (temporária), e apenas de depoimentos aprovados, publicados e com
--     autorização específica de uso da foto.
-- =====================================================================

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Administradores
-- ---------------------------------------------------------------------
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;
-- (sem policies: só o SQL Editor / service role insere administradores)

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Versões do texto de consentimento (auditoria / LGPD)
-- ---------------------------------------------------------------------
create table if not exists public.consent_texts (
  version              text primary key,
  own_experience_text  text not null,
  publication_text     text not null,
  photo_text           text not null,
  created_at           timestamptz not null default now()
);
alter table public.consent_texts enable row level security;
revoke all on public.consent_texts from anon, authenticated;
grant select on public.consent_texts to authenticated;
drop policy if exists consent_texts_admin_select on public.consent_texts;
create policy consent_texts_admin_select on public.consent_texts
  for select to authenticated using (public.is_admin());

-- IMPORTANTE: estes textos devem ser idênticos aos exibidos em
-- enviar-depoimento/index.html. Ao mudar o texto, crie uma NOVA versão
-- (nunca altere uma versão já usada) e atualize CONSENT_VERSION na
-- Edge Function e o atributo data-consent-version no formulário.
insert into public.consent_texts (version, own_experience_text, publication_text, photo_text) values (
  'v1-2026-10',
  'Declaro que este depoimento descreve a minha própria experiência como participante da Masterclass “Do Comportamento à Aprendizagem”.',
  'Autorizo que o meu depoimento seja analisado pela administração e, se aprovado, publicado neste site com a identificação pública que escolhi acima (nome, profissão ou área e turma, quando informados). Entendo que a publicação é opcional, que o envio não garante a publicação, que o texto poderá receber correções ortográficas e de digitação e que posso pedir a retirada a qualquer momento pelo e-mail psicoepedagoga@gmail.com.',
  'Autorizo o uso público da minha foto, enviada acima, junto ao meu depoimento neste site, caso ele seja aprovado e publicado. Esta autorização é separada da autorização do texto e pode ser retirada a qualquer momento pelo e-mail psicoepedagoga@gmail.com.'
) on conflict (version) do nothing;

-- ---------------------------------------------------------------------
-- 3. Depoimentos
-- ---------------------------------------------------------------------
create table if not exists public.testimonials (
  id                         uuid primary key default gen_random_uuid(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  -- Dados privados (nunca expostos publicamente)
  author_name                text not null check (char_length(author_name) between 2 and 120),
  author_contact             text check (author_contact is null or char_length(author_contact) <= 160),

  -- Identificação pública escolhida pelo participante
  display_choice             text not null check (display_choice in ('full', 'first', 'first_initial', 'custom')),
  display_name               text not null check (char_length(display_name) between 2 and 80),
  profession                 text check (profession is null or char_length(profession) <= 80),
  cohort                     text check (cohort is null or char_length(cohort) <= 80),

  -- Texto
  body                       text not null check (char_length(body) between 30 and 1200),
  original_body              text not null,          -- exatamente como enviado
  confirmed_body             text,                   -- última versão confirmada pelo autor (se houve)

  -- Foto (bucket privado)
  photo_path                 text,
  photo_consent              boolean not null default false,
  photo_consent_at           timestamptz,

  -- Consentimentos (com data e versão do texto)
  consent_own_experience     boolean not null check (consent_own_experience),
  consent_publication        boolean not null check (consent_publication),
  consent_version            text not null references public.consent_texts (version),
  consent_at                 timestamptz not null default now(),

  -- Moderação
  status                     text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  published                  boolean not null default false,
  published_at               timestamptz,
  featured_position          smallint check (featured_position between 1 and 5),
  needs_author_confirmation  boolean not null default false,
  author_confirmed_at        timestamptz,
  admin_note                 text check (admin_note is null or char_length(admin_note) <= 1000),
  reviewed_at                timestamptz,
  reviewed_by                uuid,

  constraint published_requires_approved check (not published or status = 'approved'),
  constraint featured_requires_published check (featured_position is null or published),
  constraint photo_requires_consent check (photo_path is null or photo_consent)
);

create unique index if not exists testimonials_featured_position_uidx
  on public.testimonials (featured_position) where featured_position is not null;
create index if not exists testimonials_status_idx on public.testimonials (status, published, created_at desc);

alter table public.testimonials enable row level security;

-- Nada para o público; administradores via RLS + permissões por coluna.
revoke all on public.testimonials from anon, authenticated;
grant select, delete on public.testimonials to authenticated;
grant update (display_name, profession, cohort, body, photo_path, photo_consent,
              status, published, needs_author_confirmation, admin_note)
  on public.testimonials to authenticated;

drop policy if exists testimonials_admin_select on public.testimonials;
create policy testimonials_admin_select on public.testimonials
  for select to authenticated using (public.is_admin());
drop policy if exists testimonials_admin_update on public.testimonials;
create policy testimonials_admin_update on public.testimonials
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists testimonials_admin_delete on public.testimonials;
create policy testimonials_admin_delete on public.testimonials
  for delete to authenticated using (public.is_admin());
-- (não há policy de INSERT: só a Edge Function, com service role, cria registros)

-- ---------------------------------------------------------------------
-- 4. Histórico de ações administrativas (sem copiar o conteúdo do texto)
-- ---------------------------------------------------------------------
create table if not exists public.testimonial_history (
  id              bigint generated always as identity primary key,
  testimonial_id  uuid not null,            -- sem FK: o histórico sobrevive à exclusão (sem dados pessoais)
  action          text not null,
  actor_id        uuid,
  actor_email     text,
  details         jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists testimonial_history_tid_idx on public.testimonial_history (testimonial_id, created_at desc);
alter table public.testimonial_history enable row level security;
revoke all on public.testimonial_history from anon, authenticated;
grant select on public.testimonial_history to authenticated;
drop policy if exists testimonial_history_admin_select on public.testimonial_history;
create policy testimonial_history_admin_select on public.testimonial_history
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- 5. Regras de integridade (executadas pelo banco, não pela interface)
-- ---------------------------------------------------------------------
create or replace function public.testimonials_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_reference text;
  v_body_reset boolean := false;
begin
  new.updated_at := now();

  -- A autorização de uso da foto só pode ser retirada, nunca concedida pela administração.
  if not old.photo_consent and new.photo_consent then
    raise exception 'A autorização de uso da foto só pode ser concedida pelo participante.' using errcode = '42501';
  end if;
  if old.photo_consent and not new.photo_consent and new.photo_path is not null then
    raise exception 'Remova a foto antes de revogar a autorização de uso de imagem.' using errcode = '23514';
  end if;

  -- Edição do texto: se fugir de uma simples correção, exige confirmação do autor.
  if new.body is distinct from old.body then
    v_reference := coalesce(new.confirmed_body, new.original_body);
    if new.body = v_reference then
      new.needs_author_confirmation := false;
      v_body_reset := true;
    elsif similarity(lower(v_reference), lower(new.body)) < 0.70
       or abs(char_length(new.body) - char_length(v_reference))::numeric
            / greatest(char_length(v_reference), 1) > 0.25 then
      new.needs_author_confirmation := true;
      new.author_confirmed_at := null;
    end if;
  end if;

  -- A pendência só é resolvida registrando a confirmação do autor (RPC) ou restaurando o texto.
  if old.needs_author_confirmation and not new.needs_author_confirmation
     and not v_body_reset
     and coalesce(current_setting('app.author_confirmed', true), '') <> '1' then
    raise exception 'Use "Registrar confirmação do autor" para liberar este depoimento.' using errcode = '42501';
  end if;

  if new.status <> 'approved' then
    new.published := false;
  end if;

  if new.needs_author_confirmation then
    if new.published and not old.published then
      raise exception 'Este depoimento foi alterado além de correções textuais: obtenha a confirmação do autor antes de publicar.' using errcode = '23514';
    end if;
    new.published := false;   -- retira da exibição enquanto pendente de confirmação
  end if;

  if not new.published then
    new.featured_position := null;
  end if;
  if new.published and not old.published then
    new.published_at := now();
  end if;

  if new.status is distinct from old.status then
    new.reviewed_at := now();
    new.reviewed_by := auth.uid();
  end if;

  if new.photo_consent and new.photo_consent_at is null then
    new.photo_consent_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists testimonials_guard_trg on public.testimonials;
create trigger testimonials_guard_trg
  before update on public.testimonials
  for each row execute function public.testimonials_guard();

-- Histórico (security definer: quem edita não precisa de permissão de escrita no histórico)
create or replace function public.log_testimonial_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := nullif(auth.jwt() ->> 'email', '');
  v_uid   uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email, details)
    values (new.id, 'received', v_uid, v_email,
            jsonb_build_object('has_photo', new.photo_path is not null, 'consent_version', new.consent_version));
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email)
    values (old.id, 'deleted', v_uid, v_email);
    return old;
  end if;

  if new.status is distinct from old.status then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email, details)
    values (new.id, case new.status when 'approved' then 'approved' when 'rejected' then 'rejected' else 'returned_to_pending' end,
            v_uid, v_email, jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if new.published is distinct from old.published then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email)
    values (new.id, case when new.published then 'published' else 'unpublished' end, v_uid, v_email);
  end if;
  if new.featured_position is distinct from old.featured_position then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email, details)
    values (new.id, case when new.featured_position is null then 'unfeatured' else 'featured' end, v_uid, v_email,
            jsonb_build_object('position', new.featured_position));
  end if;
  if new.body is distinct from old.body then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email, details)
    values (new.id, 'body_edited', v_uid, v_email,
            jsonb_build_object('substantial', new.needs_author_confirmation));
  end if;
  if new.display_name is distinct from old.display_name
     or new.profession is distinct from old.profession
     or new.cohort is distinct from old.cohort then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email, details)
    values (new.id, 'identification_edited', v_uid, v_email,
            jsonb_build_object('fields', to_jsonb(array_remove(array[
              case when new.display_name is distinct from old.display_name then 'display_name' end,
              case when new.profession  is distinct from old.profession  then 'profession' end,
              case when new.cohort      is distinct from old.cohort      then 'cohort' end], null))));
  end if;
  if new.photo_path is distinct from old.photo_path then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email)
    values (new.id, case when new.photo_path is null then 'photo_removed' else 'photo_replaced' end, v_uid, v_email);
  end if;
  if old.photo_consent and not new.photo_consent then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email)
    values (new.id, 'photo_consent_revoked', v_uid, v_email);
  end if;
  if new.needs_author_confirmation is distinct from old.needs_author_confirmation then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email)
    values (new.id, case when new.needs_author_confirmation then 'author_confirmation_required' else 'author_confirmed' end, v_uid, v_email);
  end if;
  if new.admin_note is distinct from old.admin_note then
    insert into public.testimonial_history (testimonial_id, action, actor_id, actor_email)
    values (new.id, 'note_edited', v_uid, v_email);
  end if;
  return new;
end;
$$;

drop trigger if exists testimonials_log_trg on public.testimonials;
create trigger testimonials_log_trg
  after insert or update or delete on public.testimonials
  for each row execute function public.log_testimonial_change();

-- ---------------------------------------------------------------------
-- 6. Operações administrativas atômicas (RPC)
-- ---------------------------------------------------------------------

-- Define, em uma única operação, quais depoimentos são destaque e em que ordem (máx. 5).
create or replace function public.set_featured_testimonials(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  if coalesce(array_length(p_ids, 1), 0) > 5 then
    raise exception 'No máximo 5 depoimentos em destaque.' using errcode = '23514';
  end if;
  if (select count(distinct x) from unnest(p_ids) as x) <> coalesce(array_length(p_ids, 1), 0) then
    raise exception 'Depoimento repetido na lista de destaques.' using errcode = '23514';
  end if;
  if exists (
    select 1 from unnest(p_ids) as x
    left join public.testimonials t on t.id = x
    where t.id is null or not t.published or t.status <> 'approved'
  ) then
    raise exception 'Só é possível destacar depoimentos aprovados e publicados.' using errcode = '23514';
  end if;

  update public.testimonials set featured_position = null where featured_position is not null;
  update public.testimonials t
     set featured_position = o.pos
    from unnest(p_ids) with ordinality as o(tid, pos)
   where t.id = o.tid;
end;
$$;
revoke all on function public.set_featured_testimonials(uuid[]) from public, anon;
grant execute on function public.set_featured_testimonials(uuid[]) to authenticated;

-- Registra que o autor confirmou uma alteração que ia além de correção textual.
create or replace function public.confirm_author_change(p_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  perform set_config('app.author_confirmed', '1', true);
  update public.testimonials
     set needs_author_confirmation = false,
         author_confirmed_at = now(),
         confirmed_body = body,
         admin_note = left(coalesce(nullif(trim(p_note), ''), admin_note, ''), 1000)
   where id = p_id and needs_author_confirmation;
  perform set_config('app.author_confirmed', '', true);
  if not found then
    raise exception 'Este depoimento não está aguardando confirmação do autor.' using errcode = '23514';
  end if;
end;
$$;
revoke all on function public.confirm_author_change(uuid, text) from public, anon;
grant execute on function public.confirm_author_change(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Limite de envios (antiabuso) - usado só pela Edge Function
-- ---------------------------------------------------------------------
create table if not exists public.submission_attempts (
  id          bigint generated always as identity primary key,
  ip_hash     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists submission_attempts_idx on public.submission_attempts (ip_hash, created_at desc);
alter table public.submission_attempts enable row level security;
revoke all on public.submission_attempts from anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. Armazenamento de fotos (bucket PRIVADO)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('testimonial-photos', 'testimonial-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- Só administradores acessam diretamente o bucket (o público usa URLs assinadas
-- geradas pela Edge Function, apenas para depoimentos publicados).
drop policy if exists "testimonial photos admin select" on storage.objects;
create policy "testimonial photos admin select" on storage.objects
  for select to authenticated using (bucket_id = 'testimonial-photos' and public.is_admin());
drop policy if exists "testimonial photos admin insert" on storage.objects;
create policy "testimonial photos admin insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'testimonial-photos' and public.is_admin());
drop policy if exists "testimonial photos admin update" on storage.objects;
create policy "testimonial photos admin update" on storage.objects
  for update to authenticated using (bucket_id = 'testimonial-photos' and public.is_admin())
  with check (bucket_id = 'testimonial-photos' and public.is_admin());
drop policy if exists "testimonial photos admin delete" on storage.objects;
create policy "testimonial photos admin delete" on storage.objects
  for delete to authenticated using (bucket_id = 'testimonial-photos' and public.is_admin());
