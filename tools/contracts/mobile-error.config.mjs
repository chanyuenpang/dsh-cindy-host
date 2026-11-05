/** Opt-in actual Cindy consumer contract. No files are written into its checkout. */
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
if (!process.env.CINDY_SOURCE_ROOT) throw new Error('Set CINDY_SOURCE_ROOT to an actual Cindy checkout with installed test dependencies');
const cindy = resolve(process.env.CINDY_SOURCE_ROOT);
const { default: upstream } = await import(pathToFileURL(join(cindy, 'apps/mobile/vitest.config.ts')).href);
export default { ...upstream, root: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: { ...upstream.resolve, alias: { ...upstream.resolve.alias, vitest: join(cindy, 'node_modules/vitest/dist/index.js'), 'cindy-trigger-protocol': join(cindy, 'packages/maker-shared/src/syntheticTrigger.ts') } },
  test: { ...upstream.test, include: ['tools/contracts/*.contract.ts'] } };
