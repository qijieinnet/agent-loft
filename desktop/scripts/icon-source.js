// All platforms share the mark and colors from the web icon.
import fs from "node:fs";

const source = fs.readFileSync(new URL("../../web/icon.svg", import.meta.url), "utf8");
const shapes = source.match(/<g\b[\s\S]*<\/g>/)?.[0];
const definitions = source.match(/<defs>[\s\S]*?<\/defs>/)?.[0] || "";
const background = source.match(/<rect\b[^>]*fill="([^"]+)"/)?.[1];
if (!shapes || !background) throw new Error("web/icon.svg must contain a background rect and a grouped mark");

// Template icons use alpha only; the OS supplies their foreground color.
export const MARK = definitions + shapes;
export const TRAY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="112 112 288 288">${definitions}${shapes.replace(/(?:fill|color)="(?!none)[^"]+"/g, (attr) => attr.replace(/"[^"]+"/, '"#000"'))}</svg>`;

// macOS artwork sits inside its standard 824px tile, surrounded by transparency.
export const APP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  ${definitions}
  <defs><filter id="shadow" x="-15%" y="-15%" width="130%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="13" flood-color="#152452" flood-opacity=".18"/></filter></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="${background}" filter="url(#shadow)"/>
  <g transform="translate(100 100) scale(1.609375)">${shapes}</g>
</svg>`;
