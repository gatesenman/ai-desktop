#!/usr/bin/env node
/** Patch app-builder-lib NsisTarget to prefer UninstallerReader over wine (wine64-only hosts). */
const fs = require("fs");
const path = require("path");
const target = path.join(__dirname, "..", "node_modules", "app-builder-lib", "out", "targets", "nsis", "NsisTarget.js");
if (!fs.existsSync(target)) {
  console.error("NsisTarget.js not found; run npm install first");
  process.exit(1);
}
let text = fs.readFileSync(target, "utf8");
if (text.includes("Prefer binary UninstallerReader")) {
  console.log("already patched");
  process.exit(0);
}
const old = `        // http://forums.winamp.com/showthread.php?p=3078545
        if ((0, macosVersion_1.isMacOsCatalina)()) {
            try {
                await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);
            }
            catch (error) {
                builder_util_1.log.warn(\`packager.vm is used: \${error.message}\`);
                const vm = await packager.vm.value;
                await vm.exec(installerPath, []);
                // Parallels VM can exit after command execution, but NSIS continue to be running
                let i = 0;
                while (!(await (0, fs_1.exists)(uninstallerPath)) && i++ < 100) {
                    // noinspection JSUnusedLocalSymbols
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    await new Promise((resolve, _reject) => setTimeout(resolve, 300));
                }
            }
        }
        else {
            await (0, wine_1.execWine)(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
        }`;
const neu = `        // Prefer binary UninstallerReader (works on Linux wine64-only hosts; avoids 32-bit NSIS stub under wine64)
        try {
            await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);
        }
        catch (error) {
            builder_util_1.log.warn(\`UninstallerReader failed, falling back: \${error.message}\`);
            if ((0, macosVersion_1.isMacOsCatalina)()) {
                const vm = await packager.vm.value;
                await vm.exec(installerPath, []);
                let i = 0;
                while (!(await (0, fs_1.exists)(uninstallerPath)) && i++ < 100) {
                    await new Promise((resolve, _reject) => setTimeout(resolve, 300));
                }
            }
            else {
                await (0, wine_1.execWine)(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
            }
        }`;
if (!text.includes(old)) {
  console.error("pattern not found — electron-builder version may differ");
  process.exit(2);
}
fs.writeFileSync(target, text.replace(old, neu));
console.log("patched", target);
