import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineConfig, type DummyRule, type OxlintOverride } from "oxlint";

/** perfectionist default: natural, ascending. */
const natural: DummyRule = ["warn", { order: "asc", type: "natural" }];

/**
 * `options.typeAware` reaches the linter through `extends`, so a consuming root
 * config inherits it and plain `oxlint` runs the type-aware rules. The binary
 * they need does not travel with it: oxlint looks for `node_modules/.bin/
 * tsgolint` upwards from the working directory, and without it refuses the run
 * behind a single line of output. Say it louder, with the fix.
 *
 * A miss here is the whole point, so it prints rather than throws: a config
 * that throws is reported as a load failure, message buried under a stack
 * trace, and takes `--print-config` and the editor down with it. oxlint already
 * exits non-zero on its own, so there is nothing left to enforce.
 */
function findTsgolint(from: string) {
  // npm writes a `.cmd` shim beside the shell one on Windows.
  const shims = ["tsgolint", "tsgolint.cmd"];

  for (let dir = from; ; dir = dirname(dir)) {
    if (shims.some((shim) => existsSync(join(dir, "node_modules", ".bin", shim)))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * The LSP loads this file too, and its stderr is a log nobody reads. A test or
 * a script importing the config is not a lint run either, so the banner waits
 * for the binary itself to be the thing that ran.
 */
const isOxlintCli =
  basename(process.argv[1] ?? "") === "oxlint" && !process.argv.includes("--lsp");

/** oxlint takes this path over the lookup, so a value here settles the question. */
const configuredTsgolint = process.env.OXLINT_TSGOLINT_PATH ?? "";

if (isOxlintCli && configuredTsgolint === "" && !findTsgolint(process.cwd())) {
  process.stderr.write(`
╔══════════════════════════════════════════════════════════════════════╗
║   @hasparus/oxlint-config: type-aware linting cannot run             ║
╚══════════════════════════════════════════════════════════════════════╝

  This config turns on oxlint's type-aware rules — no-floating-promises,
  no-unsafe-argument, no-unnecessary-type-parameters and the rest. They
  run in tsgolint, which is not installed here, so oxlint will refuse to
  lint anything at all.

      npm install --save-dev oxlint-tsgolint

  That is the whole fix. \`options.typeAware\` is already set, so plain
  \`oxlint\` picks the rules up — no \`--type-aware\` flag to add. To decline
  them instead, set \`options: { typeAware: false }\` in your root config.

`);
}

/**
 * anti-slop ships source to vendor rather than a package to depend on, so its
 * fifteen rules travel inside this one, under `anti-slop/`.
 *
 * The specifier has to be absolute. A relative one resolves against the config
 * that declares it, and `extends` inlines this config into the consumer's, so
 * `./anti-slop/index.js` would be hunted for beside *their* file and found
 * nowhere. A `file:` URL rather than a path, because a Windows path is not a
 * valid import specifier.
 *
 * `.js`, not the `.ts` upstream registers: oxlint reads a TypeScript plugin
 * only under Bun, Deno, or Node >= 22.18, and a config a consumer installs
 * does not get to pick their runtime. `anti-slop/*.ts` stays as the readable
 * source, and the build compiles it beside itself.
 */
const ANTI_SLOP = new URL("anti-slop/index.js", import.meta.url).href;

/** App Router conventions. `route` exports GET/POST by name, so it is absent. */
const NEXT_APP_FILES =
  "{page,layout,template,default,loading,error,global-error,not-found,forbidden,unauthorized,global-not-found,robots,sitemap,manifest}";

/** Image routes, the only conventions that take a numeric suffix. */
const NEXT_IMAGE_FILES = "{icon,apple-icon,opengraph-image,twitter-image}{,[0-9],[0-9][0-9]}";

/**
 * Spread into your own `overrides`. `extends` drops a base config's overrides,
 * so these apply only where the consuming config declares them.
 *
 * Every glob leads with `**`: a relative one resolves against the config that
 * declares it. The filename is the only thing left to narrow on, which is why
 * the Pages Router is absent — every file under `pages` is a route, so
 * `**‍/pages/**` would swallow a `components/pages/` folder.
 */
export const overrides: OxlintOverride[] = [
  /** Next reads its file conventions by default export. */
  {
    files: [
      `**/app/**/${NEXT_APP_FILES}.{js,jsx,ts,tsx}`,
      `**/app/**/${NEXT_IMAGE_FILES}.{js,jsx,ts,tsx}`,
    ],
    rules: { "import/no-default-export": "off" },
  },
  /**
   * A Playwright locator is not a DOM node: `innerText()` reads what the page
   * renders, `textContent()` reads the source. The rule's fix swaps one for
   * the other and rewrites the assertion. Spec files only — a `page.evaluate`
   * body, and any helper beside the specs, does hold DOM nodes.
   */
  {
    files: [
      "**/e2e/**/*.{spec,test}.{js,jsx,ts,tsx,mjs,cjs}",
      "**/playwright/**/*.{spec,test}.{js,jsx,ts,tsx,mjs,cjs}",
    ],
    rules: { "unicorn/prefer-dom-node-text-content": "off" },
  },
];

/**
 * Spread into your own, the same as `overrides` and for the same reason:
 * oxlint reads ignore patterns from the root config only, so a base config's
 * are dropped on the way through `extends`.
 */
export const ignorePatterns: string[] = [
  "dist",
  ".astro",
  "src/routeTree.gen.ts",
  "node_modules",
  "**/.wrangler/tmp/**/*",
  "**/.cache/**/*",
  ".git",
  /**
   * Where coding agents keep their own furniture — skills, hooks, prompts,
   * whatever `npx skills add` last dropped in. Installed assets, the same as
   * `node_modules`, and a repo that lints them is reviewing someone else's
   * code. Named one by one rather than as `.*`, because plenty of dot
   * directories do hold source worth reading.
   *
   * Bare names, like `dist` and `.astro` above: a pattern with a slash in it
   * anchors to the directory of the config that declares it, and a bare one
   * matches the directory at any depth — which is where a monorepo keeps the
   * second and third copy.
   */
  ".agent",
  ".agents",
  ".claude",
  ".codex",
  ".continue",
  ".cursor",
  ".gemini",
  ".opencode",
  ".pi",
  ".roo",
  ".windsurf",
];

export default defineConfig({
  categories: { correctness: "off" },
  env: {
    browser: true,
    builtin: true,
    es2026: true,
    node: true,
  },
  ignorePatterns,
  jsPlugins: [
    { name: "anti-slop", specifier: ANTI_SLOP },
    "eslint-plugin-perfectionist",
    "eslint-plugin-sonarjs",
    "eslint-plugin-better-tailwindcss",
  ],
  /**
   * Type-aware rules that are not asked for are rules that silently do
   * nothing, so this asks. It survives `extends`, which means a consumer gets
   * them from plain `oxlint` with no flag and no lint script to remember.
   */
  options: { typeAware: true },
  overrides: [
    {
      files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      rules: { "no-with": "off" },
    },
    {
      files: ["**/*.d.ts", "**/*.config.*", "*.config.*"],
      rules: { "import/no-default-export": "off", "no-var": "off" },
    },
    ...overrides,
    {
      files: ["**/*.tsx", "**/*.jsx"],
      rules: {
        "better-tailwindcss/enforce-canonical-classes": "warn",
        "better-tailwindcss/no-conflicting-classes": "warn",
        "better-tailwindcss/no-deprecated-classes": "warn",
        "better-tailwindcss/no-duplicate-classes": "warn",
        "better-tailwindcss/no-unknown-classes": "warn",
        "better-tailwindcss/no-unnecessary-whitespace": "warn",
      },
    },
  ],
  plugins: ["typescript", "unicorn", "import", "promise", "react"],
  rules: {
    /**
     * anti-slop, vendored — fifteen rules against the shapes code takes when
     * whoever wrote it could not see the type it needed: `unknown` in a
     * signature, `Record<string, unknown>` standing in for a shape, an
     * assertion claiming what nothing checked. A model writes them by the
     * dozen and so does a person in a hurry; the rules do not care which.
     *
     * Upstream turns all fifteen on as errors. They are warnings here for the
     * reason everything else is: none of them is a bug, and the last one asks
     * for a sentence of prose no `--fix` can write. Measured over this
     * repository they come to seventeen reports across twenty source files,
     * which is a morning's work, not a wall.
     */
    "anti-slop/no-chained-type-assertions": "warn",
    "anti-slop/no-conditional-empty-object-spread": "warn",
    "anti-slop/no-known-value-widening": "warn",
    "anti-slop/no-module-mocking": "warn",
    "anti-slop/no-object-parameters": "warn",
    "anti-slop/no-reflect-apply": "warn",
    "anti-slop/no-reflect-get": "warn",
    /**
     * The rule's answer to a `typeof` check is to parse the value at its I/O
     * boundary instead, which presumes a parser. Nothing here has one, and the
     * checks it catches in practice are not reading I/O at all — they are
     * discriminating a union TypeScript itself models with `typeof`, the way
     * oxlint's own `string | { name, specifier }` plugin entry is modelled.
     *
     * `allowInTypeGuards` is the narrow version of that concession: a `typeof`
     * inside a type predicate or an assertion function passes, one sitting in
     * the middle of a function that is meant to be doing something else does
     * not. It still costs a name, which is the point.
     */
    "anti-slop/no-runtime-typeof": ["warn", { allowInTypeGuards: true }],
    "anti-slop/no-shape-in-symbol-names": "warn",
    "anti-slop/no-unknown-parameters": "warn",
    "anti-slop/no-unknown-returns": "warn",
    "anti-slop/no-unknown-type-aliases": "warn",
    "anti-slop/no-unsafe-dictionary-type": "warn",
    "anti-slop/no-widen-then-assert": "warn",
    "anti-slop/require-safety-comment-for-type-assertion": "warn",
    "constructor-super": "off",
    curly: "off",
    eqeqeq: [
      "warn",
      "always",
      {
        null: "ignore",
      },
    ],
    "for-direction": "error",
    "getter-return": "off",
    "import/first": "warn",
    "import/newline-after-import": "off",
    "import/no-default-export": "warn",
    "import/no-duplicates": "warn",
    "import/prefer-default-export": "off",
    "jsx-a11y/alt-text": "warn",
    "jsx-a11y/anchor-ambiguous-text": "off",
    "jsx-a11y/anchor-has-content": "warn",
    "jsx-a11y/anchor-is-valid": "warn",
    "jsx-a11y/aria-activedescendant-has-tabindex": "warn",
    "jsx-a11y/aria-props": "warn",
    "jsx-a11y/aria-proptypes": "warn",
    "jsx-a11y/aria-role": "warn",
    "jsx-a11y/aria-unsupported-elements": "warn",
    "jsx-a11y/autocomplete-valid": "warn",
    "jsx-a11y/click-events-have-key-events": "warn",
    "jsx-a11y/control-has-associated-label": [
      "off",
      {
        ignoreElements: ["audio", "canvas", "embed", "input", "textarea", "tr", "video"],
        ignoreRoles: [
          "grid",
          "listbox",
          "menu",
          "menubar",
          "radiogroup",
          "row",
          "tablist",
          "toolbar",
          "tree",
          "treegrid",
        ],
        includeRoles: ["alert", "dialog"],
      },
    ],
    "jsx-a11y/heading-has-content": "warn",
    "jsx-a11y/html-has-lang": "warn",
    "jsx-a11y/iframe-has-title": "warn",
    "jsx-a11y/img-redundant-alt": "warn",
    "jsx-a11y/interactive-supports-focus": [
      "warn",
      {
        tabbable: ["button", "checkbox", "link", "searchbox", "spinbutton", "switch", "textbox"],
      },
    ],
    "jsx-a11y/label-has-associated-control": "warn",
    "jsx-a11y/media-has-caption": "warn",
    "jsx-a11y/mouse-events-have-key-events": "warn",
    "jsx-a11y/no-access-key": "warn",
    "jsx-a11y/no-autofocus": "warn",
    "jsx-a11y/no-distracting-elements": "warn",
    "jsx-a11y/no-interactive-element-to-noninteractive-role": [
      "warn",
      {
        canvas: ["img"],
        tr: ["none", "presentation"],
      },
    ],
    "jsx-a11y/no-noninteractive-element-interactions": [
      "warn",
      {
        alert: ["onKeyUp", "onKeyDown", "onKeyPress"],
        body: ["onError", "onLoad"],
        dialog: ["onKeyUp", "onKeyDown", "onKeyPress"],
        handlers: [
          "onClick",
          "onError",
          "onLoad",
          "onMouseDown",
          "onMouseUp",
          "onKeyPress",
          "onKeyDown",
          "onKeyUp",
        ],
        iframe: ["onError", "onLoad"],
        img: ["onError", "onLoad"],
      },
    ],
    "jsx-a11y/no-noninteractive-element-to-interactive-role": [
      "warn",
      {
        fieldset: ["radiogroup", "presentation"],
        li: ["menuitem", "menuitemradio", "menuitemcheckbox", "option", "row", "tab", "treeitem"],
        ol: ["listbox", "menu", "menubar", "radiogroup", "tablist", "tree", "treegrid"],
        table: ["grid"],
        td: ["gridcell"],
        ul: ["listbox", "menu", "menubar", "radiogroup", "tablist", "tree", "treegrid"],
      },
    ],
    "jsx-a11y/no-noninteractive-tabindex": [
      "warn",
      {
        allowExpressionValues: true,
        roles: ["tabpanel"],
        tags: [],
      },
    ],
    "jsx-a11y/no-redundant-roles": "warn",
    "jsx-a11y/no-static-element-interactions": [
      "warn",
      {
        allowExpressionValues: true,
        handlers: ["onClick", "onMouseDown", "onMouseUp", "onKeyPress", "onKeyDown", "onKeyUp"],
      },
    ],
    "jsx-a11y/role-has-required-aria-props": "warn",
    "jsx-a11y/role-supports-aria-props": "warn",
    "jsx-a11y/scope": "warn",
    "jsx-a11y/tabindex-no-positive": "warn",
    "logical-assignment-operators": [
      "warn",
      "always",
      {
        enforceForIfStatements: true,
      },
    ],
    "no-array-constructor": "warn",
    "no-async-promise-executor": "error",
    "no-case-declarations": "warn",
    "no-class-assign": "off",
    "no-compare-neg-zero": "error",
    "no-cond-assign": "error",
    "no-console": "warn",
    "no-const-assign": "off",
    "no-constant-binary-expression": "error",
    "no-constant-condition": "error",
    "no-control-regex": "warn",
    "no-debugger": "error",
    "no-delete-var": "error",
    "no-dupe-class-members": "off",
    "no-dupe-else-if": "error",
    "no-dupe-keys": "off",
    "no-duplicate-case": "error",
    "no-else-return": [
      "warn",
      {
        allowElseIf: false,
      },
    ],
    "no-empty": "warn",
    "no-empty-character-class": "error",
    "no-empty-function": "warn",
    "no-empty-pattern": "error",
    "no-empty-static-block": "warn",
    "no-ex-assign": "error",
    "no-extra-boolean-cast": "warn",
    "no-fallthrough": "error",
    "no-func-assign": "off",
    "no-global-assign": "error",
    /**
     * `disallowTemplateShorthand` is right about `${x}` alone and its fix is
     * wrong about everything else: it replaces the whole literal with
     * `String(x)`, so `${x}\n` loses the newline and ` ${x}` loses the space.
     * Both shipped from one `--fix` run before anyone noticed.
     */
    "no-implicit-coercion": ["warn", { boolean: false, disallowTemplateShorthand: false }],
    "no-import-assign": "off",
    "no-invalid-regexp": "error",
    "no-irregular-whitespace": "warn",
    "no-lonely-if": "warn",
    "no-loss-of-precision": "error",
    "no-misleading-character-class": "error",
    "no-new-native-nonconstructor": "off",
    "no-nonoctal-decimal-escape": "error",
    "no-obj-calls": "off",
    "no-prototype-builtins": "error",
    "no-redeclare": "off",
    "no-regex-spaces": "warn",
    "no-restricted-globals": [
      "warn",
      "stop",
      "close",
      {
        message: "Use Number.isNaN instead",
        name: "isNaN",
      },
    ],
    "no-restricted-imports": [
      "warn",
      {
        paths: [
          {
            importNames: ["PropsWithChildren"],
            message:
              "`PropsWithChildren` set `children` as optional, explicitly define `children` field in your type",
            name: "react",
          },
          {
            message: "Use `fetch/node-fetch` instead.",
            name: "axios",
          },
          {
            message: "Use `dayjs/date-fns` instead.",
            name: "moment",
          },
          {
            message: "Use `clsx` instead because he is faster.",
            name: "classnames",
          },
        ],
      },
    ],
    "no-self-assign": "error",
    "no-self-compare": "warn",
    "no-setter-return": "off",
    "no-shadow-restricted-names": "error",
    "no-sparse-arrays": "error",
    "no-this-before-super": "off",
    "no-unexpected-multiline": "off",
    "no-unreachable": "off",
    "no-unsafe-finally": "error",
    "no-unsafe-negation": "off",
    "no-unsafe-optional-chaining": "error",
    "no-unused-expressions": "warn",
    "no-unused-labels": "warn",
    "no-unused-private-class-members": "warn",
    "no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      },
    ],
    "no-useless-backreference": "error",
    "no-useless-catch": "warn",
    "no-useless-constructor": "warn",
    "no-useless-escape": "warn",
    "no-var": "warn",
    "no-with": "error",
    "object-shorthand": ["warn", "always"],
    "perfectionist/sort-array-includes": natural,
    "perfectionist/sort-decorators": natural,
    "perfectionist/sort-exports": natural,
    "perfectionist/sort-heritage-clauses": natural,
    "perfectionist/sort-interfaces": natural,
    "perfectionist/sort-intersection-types": natural,
    "perfectionist/sort-jsx-props": "warn",
    "perfectionist/sort-maps": natural,
    "perfectionist/sort-named-exports": natural,
    "perfectionist/sort-named-imports": natural,
    "perfectionist/sort-object-types": [
      "warn",
      {
        order: "asc",
        partitionByComment: true,
        type: "natural",
      },
    ],
    "perfectionist/sort-objects": [
      "warn",
      {
        order: "asc",
        partitionByComment: true,
        type: "natural",
      },
    ],
    "perfectionist/sort-sets": natural,
    "perfectionist/sort-switch-case": natural,
    "perfectionist/sort-union-types": [
      "warn",
      {
        groups: ["unknown", "keyword", "nullish"],
        order: "asc",
        type: "natural",
      },
    ],
    "perfectionist/sort-variable-declarations": natural,
    "prefer-arrow-callback": [
      "warn",
      {
        allowNamedFunctions: true,
      },
    ],
    "prefer-const": [
      "warn",
      {
        destructuring: "all",
      },
    ],
    "prefer-destructuring": [
      "warn",
      {
        VariableDeclarator: {
          object: true,
        },
      },
    ],
    "prefer-object-has-own": "warn",
    "prefer-rest-params": "warn",
    "prefer-spread": "warn",
    "promise/no-multiple-resolved": "warn",
    "promise/no-nesting": "warn",
    "react/display-name": "warn",
    "react/exhaustive-deps": "warn",
    "react/hook-use-state": "warn",
    "react/iframe-missing-sandbox": "warn",
    "react/jsx-boolean-value": "warn",
    "react/jsx-curly-brace-presence": "warn",
    "react/jsx-key": "error",
    "react/jsx-no-comment-textnodes": "error",
    "react/jsx-no-duplicate-props": "error",
    "react/jsx-no-literals": "off",
    "react/jsx-no-target-blank": "error",
    "react/jsx-no-undef": "off",
    "react/jsx-no-useless-fragment": "warn",
    "react/no-children-prop": "error",
    "react/no-danger-with-children": "error",
    "react/no-direct-mutation-state": "error",
    "react/no-find-dom-node": "warn",
    "react/no-is-mounted": "warn",
    "react/no-render-return-value": "error",
    "react/no-string-refs": "warn",
    "react/no-unescaped-entities": "off",
    "react/no-unknown-property": "error",
    "react/no-unsafe": "off",
    "react/react-in-jsx-scope": "off",
    "react/rules-of-hooks": "error",
    "react/self-closing-comp": "off",
    "require-await": "off",
    "require-yield": "warn",
    "sonarjs/no-collapsible-if": "off",
    "sonarjs/no-gratuitous-expressions": "warn",
    "sonarjs/no-identical-conditions": "warn",
    "sonarjs/no-inverted-boolean-check": "warn",
    "sonarjs/no-nested-switch": "warn",
    "sonarjs/no-unused-collection": "warn",
    "sonarjs/no-use-of-empty-return-value": "warn",
    "typescript/adjacent-overload-signatures": "warn",
    "typescript/array-type": "warn",
    "typescript/ban-ts-comment": [
      "warn",
      {
        minimumDescriptionLength: 10,
      },
    ],
    "typescript/ban-tslint-comment": "warn",
    "typescript/class-literal-property-style": "warn",
    "typescript/consistent-generic-constructors": "warn",
    "typescript/consistent-indexed-object-style": "warn",
    "typescript/consistent-type-assertions": "warn",
    "typescript/no-confusing-non-null-assertion": "warn",
    "typescript/no-duplicate-enum-values": "error",
    "typescript/no-dynamic-delete": "warn",
    "typescript/no-explicit-any": "warn",
    "typescript/no-extra-non-null-assertion": "warn",
    "typescript/no-extraneous-class": "warn",
    "typescript/no-inferrable-types": "warn",
    "typescript/no-invalid-void-type": "error",
    "typescript/no-misused-new": "error",
    "typescript/no-namespace": "warn",
    "typescript/no-non-null-asserted-nullish-coalescing": "error",
    "typescript/no-non-null-asserted-optional-chain": "error",
    "typescript/no-require-imports": "warn",
    "typescript/no-this-alias": "warn",
    "typescript/no-unnecessary-type-constraint": "warn",
    "typescript/no-unsafe-declaration-merging": "error",
    "typescript/no-unsafe-function-type": "error",
    "typescript/no-wrapper-object-types": "warn",
    "typescript/prefer-as-const": "warn",
    "typescript/prefer-for-of": "warn",
    "typescript/prefer-function-type": "warn",
    "typescript/prefer-literal-enum-member": "warn",
    "typescript/prefer-namespace-keyword": "warn",
    "typescript/triple-slash-reference": "warn",
    "typescript/unified-signatures": "warn",
    /**
     * Everything tsgolint implements, which is the whole of oxlint's
     * type-aware set. The sixteen @hasparus/eslint-config already runs keep
     * the severity they have there — errors for the `no-unsafe-*` family,
     * `only-throw-error` and the type-constituent pair, warnings for the rest
     * — so a file that passes one linter passes the other. The rest default to
     * `warn` like everything above.
     *
     * Off on purpose: `typescript/require-await`, because the base turns the
     * ESLint rule of that name off and the type-aware twin says the same
     * thing. `prefer-readonly-parameter-types` and `strict-boolean-expressions`
     * are out too — measured over a real consumer they account for 349 reports
     * against idiomatic code, which buries the rules that find defects. The three TypeScript rules disabled in
     * the ESLint config — `consistent-type-definitions`, `no-empty-object-
     * type`, `no-non-null-assertion` — read syntax, not types, so none of them
     * lands in this set to begin with.
     */
    "typescript/await-thenable": "warn",
    "typescript/consistent-return": "warn",
    "typescript/consistent-type-exports": "warn",
    "typescript/dot-notation": "warn",
    "typescript/no-array-delete": "warn",
    "typescript/no-base-to-string": "warn",
    "typescript/no-confusing-void-expression": "warn",
    "typescript/no-deprecated": "warn",
    "typescript/no-duplicate-type-constituents": "error",
    /**
     * A test runner's `test`/`it`/`describe` hand back a promise nobody is
     * meant to await, and a suite of any size buries every real finding under
     * them — 94 to 1 on the repo this was measured against.
     *
     * Named as bare strings rather than `{ from: "package" }` because the
     * package form matches nothing here: tsgolint does not attribute these
     * declarations to a package, so `bun:test`, `bun-types` and `@types/bun`
     * all fail to match. The string form is deprecated upstream; when it goes,
     * the package form has to work first.
     */
    "typescript/no-floating-promises": [
      "warn",
      {
        allowForKnownSafeCalls: [
          "test",
          "it",
          "describe",
          "beforeAll",
          "beforeEach",
          "afterAll",
          "afterEach",
        ],
      },
    ],
    "typescript/no-for-in-array": "warn",
    "typescript/no-implied-eval": "error",
    "typescript/no-meaningless-void-operator": "warn",
    "typescript/no-misused-promises": "error",
    "typescript/no-misused-spread": "warn",
    "typescript/no-mixed-enums": "warn",
    "typescript/no-redundant-type-constituents": "error",
    "typescript/no-unnecessary-boolean-literal-compare": "warn",
    "typescript/no-unnecessary-condition": "warn",
    "typescript/no-unnecessary-qualifier": "warn",
    "typescript/no-unnecessary-template-expression": "warn",
    "typescript/no-unnecessary-type-arguments": "warn",
    "typescript/no-unnecessary-type-assertion": "warn",
    "typescript/no-unnecessary-type-conversion": "warn",
    "typescript/no-unnecessary-type-parameters": "warn",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-enum-comparison": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/no-unsafe-type-assertion": "warn",
    "typescript/no-unsafe-unary-minus": "warn",
    "typescript/no-useless-default-assignment": "warn",
    "typescript/non-nullable-type-assertion-style": "warn",
    "typescript/only-throw-error": "error",
    "typescript/prefer-find": "warn",
    "typescript/prefer-includes": "warn",
    "typescript/prefer-nullish-coalescing": "warn",
    "typescript/prefer-optional-chain": "warn",
    "typescript/prefer-promise-reject-errors": "warn",
    "typescript/prefer-readonly": "warn",
    "typescript/prefer-reduce-type-parameter": "warn",
    "typescript/prefer-regexp-exec": "warn",
    "typescript/prefer-return-this-type": "warn",
    "typescript/prefer-string-starts-ends-with": "warn",
    "typescript/promise-function-async": "warn",
    "typescript/related-getter-setter-pairs": "warn",
    "typescript/require-array-sort-compare": "warn",
    "typescript/require-await": "off",
    "typescript/restrict-plus-operands": "warn",
    "typescript/restrict-template-expressions": "warn",
    "typescript/return-await": "warn",
    "typescript/strict-void-return": "warn",
    "typescript/switch-exhaustiveness-check": "warn",
    "typescript/unbound-method": "warn",
    "typescript/use-unknown-in-catch-callback-variable": "warn",
    "unicorn/catch-error-name": "warn",
    "unicorn/consistent-assert": "warn",
    "unicorn/consistent-date-clone": "warn",
    "unicorn/consistent-empty-array-spread": "warn",
    "unicorn/consistent-existence-index-check": "warn",
    "unicorn/consistent-function-scoping": "warn",
    "unicorn/empty-brace-spaces": "warn",
    "unicorn/error-message": "warn",
    "unicorn/escape-case": "warn",
    "unicorn/explicit-length-check": "warn",
    "unicorn/new-for-builtins": "error",
    "unicorn/no-abusive-eslint-disable": "warn",
    "unicorn/no-accessor-recursion": "warn",
    "unicorn/no-anonymous-default-export": "warn",
    "unicorn/no-array-for-each": "warn",
    "unicorn/no-array-method-this-argument": "warn",
    "unicorn/no-array-reduce": "warn",
    "unicorn/no-array-reverse": "warn",
    "unicorn/no-await-expression-member": "warn",
    "unicorn/no-await-in-promise-methods": "error",
    "unicorn/no-console-spaces": "warn",
    "unicorn/no-document-cookie": "warn",
    "unicorn/no-empty-file": "warn",
    "unicorn/no-hex-escape": "warn",
    "unicorn/no-immediate-mutation": "warn",
    "unicorn/no-instanceof-array": "warn",
    "unicorn/no-instanceof-builtins": "warn",
    "unicorn/no-invalid-fetch-options": "error",
    "unicorn/no-invalid-remove-event-listener": "error",
    "unicorn/no-lonely-if": "warn",
    "unicorn/no-magic-array-flat-depth": "warn",
    "unicorn/no-negated-condition": "warn",
    "unicorn/no-negation-in-equality-check": "warn",
    "unicorn/no-new-array": "warn",
    "unicorn/no-new-buffer": "error",
    "unicorn/no-object-as-default-parameter": "warn",
    "unicorn/no-process-exit": "warn",
    "unicorn/no-single-promise-in-promise-methods": "warn",
    "unicorn/no-static-only-class": "warn",
    "unicorn/no-thenable": "error",
    "unicorn/no-this-assignment": "warn",
    "unicorn/no-typeof-undefined": "warn",
    "unicorn/no-unnecessary-array-flat-depth": "warn",
    "unicorn/no-unnecessary-array-splice-count": "warn",
    "unicorn/no-unnecessary-await": "warn",
    "unicorn/no-unnecessary-slice-end": "warn",
    "unicorn/no-unreadable-array-destructuring": "warn",
    "unicorn/no-unreadable-iife": "warn",
    "unicorn/no-useless-collection-argument": "warn",
    "unicorn/no-useless-error-capture-stack-trace": "warn",
    "unicorn/no-useless-fallback-in-spread": "warn",
    "unicorn/no-useless-length-check": "warn",
    "unicorn/no-useless-promise-resolve-reject": "warn",
    "unicorn/no-useless-spread": "warn",
    "unicorn/no-useless-switch-case": "warn",
    "unicorn/no-useless-undefined": "warn",
    "unicorn/no-zero-fractions": "warn",
    "unicorn/number-literal-case": "warn",
    "unicorn/numeric-separators-style": "warn",
    "unicorn/prefer-add-event-listener": "warn",
    "unicorn/prefer-array-find": "warn",
    "unicorn/prefer-array-flat": "warn",
    "unicorn/prefer-array-flat-map": "warn",
    "unicorn/prefer-array-index-of": "warn",
    "unicorn/prefer-array-some": "warn",
    "unicorn/prefer-at": "warn",
    "unicorn/prefer-bigint-literals": "warn",
    "unicorn/prefer-blob-reading-methods": "warn",
    "unicorn/prefer-class-fields": "warn",
    "unicorn/prefer-classlist-toggle": "warn",
    "unicorn/prefer-code-point": "warn",
    "unicorn/prefer-date-now": "warn",
    "unicorn/prefer-default-parameters": "warn",
    "unicorn/prefer-dom-node-append": "warn",
    "unicorn/prefer-dom-node-dataset": "warn",
    "unicorn/prefer-dom-node-remove": "warn",
    "unicorn/prefer-dom-node-text-content": "warn",
    "unicorn/prefer-event-target": "warn",
    "unicorn/prefer-export-from": "warn",
    "unicorn/prefer-global-this": "warn",
    "unicorn/prefer-includes": "warn",
    "unicorn/prefer-keyboard-event-key": "warn",
    "unicorn/prefer-logical-operator-over-ternary": "warn",
    "unicorn/prefer-math-min-max": "warn",
    "unicorn/prefer-math-trunc": "warn",
    "unicorn/prefer-modern-dom-apis": "warn",
    "unicorn/prefer-modern-math-apis": "warn",
    "unicorn/prefer-module": "warn",
    "unicorn/prefer-native-coercion-functions": "warn",
    "unicorn/prefer-negative-index": "warn",
    "unicorn/prefer-node-protocol": "warn",
    "unicorn/prefer-number-properties": "warn",
    "unicorn/prefer-object-from-entries": "warn",
    "unicorn/prefer-optional-catch-binding": "warn",
    "unicorn/prefer-prototype-methods": "warn",
    "unicorn/prefer-reflect-apply": "warn",
    "unicorn/prefer-regexp-test": "warn",
    "unicorn/prefer-response-static-json": "warn",
    "unicorn/prefer-set-has": "warn",
    "unicorn/prefer-set-size": "warn",
    "unicorn/prefer-single-call": "warn",
    "unicorn/prefer-spread": "warn",
    "unicorn/prefer-string-raw": "warn",
    "unicorn/prefer-string-replace-all": "warn",
    "unicorn/prefer-string-slice": "warn",
    "unicorn/prefer-string-starts-ends-with": "warn",
    "unicorn/prefer-string-trim-start-end": "warn",
    "unicorn/prefer-structured-clone": "warn",
    "unicorn/prefer-ternary": "warn",
    "unicorn/prefer-top-level-await": "warn",
    "unicorn/prefer-type-error": "warn",
    "unicorn/relative-url-style": "warn",
    "unicorn/require-array-join-separator": "warn",
    "unicorn/require-module-attributes": "warn",
    "unicorn/require-module-specifiers": "warn",
    "unicorn/require-number-to-fixed-digits-argument": "warn",
    "unicorn/text-encoding-identifier-case": "warn",
    "unicorn/throw-new-error": "warn",
    "use-isnan": "error",
    "valid-typeof": "error",
    yoda: "warn",
  },
});
