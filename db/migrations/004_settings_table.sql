-- Settings key-value store (replaces .env.local for runtime-configurable settings)

create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

insert into settings (key, value) values
  ('PRODUCTION_PATH', 'C:\web\production'),
  ('STAGING_PATH',    'C:\web\staging'),
  ('LOGS_PATH',       'C:\web\logs'),
  ('CADDY_PATH',      'C:\web'),
  ('GITHUB_TOKEN',    '')
on conflict (key) do nothing;
