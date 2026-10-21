-- Preserve existing connection IDs and encrypted GitHub tokens on upgrade.
alter table github_connections add column if not exists provider text not null default 'github';
alter table github_connections add column if not exists base_url text not null default 'https://github.com';
alter table github_connections add column if not exists ca_pem text;
