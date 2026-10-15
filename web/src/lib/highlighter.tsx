import * as React from "react"
import {
  createHighlighterCore,
  type GrammarState,
  type HighlighterCore,
} from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

// Add the languages you need. Each one loads the first time it is used.
const languages = {
  bash: async () => import("shiki/langs/shellscript.mjs"),
  css: async () => import("shiki/langs/css.mjs"),
  diff: async () => import("shiki/langs/diff.mjs"),
  html: async () => import("shiki/langs/html.mjs"),
  javascript: async () => import("shiki/langs/javascript.mjs"),
  json: async () => import("shiki/langs/json.mjs"),
  jsx: async () => import("shiki/langs/jsx.mjs"),
  markdown: async () => import("shiki/langs/markdown.mjs"),
  python: async () => import("shiki/langs/python.mjs"),
  sql: async () => import("shiki/langs/sql.mjs"),
  tsx: async () => import("shiki/langs/tsx.mjs"),
  typescript: async () => import("shiki/langs/typescript.mjs"),
  yaml: async () => import("shiki/langs/yaml.mjs"),
}

type Language = keyof typeof languages

const aliases = new Map<string, Language>([
  ["js", "javascript"],
  ["md", "markdown"],
  ["py", "python"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["shellscript", "bash"],
  ["ts", "typescript"],
  ["yml", "yaml"],
  ["zsh", "bash"],
])

const isListed = (name: string): name is Language => Object.hasOwn(languages, name)

// shadcn/ui's highlighter (the Code Block's use-highlighted-code), with one change: GitHub's
// high-contrast pair instead of github-light/dark, whose strings and numbers (#e36209) read at 3.5:1
// on our code ground; the high-contrast pair passes AA (DESIGN.md, Code)
let highlighter: Promise<HighlighterCore> | undefined

async function getHighlighter() {
  highlighter ??= createHighlighterCore({
    themes: [
      import("shiki/themes/github-light-high-contrast.mjs"),
      import("shiki/themes/github-dark-high-contrast.mjs"),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })

  return highlighter
}

function getLanguage(language: string) {
  const name = language.toLowerCase()

  if (name === "ansi") {
    return name
  }

  if (isListed(name)) {
    return name
  }

  return aliases.get(name) ?? null
}

// shiki's per-token style (the --shiki-light and --shiki-dark colours, a font style), as React's
const cssOf = (style: Record<string, string> | undefined): React.CSSProperties =>
  Object.fromEntries(Object.entries(style ?? {}))

// Loads a language and returns a highlighter for it, or null for a language
// that is not listed.
export async function loadHighlighter(language: string) {
  const lang = getLanguage(language)

  if (!lang) {
    return null
  }

  const shiki = await getHighlighter()

  if (lang !== "ansi" && !shiki.getLoadedLanguages().includes(lang)) {
    await shiki.loadLanguage(languages[lang])
  }

  return {
    // Returns one React node per line, and the grammar state after the last
    // line. Pass that state back to continue where the code left off.
    highlight(code: string, state?: GrammarState) {
      const tokenize = (text: string) =>
        shiki.codeToTokens(text, {
          lang,
          themes: {
            light: "github-light-high-contrast",
            dark: "github-dark-high-contrast",
          },
          defaultColor: false,
          grammarState: state,
        }).tokens

      // ANSI has no grammar state, so each line is tokenized on its own and
      // gets the same colors whether it arrives in one piece or streams.
      const tokens =
        lang === "ansi"
          ? code.split("\n").flatMap((line) => tokenize(line))
          : tokenize(code)

      return {
        lines: tokens.map((line) =>
          line.map((token, index) => (
            <span
              key={index}
              style={cssOf(token.htmlStyle)}
              className="text-(--shiki-light) dark:text-(--shiki-dark)"
            >
              {token.content}
            </span>
          ))
        ),
        state: shiki.getLastGrammarState(tokens),
      }
    },
  }
}

// Returns one React node per line, or null for a language that is not listed.
export async function highlightCode(code: string, language: string) {
  const highlighter = await loadHighlighter(language)

  return highlighter ? highlighter.highlight(code).lines : null
}
