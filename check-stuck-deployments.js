const { Client } = require('pg');

const client = new Client({
    host: 'localhost',
    port: 5432,
    database: 'server_manager',
    user: 'postgres',
    password: 'trueidpgsl2026',
});

async function checkStuckDeployments() {
    try {
        await client.connect();
        console.log('Connected to database');

        const res = await client.query(`
      SELECT d.id, d.status, d.started_at, p.name as project_name, p.environment
      FROM deployments d
      JOIN projects p ON d.project_id = p.id
      WHERE d.status = 'running'
    `);

        if (res.rows.length === 0) {
            console.log('No stuck deployments found.');
        } else {
            console.log('Found stuck deployments:');
            res.rows.forEach(row => {
                console.log(`- ID: ${row.id}, Project: ${row.project_name} (${row.environment}), Started: ${row.started_at}`);
            });
        }
    } catch (err) {
        console.error('Error querying database:', err);
    } finally {
        await client.end();
    }
}

checkStuckDeployments();
