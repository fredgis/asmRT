// +--------------------------------------------------------------------+
// | asmRT :: controller-lock.mjs -- controller lifetime ownership        |
// +--------------------------------------------------------------------+
// Rust holds an OS file lock, not an asmDB writer. Parent pipe closure or
// helper termination releases it without stale-PID recovery or unlink races.
import { spawn } from 'node:child_process';

export async function acquireControllerLock(binary, asmdbDir, dataRoot, onLost) {
  const child = spawn(binary, ['--asmdb-dir', asmdbDir, '--data-dir', dataRoot, 'controller-lock'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stopping = false;
  let acquired = false;
  let diagnostic = '';
  let output = '';
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise(resolve => {
    child.once('close', () => {
      clearTimeout(timer);
      const error = new Error(diagnostic.trim() || 'Controller ownership helper exited.');
      rejectReady(error);
      resolve();
      if (acquired && !stopping) onLost(error);
    });
  });
  const fail = error => {
    rejectReady(error);
    child.kill();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.length > 1024) return fail(new Error('Invalid controller lock acknowledgement.'));
    if (!output.includes('\n')) return;
    try {
      const event = JSON.parse(output.trim());
      if (acquired || event.event !== 'controller_lock_acquired'
          || !/^\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\)$/.test(event.version)) {
        throw new Error('Rebuild asmRT: invalid controller lock/version acknowledgement.');
      }
      acquired = true;
      clearTimeout(timer);
      resolveReady(event.version);
    } catch (error) { fail(error); }
  });
  const timer = setTimeout(() => fail(new Error('Controller lock acquisition timed out.')), 5000);
  try {
    const version = await ready;
    return {
      version,
      async close() {
        stopping = true;
        child.stdin.end();
        const timeout = setTimeout(() => child.kill(), 5000);
        try { await closed; } finally { clearTimeout(timeout); }
      },
    };
  } catch (error) {
    stopping = true;
    child.kill();
    await closed;
    throw error;
  }
}
