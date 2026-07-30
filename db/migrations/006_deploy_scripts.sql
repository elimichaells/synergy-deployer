-- Custom deployment hook scripts per project:
--   pre_deploy_cmd  runs after dependency install, before the build (e.g. prisma migrate deploy, codegen)
--   post_deploy_cmd runs after the app restarted and passed the health check (e.g. cache warmup, notifications)
alter table projects add column if not exists pre_deploy_cmd text;
alter table projects add column if not exists post_deploy_cmd text;
