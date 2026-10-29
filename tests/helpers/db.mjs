// Cria um Postgres em memória (PGlite) com um "shim" mínimo do Supabase e aplica as migrações REAIS do projeto,
// na ordem dos nomes dos arquivos (supabase/migrations/*.sql).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const DIR = new URL('../../supabase/migrations/', import.meta.url);
export const MIGRATION_FILES = readdirSync(fileURLToPath(DIR)).filter((f) => f.endsWith('.sql')).sort();
export const readMigration = (i) => readFileSync(new URL(MIGRATION_FILES[i], DIR), 'utf8');

/** Shim do Supabase (papéis, schemas auth/storage/extensions). */
export const SHIM_SQL = `
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
`;

/** `migrations`: quantas migrações aplicar (padrão: todas). Útil para simular o banco "antes" da atualização. */
export async function createDb({ adminId, otherIds = [], dataDir, migrations = MIGRATION_FILES.length } = {}) {
  const db = dataDir ? new PGlite(dataDir, { extensions: { pg_trgm } }) : new PGlite({ extensions: { pg_trgm } });
  await db.waitReady;
  if ((await db.query("select to_regclass('public.testimonials') as t")).rows[0].t) return db; // já migrado (reinício do servidor)
  await db.exec(SHIM_SQL);
  for (const id of [adminId, ...otherIds]) await db.query('insert into auth.users values ($1)', [id]);
  for (let i = 0; i < migrations; i++) await db.exec(readMigration(i));
  await db.query('insert into admin_users (user_id) values ($1)', [adminId]);
  return db;
}
