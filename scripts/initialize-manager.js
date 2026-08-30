const fs = require('fs')
const path = require('path')
const bcrypt = require('bcrypt')
const { Client } = require('pg')
const { registerApplicationPostgres } = require('./register-application-postgres')

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const client = new Client({
    host: required('DATABASE_HOST'),
    port: Number(process.env.DATABASE_PORT || 5432),
    database: required('DATABASE_NAME'),
    user: required('DATABASE_USER'),
    password: required('DATABASE_PASSWORD'),
  })
  await client.connect()
  try {
    await client.query(fs.readFileSync(path.join(process.cwd(), 'db', 'schema.sql'), 'utf8'))
    const passwordHash = await bcrypt.hash(required('ADMIN_PASSWORD'), 12)
    await client.query(
      `insert into users (email,name,password_hash,role,status)
       values ($1,$2,$3,'admin','active')
       on conflict (email) do update set name=excluded.name,password_hash=excluded.password_hash,role='admin',status='active'`,
      [required('ADMIN_EMAIL'), process.env.ADMIN_NAME || 'Administrator', passwordHash]
    )
    await registerApplicationPostgres(client)
  } finally { await client.end() }
}

main().catch((error) => { console.error(error); process.exit(1) })
