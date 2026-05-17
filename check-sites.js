const { Pool } = require('pg');

const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'server_manager',
    user: 'postgres',
    password: 'trueidpgsl2026',
});

async function run() {
    try {
        const res = await pool.query('SELECT id, name, pm2_name, is_active FROM projects');
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

run();
