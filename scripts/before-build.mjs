/**
 * Renderer and main-process dependencies are bundled by Vite. Returning false
 * tells electron-builder that runtime node_modules are already handled, so it
 * does not copy the full development dependency graph into app.asar.
 */
export default async function beforeBuild() {
  return false;
}
