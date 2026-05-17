
const si = require('systeminformation');
const { execSync } = require('child_process');

async function check() {
    try {
        const list = JSON.parse(execSync('pm2 jlist').toString());
        const manager = list.find(p => p.name === 'manager');
        if (!manager) {
            console.log('Manager process not found');
            return;
        }
        console.log('PM2 PID:', manager.pid);

        console.log('Getting system processes...');
        const data = await si.processes();
        const proc = data.list.find(p => p.pid === manager.pid);

        if (proc) {
            console.log('SI Process Found:', JSON.stringify(proc, null, 2));
        } else {
            console.log('SI Process NOT found for PID', manager.pid);
            // List a few processes to see what we have
            console.log('First 5 processes:', data.list.slice(0, 5));
        }
    } catch (e) {
        console.error(e);
    }
}

check();
