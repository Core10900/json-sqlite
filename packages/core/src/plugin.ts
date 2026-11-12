/**
 * Public plugin contract entry: `import '@webofcat/jsonsqlite/plugin'`.
 * Deep `dist/` paths are not a supported API.
 */
export {
  assertPluginManifest,
  builtinPluginCatalog,
  builtinPluginInfo,
  createS3Plugin,
  createS3Stub,
  createVectorStub,
  PLUGIN_KINDS,
  PluginRegistry,
} from './plugins/registry.js';
export type {
  BuiltinPluginInfo,
  EnginePlugin,
  PluginErrorRecord,
  PluginKind,
  PluginManifest,
  VectorSearchResult,
} from './plugins/registry.js';
export { loadPluginFromPath, isJsonQueryShape } from './plugins/load.js';
