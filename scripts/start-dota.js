import { spawn } from 'node:child_process';

const command = process.platform === 'win32' ? 'go.exe' : 'go';
const worker = spawn(command, ['run', './dota'], { stdio: 'inherit' });

worker.on('error', error => {
  if (error.code === 'ENOENT') console.error('Go was not found. Install Go 1.26+ and restart this terminal so go is on PATH.');
  else console.error('Could not start the Dota worker:', error);
  process.exitCode = 1;
});

worker.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
