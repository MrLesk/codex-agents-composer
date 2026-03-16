import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Codex Agents Composer",
    identifier: "dev.codex.agents-composer",
    version: "0.1.0",
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
      icons: "assets/AppIcon.iconset",
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
