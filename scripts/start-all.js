import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const children = new Set();
let stopping = false;

function stopOthers(except) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child !== except && child.exitCode === null) child.kill();
}

function start(name, command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  children.add(child);
  child.on('error', error => {
    if (error.code === 'ENOENT' && name === 'Dota worker') {
      console.error('Go was not found. Install Go 1.26+ and restart this terminal so go is on PATH.');
    } else {
      console.error(`${name} could not start:`, error);
    }
    process.exitCode = 1;
    if (name === 'Discord bot') stopOthers(child);
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    process.exitCode = signal ? 1 : (code ?? 1);
    if (name === 'Discord bot') stopOthers(child);
    else if (!stopping) console.log('Dota worker stopped; Discord bot remains online. Run npm run start:dota to restart it.');
  });
  return child;
}

function databaseReady() {
  let db;
  try {
    db = new DatabaseSync(process.env.DB_PATH || './inhouses.db', { readOnly: true });
    db.prepare('SELECT 1 FROM matches LIMIT 1').get();
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

const discord = start('Discord bot', process.execPath, ['--experimental-sqlite', 'discord/main.js']);
while (!stopping && !databaseReady()) await new Promise(resolve => setTimeout(resolve, 200));
if (!stopping) start('Dota worker', process.platform === 'win32' ? 'go.exe' : 'go', ['run', './dota']);
