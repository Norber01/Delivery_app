// Expo's default Metro config already understands the pnpm monorepo (watch folders, node_modules).
// The shared packages are TypeScript sources that use ESM-style "./file.js" imports (as required
// by Node/TypeScript); Metro needs telling that those refer to "./file.ts".
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const defaultResolve = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolve ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    for (const ext of ['.ts', '.tsx']) {
      try {
        return resolve(context, moduleName.slice(0, -3) + ext, platform);
      } catch {
        // fall through to the next extension / the original name
      }
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
