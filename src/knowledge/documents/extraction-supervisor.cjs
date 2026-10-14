// Trusted coordinator only: untrusted parsing runs in a separate process.
// Its timers/IPC remain responsive even when the extractor blocks synchronously.
const { fork, execFile } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const parentPid = Number(process.env.ODINLINK_DOCUMENT_PARENT_PID);
const deadline = Number(process.env.ODINLINK_DOCUMENT_DEADLINE);
let extractor;
let result;
let stopping = false;
let probing = false;
function publish() {
  clearInterval(monitor); clearTimeout(timer);
  if (process.connected) process.send(result || { error: 'document_parse' }, () => process.exit(0));
  else process.exit(0);
}
function stop(code) {
  if (stopping) return;
  stopping = true; result = { error: code };
  if (extractor) extractor.kill('SIGKILL');
  else publish();
}
const timer = setTimeout(() => stop('document_timeout'), Math.max(0, deadline - Date.now()));
const monitor = setInterval(async () => {
  if (process.ppid !== parentPid) { stop('document_unavailable'); return; }
  if (!extractor?.pid || stopping || probing) return;
  probing = true;
  try {
    let rss;
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${extractor.pid}/status`, 'utf8');
      rss = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0);
    } else if (process.platform === 'darwin') {
      rss = await new Promise(resolve => execFile('/bin/ps', ['-o', 'rss=', '-p', String(extractor.pid)], { timeout: 1000 }, (error, stdout) => resolve(error ? NaN : Number(stdout.trim()))));
    } else { stop('document_unavailable'); return; }
    if (!Number.isFinite(rss) || rss <= 0) stop('document_unavailable');
    else if (rss > 512 * 1024) stop('document_memory');
  } catch { stop('document_unavailable'); }
  finally { probing = false; }
}, 100);
process.once('disconnect', () => stop('document_unavailable'));
process.on('message', job => {
  if (job.stop) { stop(job.stop); return; }
  if (extractor || stopping) return;
  if (!Number.isSafeInteger(parentPid) || process.ppid !== parentPid || !Number.isFinite(deadline) || Date.now() >= deadline) {
    stop('document_unavailable'); return;
  }
  extractor = fork(job.path, [], {
    execArgv: ['--max-heap-size=256', ...(job.path.endsWith('.ts') ? ['--import', 'tsx'] : [])],
    env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  extractor.once('error', () => stop('document_unavailable'));
  extractor.once('message', message => {
    if (stopping) return;
    result = message; stopping = true;
    extractor.kill('SIGKILL');
  });
  // close follows exit and closed IPC; never publish while extraction still runs.
  extractor.once('close', () => {
    if (!result) result = { error: Date.now() >= deadline ? 'document_timeout' : 'document_memory' };
    publish();
  });
  process.send({ started: extractor.pid }, error => {
    if (error || !process.connected) { stop('document_unavailable'); return; }
    extractor.send({ bytes: job.bytes, filename: job.filename, mime: job.mime }, error => {
      if (error) stop('document_unavailable');
    });
  });
});
