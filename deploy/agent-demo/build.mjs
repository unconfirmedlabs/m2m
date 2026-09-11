/** Build only the real server's dependency graph; no test or fixture entrypoint. */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const allowed = /^scripts\/(?:agent-[a-z-]+|responses-[a-z-]+|native-[a-z-]+|streaming-[a-z-]+|codex-worker|research-conversation|demo-types|chain|codec)\.ts$/;
const forbidden = /(?:^|\/)(?:test[^/]*|fixtures?|examples?|node_modules|\.m2m)(?:\/|\.)|(?:-examples|-setup(?:-helper)?)\.ts$/;

try {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['scripts/agent-demo-server.ts'],
    outfile: 'dist/agent-demo/server.mjs',
    platform: 'node', target: 'node22', format: 'esm',
    bundle: true, packages: 'external', metafile: true,
    sourcemap: false, write: false, logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs);
  if (!inputs.includes('scripts/agent-demo-runtime.ts') || !inputs.includes('scripts/agent-demo-event-contract.ts') ||
      inputs.some(path => !allowed.test(path) || forbidden.test(path))) throw Error('invalid_graph');
  // Preserve import.meta.url for every module. Bundling the CLI main guards
  // together would incorrectly execute imported native/legacy CLI entrypoints.
  const compiled = await build({
    absWorkingDir: root, entryPoints: inputs, outbase: 'scripts',
    outdir: 'dist/agent-demo/scripts', platform: 'node', target: 'node22',
    format: 'esm', bundle: false, sourcemap: false, write: false, logLevel: 'silent',
  });
  const expected = new Set(inputs.map(path => resolve(root, 'dist/agent-demo', path.replace(/\.ts$/, '.js'))));
  if (compiled.outputFiles.length !== expected.size || compiled.outputFiles.some(file => !expected.has(file.path))) throw Error('invalid_output');
  await mkdir(resolve(root, 'dist/agent-demo/scripts'), { recursive: true });
  for (const output of compiled.outputFiles) await writeFile(output.path, output.contents);
  await writeFile(resolve(root, 'dist/agent-demo/build-inputs.json'), JSON.stringify({ version: 1, inputs: inputs.sort() }, null, 2) + '\n');
  process.stdout.write('agent_demo_server_build_ok\n');
} catch {
  // A missing L1/L2 module is a failed build, never permission to ship a fixture.
  process.stderr.write('agent_demo_server_build_failed\n');
  process.exitCode = 1;
}
