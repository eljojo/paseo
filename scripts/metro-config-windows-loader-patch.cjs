const fs = require("fs");
const path = require("path");
const Module = require("module");

const metroPackageRoot = path.dirname(require.resolve("metro-config/package.json"));
const metroLoadConfigPath = path.join(metroPackageRoot, "src", "loadConfig.js");
const originalJsLoader = Module._extensions[".js"];

Module._extensions[".js"] = function patchedMetroConfigLoader(module, filename) {
  if (filename === metroLoadConfigPath) {
    let source = fs.readFileSync(filename, "utf8");
    source = source.replace(
      "const configModule = await import(absolutePath);",
      "const { pathToFileURL } = require('node:url');\n        const configModule = await import(pathToFileURL(absolutePath).href);",
    );
    return module._compile(source, filename);
  }

  return originalJsLoader(module, filename);
};
