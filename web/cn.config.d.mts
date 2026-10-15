// cn.config.mjs's shape, for the test that checks it against index.css (src/lib/utils.test.ts)
declare const config: {
  readonly extend: {
    readonly classGroups: Readonly<Record<string, readonly string[]>>;
    readonly theme: { readonly radius: readonly string[]; readonly text: readonly string[] };
  };
};
export default config;
