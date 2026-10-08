// Small rules that more than one part of the system has to agree on, each kept in one place.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_HOME_CATEGORIES } from "../src/js/lib/home.js";
import { LABEL_ICON_NAMES, LABEL_ICON_TITLES } from "../src/js/lib/label-icons.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = (path) => readFileSync(join(ROOT, path), "utf8");
const filesUnder = (dir) => readdirSync(join(ROOT, dir)).flatMap((name) => {
  const path = `${dir}/${name}`;
  return statSync(join(ROOT, path)).isDirectory() ? filesUnder(path) : [path];
});

describe("how many categories the home page shows", () => {
  it("is six, as it has always been", () => {
    expect(MAX_HOME_CATEGORIES).toBe(6);
  });

  it("is one value, used by the home page that draws them and the dashboard that explains them", () => {
    for (const file of ["src/js/featured.js", "src/dashboard/views/photos.js"]) {
      const text = source(file);
      expect(text, file).toMatch(/import \{ MAX_HOME_CATEGORIES \} from "[^"]*\/lib\/home\.js";/);
      expect(text.match(/MAX_HOME_CATEGORIES/g).length, file).toBeGreaterThan(1);
    }
    // The home page takes that many, and no other number.
    expect(source("src/js/featured.js")).toContain("categories.slice(0, MAX_HOME_CATEGORIES)");
  });

  it("is written nowhere else: no second copy of the number, in digits or in words", () => {
    const scripts = filesUnder("src").filter((file) => file.endsWith(".js") && file !== "src/js/lib/home.js");
    for (const file of scripts) {
      const text = source(file);
      expect(text, file).not.toMatch(/(MAX|HOME)_CATEGORIES\s*=\s*\d/);
      expect(text, file).not.toMatch(/first six categor|first 6 categor|among the first six/i);
    }
    expect(source("src/js/lib/home.js").match(/=\s*6;/g)).toHaveLength(1);
  });
});

describe("the label icons", () => {
  it("each has a name for the owner, and a drawing that is path data and nothing else", () => {
    const text = source("src/js/lib/label-icons.js");
    expect(LABEL_ICON_NAMES).toHaveLength(18);
    for (const name of LABEL_ICON_NAMES) {
      expect(LABEL_ICON_TITLES[name], name).toBeTruthy();
      expect(name, name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
    // Every drawing is a list of SVG paths: move, line and curve commands, and numbers.
    // (The drawings come first in the file; the names for the owner follow them.)
    const drawings = text.slice(0, text.indexOf("export const LABEL_ICON_TITLES"));
    const paths = [...drawings.matchAll(/"([Mm][^"]*)"/g)].map((match) => match[1]);
    expect(paths.length).toBeGreaterThanOrEqual(LABEL_ICON_NAMES.length);
    for (const path of paths) expect(path, path.slice(0, 30)).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]+$/);
    // No emoji, no picture, no colour of its own, nothing fetched.
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(drawings).not.toMatch(/https?:\/\/|\.png|\.svg|#[0-9a-f]{3,6}\b/i);
    // The only address in the file is the name of the SVG format itself.
    expect(text.match(/https?:\/\/[^"']+/g).every((url) => url === "http://www.w3.org/2000/svg")).toBe(true);
    expect(text).toContain('svg.setAttribute("stroke", "currentColor")');
    expect(text).toContain('svg.setAttribute("aria-hidden", "true")');
  });
});
