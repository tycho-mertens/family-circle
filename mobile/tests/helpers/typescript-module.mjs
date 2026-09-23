import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
};

const syntheticModule = (exports, context, identifier) =>
  new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context, identifier },
  );

/**
 * Loads the real TypeScript source without asking Node to understand the app's
 * React Native toolchain. Keeping this little VM adapter in one place makes the
 * tests read like tests instead of miniature bundlers.
 */
export async function loadTypeScriptModule(entry, { globals = {}, mocks = {} } = {}) {
  const context = vm.createContext({
    TextEncoder,
    TextDecoder,
    Uint8Array,
    URL,
    console,
    ...globals,
  });
  const modules = new Map();

  async function load(fileOrMock, parentUrl) {
    if (Object.hasOwn(mocks, fileOrMock)) {
      const key = `mock:${fileOrMock}`;
      if (!modules.has(key))
        modules.set(key, syntheticModule(mocks[fileOrMock], context, key));
      return modules.get(key);
    }

    let url = parentUrl
      ? new URL(fileOrMock, parentUrl)
      : pathToFileURL(resolve(mobileRoot, fileOrMock));
    if (parentUrl && !/\.tsx?$/.test(url.pathname)) {
      url = new URL(
        existsSync(fileURLToPath(`${url.href}.ts`))
          ? `${url.href}.ts`
          : `${url.href}.tsx`,
      );
    }
    const key = url.href;
    if (modules.has(key)) return modules.get(key);

    const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions,
      fileName: fileURLToPath(url),
    }).outputText;
    const module = new vm.SourceTextModule(source, { context, identifier: key });
    modules.set(key, module);
    return module;
  }

  const module = await load(entry);
  await module.link((specifier, parent) => load(specifier, parent.identifier));
  await module.evaluate();
  return module.namespace;
}
