import { query } from '@/lib/db';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
    console.log('--- Checking Git Setup ---');

    try {
        // 1. Check GITHUB_TOKEN
        const { rows: settings } = await query("SELECT value FROM settings WHERE key = 'GITHUB_TOKEN'");
        const token = settings[0]?.value;

        if (token) {
            console.log('✅ GITHUB_TOKEN is set in database.');
            // Check if it looks like a valid token (basic check)
            if (token.startsWith('ghp_') || token.startsWith('github_pat_')) {
                console.log('   Token format looks correct.');
            } else {
                console.log('   WARNING: Token format does not look like a standard GitHub token (ghp_... or github_pat_...).');
            }
        } else {
            console.log('❌ GITHUB_TOKEN is NOT set in database.');
        }

        // 2. Check Projects
        console.log('\n--- Projects ---');
        const { rows: projects } = await query("SELECT id, name, repo_url, default_branch FROM projects");

        if (projects.length === 0) {
            console.log('No projects found.');
        } else {
            for (const p of projects) {
                console.log(`Project: ${p.name} (${p.id})`);
                console.log(`  Repo: ${p.repo_url}`);
                console.log(`  Branch: ${p.default_branch}`);

                if (p.repo_url && p.repo_url.startsWith('https://github.com/')) {
                    console.log('  Type: GitHub HTTPS (Token injection supported)');
                } else if (p.repo_url && p.repo_url.startsWith('git@')) {
                    console.log('  Type: SSH (Requires SSH keys on server)');
                } else {
                    console.log('  Type: Other/Unknown (Token injection might be skipped)');
                }
                console.log('');
            }
        }

    } catch (err) {
        console.error('Error checking setup:', err);
    }

    // Force exit because db pool keeps process alive
    process.exit(0);
}

main();
