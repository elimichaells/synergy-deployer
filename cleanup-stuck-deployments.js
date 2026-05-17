const { Client } = require('pg');

const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'server_manager',
  user: 'postgres',
  password: 'trueidpgsl2026',
});

const TIMEOUT_MINUTES = 30;

async function cleanupStuckDeployments() {
  try {
    await client.connect();
    console.log('Connected to database\n');

    // Find all stuck deployments (running for more than TIMEOUT_MINUTES)
    const findQuery = `
      SELECT d.id, d.started_at, p.name as project_name, p.environment,
             EXTRACT(EPOCH FROM (NOW() - d.started_at)) / 60 as elapsed_minutes
      FROM deployments d
      JOIN projects p ON d.project_id = p.id
      WHERE d.status = 'running'
        AND d.started_at IS NOT NULL
        AND d.started_at < NOW() - INTERVAL '${TIMEOUT_MINUTES} minutes'
      ORDER BY d.started_at ASC
    `;

    const result = await client.query(findQuery);

    if (result.rows.length === 0) {
      console.log('✓ No stuck deployments found.');
      return;
    }

    console.log(`Found ${result.rows.length} stuck deployment(s):\n`);

    for (const row of result.rows) {
      const elapsedMinutes = Math.floor(row.elapsed_minutes);
      console.log(`  - ID: ${row.id}`);
      console.log(`    Project: ${row.project_name} (${row.environment})`);
      console.log(`    Started: ${row.started_at}`);
      console.log(`    Elapsed: ${elapsedMinutes} minutes\n`);
    }

    // Update all stuck deployments to failed status
    const updateQuery = `
      UPDATE deployments
      SET 
        status = 'failed',
        finished_at = NOW(),
        log = COALESCE(log || $1, $1)
      WHERE id = ANY($2)
    `;

    const deploymentIds = result.rows.map(row => row.id);
    const logMessage = `\n[cleanup] Deployment exceeded ${TIMEOUT_MINUTES} minute timeout. Auto-failed by cleanup script to allow new deployments.`;

    await client.query(updateQuery, [logMessage, deploymentIds]);

    console.log(`✓ Successfully cleaned up ${result.rows.length} stuck deployment(s).`);
    console.log('\nYou can now deploy to these projects without issues.');

  } catch (err) {
    console.error('Error cleaning up stuck deployments:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

cleanupStuckDeployments();
