const fs = require('node:fs/promises');
const path = require('node:path');
const { recordHistory } = require('./health-history.cjs');
const { recordUptime, validateUptime } = require('./uptime-history.cjs');

async function atomicJson(file, value) {
  const temporary = file + '.' + process.pid + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify(value)); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}
async function updateHistory(config, previous, sample) {
  const file = config.historyFile || path.join(path.dirname(config.stateFile), 'history.json');
  let history;
  try { history = JSON.parse(await fs.readFile(file, 'utf8')); if (history.version !== 1 || !Array.isArray(history.buckets)) throw new Error('Invalid health history'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error; // Preserve damaged history for recovery.
    for (const point of [...(previous?.history || [])].sort((a, b) => a.at - b.at)) history = recordHistory(history, point);
  }
  history = recordHistory(history, sample);
  await atomicJson(file, history);
}
async function acquireMonitorLock(stateFile) {
  const file = stateFile + '.lock';
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { const handle = await fs.open(file, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() })); return async () => { await handle.close(); await fs.unlink(file).catch(() => {}); }; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const lock = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Date.now() - lock.at <= 120_000 || !Number.isInteger(lock.pid) || lock.pid <= 0) return null;
      try { process.kill(lock.pid, 0); return null; } catch (probe) { if (probe.code !== 'ESRCH') return null; }
      await fs.unlink(file); return acquireMonitorLock(stateFile);
    } catch { return null; }
  }
}
async function updateUptime(config, sample) {
  const file = config.uptimeFile || path.join(path.dirname(config.stateFile), 'uptime.json');
  let previous;
  try { previous = validateUptime(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomicJson(file, recordUptime(previous, sample));
}
module.exports = { atomicJson, updateHistory, updateUptime, acquireMonitorLock };
