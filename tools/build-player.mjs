/**
 * Construit public/index.html (lecteur d'écran) à partir de src/ :
 *  - CSS préfixé pour les anciens moteurs WebKit/Chromium des TV ;
 *  - JavaScript converti en ES5, précédé des polyfills (Promise, fetch, etc.).
 * Usage : cd tools && npm install && node build-player.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import babel from "@babel/core";
import postcss from "postcss";
import autoprefixer from "autoprefixer";
import { minify } from "terser";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => path.join(here, "..", "src", f);
const TARGETS = "ie >= 11, chrome >= 38, safari >= 7, ios >= 7, android >= 4.4";

const css = (await postcss([autoprefixer({ overrideBrowserslist: TARGETS })])
  .process(fs.readFileSync(src("player.css"), "utf8"), { from: undefined })).css;

const app = babel.transformSync(fs.readFileSync(src("player.js"), "utf8"), {
  presets: [["@babel/preset-env", { targets: TARGETS, loose: true, modules: false, bugfixes: true }]],
  assumptions: { iterableIsArray: true, arrayLikeIsIterable: true },
  sourceType: "script", configFile: false, babelrc: false,
}).code;
if (/\b(async|await|=>|`)\b|\bclass\s|\blet\s|\bconst\s/.test(app.replace(/'[^'\n]*'|"[^"\n]*"/g, ""))) {
  console.warn("⚠ Syntaxe moderne restante dans le lecteur : vérifiez la sortie.");
}

const polyfills = [
  fs.readFileSync(require.resolve("promise-polyfill/dist/polyfill.min.js"), "utf8"),
  fs.readFileSync(require.resolve("whatwg-fetch/dist/fetch.umd.js"), "utf8"),
  fs.readFileSync(src("polyfills.js"), "utf8"),
].join("\n;\n");

const js = (await minify(polyfills + "\n;\n" + app, { ecma: 5, safari10: true, compress: { passes: 1 }, mangle: true })).code;

const html = fs.readFileSync(src("player.template.html"), "utf8")
  .replace("/*CSS*/", () => css)
  .replace("/*JS*/", () => js);
fs.writeFileSync(path.join(here, "..", "public", "index.html"), html);
console.log(`Lecteur construit : public/index.html (${(html.length / 1024).toFixed(0)} Ko)`);
