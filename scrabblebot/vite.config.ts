import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { Marked } from "marked";

const GUIDE_SOURCE = "docs/bot-guide.md";
const VIRTUAL_ID = "virtual:bot-guide";
const RESOLVED_ID = "\0" + VIRTUAL_ID;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Headings get ids so in-page anchors like /docs#tournaments work.
const marked = new Marked({
  renderer: {
    heading({ tokens, depth, text }) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${slug(text)}">${inner}</h${depth}>\n`;
    },
  },
});

// The bot guide is written once, in Markdown, and published three ways:
// rendered inside the SPA at /docs, as a pre-rendered /docs.html that
// readers without JavaScript (bots, mostly) get at /docs, and as raw
// /docs.md for agents that ask for Markdown. See vercel.json for the routing.
function botGuide(): Plugin {
  let env: Record<string, string | undefined> = {};
  let source = GUIDE_SOURCE;

  const markdown = () => {
    const dbName = env.VITE_STDB_DB ?? "scrabblebot";
    const starterEnv = dbName === "scrabblebot" ? "" : `STDB_DB=${dbName} `;
    return readFileSync(source, "utf8")
      .replaceAll("{{DB_NAME}}", dbName)
      .replaceAll("{{STARTER_ENV}}", starterEnv);
  };

  // The SPA renders its own page header, so split the h1 off the body.
  const rendered = () => {
    const [, title = "", body = ""] =
      /^# (.*)\n([\s\S]*)$/.exec(markdown()) ?? [];
    return { title, html: marked.parse(body, { async: false }) };
  };

  return {
    name: "bot-guide",
    enforce: "post",
    configResolved(config) {
      env = config.env;
      source = resolve(config.root, GUIDE_SOURCE);
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return;
      this.addWatchFile(source);
      const { title, html } = rendered();
      return `export const title = ${JSON.stringify(title)};
export const html = ${JSON.stringify(html)};`;
    },
    configureServer(server) {
      server.middlewares.use("/docs.md", (_req, res) => {
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.end(markdown());
      });
    },
    generateBundle(_options, bundle) {
      this.emitFile({ type: "asset", fileName: "docs.md", source: markdown() });

      const shell = bundle["index.html"];
      if (shell?.type !== "asset") {
        this.error("bot-guide: index.html missing from bundle");
      }
      const { title, html } = rendered();
      const page = String(shell.source)
        .replace(
          /<title>.*<\/title>/,
          `<title>${escapeHtml(title)} · ScrabbleBot</title>
    <link rel="alternate" type="text/markdown" href="/docs.md" />`,
        )
        .replace(
          '<div id="root"></div>',
          `<div id="root"><div class="page"><div class="header full"><h1>${escapeHtml(title)}</h1></div><section class="panel full docs">${html}</section></div></div>`,
        );
      this.emitFile({ type: "asset", fileName: "docs.html", source: page });
    },
  };
}

export default defineConfig({
  plugins: [react(), botGuide()],
  server: { port: 5173 },
});
