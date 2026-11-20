import { rename } from "node:fs/promises";
import path from "node:path";

// Electron Builder writes icon.icns. Give the current artwork a new resource name
// so macOS sees the change in Info.plist after an in-place update.
export default async function renameMacIcon({ electronPlatformName, appOutDir, packager }) {
  if (electronPlatformName !== "darwin") return;
  const resources = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources");
  const icon = packager.platformSpecificBuildOptions.extendInfo.CFBundleIconFile;
  await rename(path.join(resources, "icon.icns"), path.join(resources, icon));
}
