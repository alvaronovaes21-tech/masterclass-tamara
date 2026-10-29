// Cria um Postgres em memória (PGlite) com um "shim" mínimo do Supabase e aplica a migração REAL do projeto.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

export const MIGRATION = new URL('../../supabase/migrations/20261029000000_depoimentos.sql', import.meta.url);

export async function createDb({ adminId, otherIds = [], dataDir } = {}) {
  const db = dataDir ? new PGlite(dataDir, { extensions: { pg_trgm } }) : new PGlite({ extensions: { pg_trgm } });
  await db.waitReady;
  if ((await db.query("select to_regclass('public.testimonials') as t")).rows[0].t) return db; // já migrado (reinício do servidor)
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema extensions; create schema storage;
    create table auth.users (id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema auth, extensions, storage, public to anon, authenticated, service_role;
    grant all on all tables in schema public, storage to anon, authenticated, service_role;
    grant execute on all functions in schema auth, extensions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `);
  for (const id of [adminId, ...otherIds]) await db.query('insert into auth.users values ($1)', [id]);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.query('insert into admin_users (user_id) values ($1)', [adminId]);
  return db;
}
