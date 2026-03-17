import type { ElectrobunConfig } from "electrobun";
import packageJson from "./package.json" with { type: "json" };

const macCodesignEnabled = Boolean(process.env.ELECTROBUN_DEVELOPER_ID);
const macNotarizeEnabled =
  macCodesignEnabled &&
  (
    (
      Boolean(process.env.ELECTROBUN_APPLEAPIISSUER) &&
      Boolean(process.env.ELECTROBUN_APPLEAPIKEY) &&
      Boolean(process.env.ELECTROBUN_APPLEAPIKEYPATH)
    ) ||
    (
      Boolean(process.env.ELECTROBUN_APPLEID) &&
      Boolean(process.env.ELECTROBUN_APPLEIDPASS) &&
      Boolean(process.env.ELECTROBUN_TEAMID)
    )
  );

export default {
  app: {
    name: "Codex Agents Composer",
    identifier: "dev.codex.agents-composer",
    version: packageJson.version,
    description: "Desktop app for composing Codex agents and skills",
  },
  build: {
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
      codesign: macCodesignEnabled,
      icons: "assets/AppIcon.iconset",
      notarize: macNotarizeEnabled,
    },
    linux: {
      bundleCEF: false,
      icon: "assets/AppIcon.png",
    },
    win: {
      bundleCEF: false,
      icon: "assets/AppIcon.ico",
    },
  },
} satisfies ElectrobunConfig;
