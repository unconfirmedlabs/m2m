/** Exact operator entrypoint for the reduced live demo. */
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readDemoHostConfig, runDemoServer } from './agent-demo-server.js';
import { initializeReducedDemoState } from './reduced-demo-init.js';

function usage(): never {
  process.stderr.write('usage: npm run reduced-live-demo -- init|serve --config /absolute/path/to/host.json\n');
  throw Error('invalid_host_config');
}

export async function runReducedLiveDemo(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 3 || !['init', 'serve'].includes(argv[0]!) || argv[1] !== '--config' || !isAbsolute(argv[2]!)) usage();
  if (argv[0] === 'init') {
    const config = await readDemoHostConfig(argv[2]!);
    process.stdout.write(JSON.stringify(await initializeReducedDemoState(config)) + '\n');
    return;
  }
  await runDemoServer(argv[2]!);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReducedLiveDemo().catch(() => { process.exitCode = 1; });
}
