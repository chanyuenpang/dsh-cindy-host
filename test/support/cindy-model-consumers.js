import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Load actual consumer sources. Only unused React/application infrastructure is
 * stubbed; desktop wire validation and shared model policy execute unmodified. */
export async function loadCindyModelConsumers(checkout) {
  const root = pathToFileURL(resolve(checkout) + '/').href;
  const shared = root + 'packages/model-providers/src/';
  const desktop = root + 'apps/desktop/src/renderer/hooks/useDeviceProviders.ts';
  const never = '(){throw Error("UI infrastructure must not run in decoder contract tests")}';
  const stubs = {
    'react': 'export function useEffect' + never + ';export function useState' + never,
    '@cindy/device-link': 'export const CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2="unused-in-parser"',
    '@cindy/maker-shared/device-link-contract': 'export function isTransientRemoteError' + never + ';export function isDeviceUnresponsiveRemoteError' + never,
    '@/contexts/dataOwnerGeneration': 'export function getDataOwnerGeneration' + never + ';export function isDataOwnerGenerationCurrent' + never,
    '@/lib/logger': 'export function createLogger(){return {}}',
    '@/utils/ipcError': 'export function extractIpcError' + never,
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === desktop) {
      if (specifier === '@cindy/model-providers') return next(shared + 'effortResolution.ts', context);
      if (stubs[specifier]) return next('data:text/javascript,' + encodeURIComponent(stubs[specifier]), context);
    }
    if (context.parentURL?.startsWith(shared) && specifier.startsWith('./') && specifier.endsWith('.js')) {
      const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(ts)) return next(ts.href, context);
    }
    return next(specifier, context);
  } });
  try {
    const desktopApi = await import(desktop);
    const mobileApi = await import(root + 'apps/mobile/src/device-link/deviceProvidersCache.ts');
    return {
      parseDesktopProviders: desktopApi.parseDeviceProvidersPayload,
      fetchMobileProviders: mobileApi.fetchDeviceProviders,
      evictMobileProviders: mobileApi.evictDeviceProviders,
      ...(await import(shared + 'unifiedSelection.ts')),
      ...(await import(shared + 'registry.ts')),
      dispose: () => hooks.deregister(),
    };
  } catch (error) { hooks.deregister(); throw error; }
}
