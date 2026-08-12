import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith("file:") === true &&
      specifier.startsWith(".") &&
      specifier.endsWith(".js")
    ) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
