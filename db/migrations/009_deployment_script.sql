alter table projects
  add column if not exists deploy_script text;
