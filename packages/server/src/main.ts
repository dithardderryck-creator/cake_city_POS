import { startServer, lanAddresses } from './app';
import { ConfigError, loadConfig } from './config';
import { LockedError } from './lock';
import { createLogger, errorFields, pruneLogs } from './log';
import path from 'node:path';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Cannot start: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const logDir = path.join(config.dataDir, 'logs');
  pruneLogs(logDir, 30);
  const log = createLogger({ level: config.logLevel, dir: logDir });

  let server;
  try {
    server = await startServer({ config, log });
  } catch (err) {
    if (err instanceof LockedError) {
      console.error(`Cannot start: ${err.message}`);
      process.exit(3);
    }
    log.error('Could not start', errorFields(err));
    console.error(`Cannot start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const { staff } = await server.store.list<{ id: string }>('staff').then((s) => ({ staff: s.length }));
  const scheme = config.tls ? 'https' : 'http';
  const lines = [
    '',
    '  Cake POS server is running',
    `  On this computer:  ${scheme}://localhost:${server.port}`,
    ...lanAddresses().map((a) => `  On other devices:  ${scheme}://${a}:${server.port}`),
    `  Data folder:       ${config.dataDir}`,
    `  Backups:           ${config.backupDir}${config.cloudBackupDir ? `  (copied to ${config.cloudBackupDir})` : '  (no cloud folder set)'}`,
    '',
  ];
  if (staff === 0) lines.push('  No staff yet. Create the owner first:', '    npm run admin -- create-owner', '');
  console.log(lines.join('\n'));

  let stopping = false;
  const stop = async (why: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log.info('Stopping', { why });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await server.close();
    } finally {
      log.close();
      process.exit(code);
    }
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGBREAK', () => void stop('SIGBREAK')); // Ctrl+Break and window close on Windows
  // Anything unexpected: record it, shut down cleanly, and let the service manager restart us.
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', errorFields(err));
    void stop('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    log.error('Unhandled rejection', errorFields(err));
    void stop('unhandledRejection', 1);
  });
}

void main();
