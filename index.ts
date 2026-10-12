/**
 * Package-level entry point for the Pi extension.
 *
 * Pi labels a package extension as `<package name>:<directory of entry file>`
 * and only drops the `:<directory>` suffix when an `index.*` file sits at the
 * package root (see `getCompactExtensionLabel` in Pi's interactive mode). This
 * thin re-export exists so Pi lists the extension as `@mozilla-ai/pi-otari`
 * instead of `@mozilla-ai/pi-otari:src`. Keep the real implementation in
 * `src/index.ts`.
 */
export {
  createOtariExtension,
  type ExtensionDependencies,
} from "./src/index.js";

export { default } from "./src/index.js";
