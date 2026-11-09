create table if not exists remote_application_groups (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references managed_servers(id) on delete cascade,
  name text not null,
  unique(id,server_id)
);
alter table remote_apps add column if not exists application_group_id uuid;
alter table remote_apps add column if not exists component_role text not null default 'application' check(component_role in ('application','frontend','backend','service'));
do $$ begin
  alter table remote_apps add constraint remote_apps_group_server_fk foreign key(application_group_id,server_id) references remote_application_groups(id,server_id);
exception when duplicate_object then null; end $$;
insert into remote_application_groups(id,server_id,name)
  select distinct on (coalesce(a.production_id,a.id)) coalesce(a.production_id,a.id),a.server_id,coalesce(p.name,a.name)
  from remote_apps a left join remote_apps p on p.id=a.production_id and p.server_id=a.server_id
  where a.application_group_id is null order by coalesce(a.production_id,a.id),a.created_at
  on conflict(id) do nothing;
update remote_apps set application_group_id=coalesce(production_id,id) where application_group_id is null;
create or replace function manager_remote_app_group() returns trigger language plpgsql as $$
begin
  if new.application_group_id is null then
    if new.production_id is not null then
      select application_group_id into new.application_group_id from remote_apps where id=new.production_id and server_id=new.server_id;
      if new.application_group_id is null then raise exception 'Production application must belong to the same server'; end if;
    else
      new.application_group_id:=new.id;
      insert into remote_application_groups(id,server_id,name) values(new.id,new.server_id,new.name);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists manager_remote_app_group on remote_apps;
create trigger manager_remote_app_group before insert on remote_apps for each row execute function manager_remote_app_group();
