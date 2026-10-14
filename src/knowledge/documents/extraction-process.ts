import { fork, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DOCUMENT_LIMITS as L, DocumentError, type ExtractedSection } from './formats';

export function extractInProcess(bytes: Buffer, filename: string, mime: string): Promise<ExtractedSection[]> {
  const built = resolve('dist/knowledge-extractor.cjs');
  const development = resolve('src/knowledge/documents/extraction-child.ts');
  const production = process.env.NODE_ENV === 'production';
  if (production && !existsSync(built)) return Promise.reject(new DocumentError('document_unavailable', 503));
  return runExtractionChild(production ? built : development, bytes, filename, mime);
}

async function isRunning(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      return !/^State:\s+[ZX]/mu.test(status);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return new Promise((resolveRunning, reject) => execFile('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { timeout: 1000 }, (error, stdout) => {
    if (error && (error as { code?: string | number }).code !== 1) reject(error);
    else resolveRunning(!!stdout.trim() && !stdout.trim().startsWith('Z'));
  }));
}

// Internal harness permits synthetic fixtures; HTTP never supplies a child path.
export function runExtractionChild(path: string, bytes: Buffer, filename: string, mime: string, timeoutMs: number = L.timeoutMs): Promise<ExtractedSection[]> {
  const supervisorPath = resolve(process.env.NODE_ENV === 'production' ? 'dist/knowledge-extraction-supervisor.cjs' : 'src/knowledge/documents/extraction-supervisor.cjs');
  if (!['linux', 'darwin'].includes(process.platform) || !existsSync(supervisorPath)) return Promise.reject(new DocumentError('document_unavailable', 503));
  const lifetime = Math.min(L.timeoutMs, Math.max(1, timeoutMs));
  const deadline = Date.now() + lifetime;
  return new Promise((resolveResult, reject) => {
    // Separate heap budget for the small coordinator; the extractor retains 256 MiB.
    const supervisor = fork(supervisorPath, [], {
      execArgv: ['--max-heap-size=64'],
      env: { PATH: process.env.PATH, NODE_ENV: 'production', ODINLINK_DOCUMENT_PARENT_PID: String(process.pid), ODINLINK_DOCUMENT_DEADLINE: String(deadline) },
      serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let extractorPid: number | undefined;
    let sections: ExtractedSection[] | undefined;
    let error: DocumentError | undefined;
    let stopping = false;
    let exitConfirmed = false;
    let forcedStop: ReturnType<typeof setTimeout> | undefined;
    const stop = (failure: DocumentError) => {
      if (stopping) return; stopping = true; error = failure;
      // Backup if the coordinator itself fails; ordinary cleanup is owned by it.
      if (extractorPid && !exitConfirmed) { try { process.kill(extractorPid, 'SIGKILL'); } catch {} }
      if (supervisor.connected) supervisor.send({ stop: failure.code }, () => {});
      forcedStop = setTimeout(() => supervisor.kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => stop(new DocumentError('document_timeout')), lifetime);
    supervisor.once('error', () => stop(new DocumentError('document_unavailable', 503)));
    supervisor.on('message', (message: { started?: number; sections?: ExtractedSection[]; error?: string }) => {
      if (message.started) { extractorPid = message.started; if (stopping) { try { process.kill(extractorPid, 'SIGKILL'); } catch {} } return; }
      exitConfirmed = true; // Supervisor emits results only after extractor close.
      if (stopping) return;
      if (message.error) error = new DocumentError(message.error);
      else if (!Array.isArray(message.sections) || JSON.stringify(message.sections).length > L.chars * 7) error = new DocumentError('document_limits');
      else sections = message.sections;
    });
    supervisor.once('close', async () => {
      clearTimeout(timer); clearTimeout(forcedStop);
      // Unexpected supervisor loss: do not release the slot until the extractor
      // is confirmed stopped. Its eventual orphan reaping belongs to the OS.
      if (extractorPid && !exitConfirmed) {
        try {
          if (await isRunning(extractorPid)) {
            error = new DocumentError('document_unavailable', 503);
            process.kill(extractorPid, 'SIGKILL');
            while (await isRunning(extractorPid)) await new Promise(resolveWait => setTimeout(resolveWait, 25));
          }
        } catch {
          // No exit confirmation means fail closed: keep the extraction slot held.
          return;
        }
      }
      if (error) reject(error);
      else if (sections) resolveResult(sections);
      else reject(new DocumentError('document_memory'));
    });
    supervisor.send({ path, bytes: bytes.toString('base64'), filename, mime }, failure => {
      if (failure) stop(new DocumentError('document_unavailable', 503));
    });
  });
}
