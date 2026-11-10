alter table remote_storage_changes drop constraint if exists remote_storage_changes_kind_check;
alter table remote_storage_changes add constraint remote_storage_changes_kind_check check(kind in ('dedicated-user','move','migration'));
alter table remote_storage_changes add column if not exists app_id uuid;
alter table remote_storage_changes add column if not exists target_service_id uuid;
