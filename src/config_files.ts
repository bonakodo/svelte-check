import { dirname, isAbsolute, join, resolve } from "@std/path";

/** Resolve config files without loading Node or the TypeScript compiler. */
export async function configFile(path: string): Promise<string | undefined> {
  for (const candidate of [path, `${path}.json`, join(path, "tsconfig.json")]) {
    try {
      if ((await Deno.stat(candidate)).isFile) return candidate;
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) &&
        !(error instanceof Deno.errors.NotADirectory)
      ) throw error;
    }
  }
}

export async function resolveConfigParent(
  base: string,
  parent: string,
): Promise<string> {
  if (parent.startsWith(".") || isAbsolute(parent)) {
    const found = await configFile(resolve(base, parent));
    if (found) return found;
  } else {
    const parts = parent.split("/");
    const packageParts = parent.startsWith("@") ? 2 : 1;
    const packageName = parts.slice(0, packageParts).join("/");
    const subpath = parts.slice(packageParts).join("/");
    for (let directory = base;; directory = dirname(directory)) {
      const packageDirectory = join(directory, "node_modules", packageName);
      let entry = subpath || "tsconfig.json";
      if (!subpath) {
        try {
          const manifest = JSON.parse(
            await Deno.readTextFile(join(packageDirectory, "package.json")),
          );
          if (typeof manifest.tsconfig === "string") entry = manifest.tsconfig;
        } catch (error) {
          if (
            !(error instanceof Deno.errors.NotFound) &&
            !(error instanceof Deno.errors.NotADirectory)
          ) throw error;
        }
      }
      // Kit 3 writes $app/tsconfig.json and $app/tsconfig/service-worker.json.
      const found = await configFile(join(packageDirectory, entry));
      if (found) return found;
      if (dirname(directory) === directory) break;
    }
  }
  throw new Error(
    `Cannot resolve extended configuration ${
      JSON.stringify(parent)
    } from ${base}`,
  );
}
