// "Icons - Maintained" (VS Code extension yusifaliyevpro.vscicons, MIT), see src/assets/vscicons/SOURCE.txt.
import manifest from "../assets/vscicons/icons.json";
import { byBasename, createResolver, type VsCodeIconTheme } from "./vscodeTheme";

const urls = import.meta.glob<string>("../assets/vscicons/icons/*.svg", {
  query: "?no-inline",
  import: "default",
  eager: true,
});

export const resolve = createResolver(manifest as unknown as VsCodeIconTheme, byBasename(urls));
