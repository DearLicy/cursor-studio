// Keep the in-app identity on Vite's asset pipeline. A root-relative public
// path works in the dev server but points at the drive root in packaged
// file:// builds.
export const appIconUrl = new URL("../../resources/icon-runtime.png", import.meta.url).href;
