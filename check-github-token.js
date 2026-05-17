// Simple Node.js script to check GITHUB_TOKEN in database
require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');

async function main() {
    const pool = new Pool({
        host: process.env.DATABASE_HOST || 'localhost',
        port: parseInt(process.env.DATABASE_PORT || '5432', 10),
        database: process.env.DATABASE_NAME || 'server_manager',
        user: process.env.DATABASE_USER || 'postgres',
        password: process.env.DATABASE_PASSWORD,
    });

    try {
        console.log('Checking GITHUB_TOKEN in database...\n');

        const result = await pool.query("SELECT key, value FROM settings WHERE key = 'GITHUB_TOKEN'");

        if (result.rows.length === 0) {
            console.log('❌ GITHUB_TOKEN is NOT set in the database.');
            console.log('\nTo fix this:');
            console.log('1. Go to https://github.com/settings/tokens');
            console.log('2. Generate a new token with "repo" scope');
            console.log('3. Add it in your manager app Settings page');
        } else {
            const token = result.rows[0].value;
            console.log('✅ GITHUB_TOKEN is set in database.');
            console.log(`   Length: ${token.length} characters`);
            console.log(`   Starts with: ${token.substring(0, 10)}...`);

            // Check token format
            if (token.startsWith('ghp_') || token.startsWith('github_pat_')) {
                console.log('   Format: ✅ Looks like a valid GitHub token format');
            } else {
                console.log('   Format: ⚠️  Does not match standard GitHub token format');
                console.log('   Expected to start with "ghp_" or "github_pat_"');
            }

            // Test token validity with GitHub API
            console.log('\nTesting token with GitHub API...');
            try {
                const response = await fetch('https://api.github.com/user', {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'User-Agent': 'DeployManager'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    console.log(`✅ Token is VALID! Authenticated as: ${data.login}`);
                } else {
                    console.log(`❌ Token is INVALID! GitHub API returned: ${response.status} ${response.statusText}`);
                    if (response.status === 401) {
                        console.log('   The token has likely expired or been revoked.');
                        console.log('   Please generate a new token.');
                    }
                }
            } catch (err) {
                console.log(`⚠️  Could not test token: ${err.message}`);
            }
        }

        // Check projects
        console.log('\n--- Checking Projects ---');
        const projects = await pool.query("SELECT id, name, repo_url FROM projects LIMIT 5");
        if (projects.rows.length === 0) {
            console.log('No projects found.');
        } else {
            for (const p of projects.rows) {
                console.log(`\nProject: ${p.name}`);
                console.log(`  Repo: ${p.repo_url}`);
                if (p.repo_url && p.repo_url.startsWith('https://github.com/')) {
                    console.log('  Type: HTTPS (requires token)');
                } else if (p.repo_url && p.repo_url.startsWith('git@')) {
                    console.log('  Type: SSH (requires SSH keys)');
                }
            }
        }

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await pool.end();
    }
}

main();
