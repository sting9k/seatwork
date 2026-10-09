// Lets `node --test` load the plugin's TypeScript the way Paseo's bundler does: imports without an extension.
const { registerHooks } = require("node:module");
const { readFileSync } = require("node:fs");
const { fileURLToPath } = require("node:url");
const ts = require("typescript");

registerHooks({
  resolve(specifier, context, nextResolve) {
    const local = specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier);
    return nextResolve(local ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".ts")) return nextLoad(url, context);
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, inlineSourceMap: true },
    });
    return { format: "commonjs", source: outputText, shortCircuit: true };
  },
});
