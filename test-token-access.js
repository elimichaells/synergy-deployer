require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');

async function main() {
    const pool = new Pool({
        host: process.env.DATABASE_HOST,
        port: 5432,
        database: process.env.DATABASE_NAME,
        user: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD,
    });

    const r = await pool.query("SELECT value FROM settings WHERE key = 'GITHUB_TOKEN'");
    const token = r.rows[0]?.value;
    if (!token) { console.log('No token found'); process.exit(1); }

    const repos = [
        'elimichaells/trueid-website',
        'elimichaells/mrz-portal',
        'elimichaells/mrz-owner',
    ];

    for (const repo of repos) {
        console.log(`\n--- Testing: ${repo} ---`);
        const res = await fetch(`https://api.github.com/repos/${repo}`, {
            headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'test' },
        });
        console.log(`Status: ${res.status} ${res.statusText}`);
        const data = await res.json();
        if (data.permissions) {
            console.log('Permissions:', JSON.stringify(data.permissions));
        } else {
            console.log('Response:', data.message || JSON.stringify(data));
        }
    }

    // Also test git clone capability
    console.log(`\n--- Testing git ls-remote with token ---`);
    const testUrl = `https://${token}@github.com/elimichaells/trueid-website.git`;
    const { execSync } = require('child_process');
    try {
        const out = execSync(`git ls-remote --heads "${testUrl}"`, {
            timeout: 15000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'echo', GCM_PROVIDER: 'generic' },
        });
        console.log('SUCCESS! ls-remote output:');
        console.log(out.toString().substring(0, 200));
    } catch (err) {
        console.log('FAILED:', err.stderr?.toString() || err.message);
    }

    await pool.end();
}

main();
