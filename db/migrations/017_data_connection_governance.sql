alter table data_connections add column if not exists purpose text not null default 'shared_application';
alter table data_connections add column if not exists managed boolean not null default false;
alter table data_connections add column if not exists is_default boolean not null default false;
alter table data_connections add column if not exists provisioning_enabled boolean not null default true;

create unique index if not exists data_connections_default_provider_idx
  on data_connections (provider)
  where is_default = true;
