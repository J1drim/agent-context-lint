import { parentPort, workerData } from "node:worker_threads";

interface ArtifactWorkerData {
  readonly artifact: ArrayBuffer;
  readonly input: ArrayBuffer;
  readonly mode: "artifact";
}

interface InstalledWorkerData {
  readonly input: ArrayBuffer;
  readonly mode: "installed";
  readonly providerId: string;
  readonly resolutionBaseUrl: string;
}

type ExactWorkerData = ArtifactWorkerData | InstalledWorkerData;

type ExactWorkerResult =
  | { readonly ok: true; readonly tokens: number }
  | { readonly code: "failed" | "invalid" | "unavailable"; readonly ok: false };

interface WasmModuleDescription {
  readonly kind: string;
  readonly module?: string;
  readonly name: string;
}

interface WasmMemory {
  readonly buffer: ArrayBuffer;
}

interface WasmApi {
  readonly Memory: new (descriptor: {
    readonly initial: number;
    readonly maximum: number;
  }) => WasmMemory;
  readonly Module: {
    exports(module: unknown): readonly WasmModuleDescription[];
    imports(module: unknown): readonly WasmModuleDescription[];
  };
  compile(bytes: ArrayBuffer): Promise<unknown>;
  instantiate(
    module: unknown,
    imports: { readonly env: { readonly memory: WasmMemory } },
  ): Promise<{ readonly exports: Readonly<Record<string, unknown>> }>;
}

const WASM = (globalThis as unknown as { readonly WebAssembly: WasmApi }).WebAssembly;

function fail(code: "failed" | "invalid" | "unavailable" = "failed"): void {
  parentPort?.postMessage({ code, ok: false } satisfies ExactWorkerResult);
}

async function run(): Promise<void> {
  if (parentPort === null) return;
  const data = workerData as Partial<ExactWorkerData> | null;
  if (
    data === null ||
    typeof data !== "object" ||
    (data.mode !== "artifact" && data.mode !== "installed") ||
    !(data.input instanceof ArrayBuffer)
  ) {
    fail();
    return;
  }

  try {
    let artifact: ArrayBuffer;
    if (data.mode === "installed") {
      if (typeof data.providerId !== "string" || typeof data.resolutionBaseUrl !== "string") {
        fail();
        return;
      }
      const hostSpecifier = import.meta.url.endsWith(".ts")
        ? "./exact-tokenizer-artifact.ts"
        : "./exact-tokenizer-artifact.js";
      const host = (await import(hostSpecifier)) as {
        readonly loadExactTokenizerArtifact?: (
          providerId: string,
          resolutionBaseUrl: string,
        ) => Promise<
          | { readonly artifact: ArrayBuffer; readonly status: "available" }
          | { readonly status: "invalid" | "unavailable" }
        >;
      };
      if (typeof host.loadExactTokenizerArtifact !== "function") {
        fail();
        return;
      }
      const loaded = await host.loadExactTokenizerArtifact(data.providerId, data.resolutionBaseUrl);
      if (loaded.status !== "available") {
        fail(loaded.status);
        return;
      }
      artifact = loaded.artifact;
    } else {
      const artifactValue = Object.getOwnPropertyDescriptor(data, "artifact")?.value as unknown;
      if (!(artifactValue instanceof ArrayBuffer)) {
        fail();
        return;
      }
      artifact = artifactValue;
    }

    const module = await WASM.compile(artifact);
    const imports = WASM.Module.imports(module);
    const exports = WASM.Module.exports(module);
    if (
      imports.length !== 1 ||
      imports[0]?.kind !== "memory" ||
      imports[0].module !== "env" ||
      imports[0].name !== "memory" ||
      exports.length !== 1 ||
      exports[0]?.kind !== "function" ||
      exports[0].name !== "count"
    ) {
      fail();
      return;
    }

    const pages = Math.max(1, Math.ceil(data.input.byteLength / 65_536));
    const memory = new WASM.Memory({ initial: pages, maximum: 257 });
    new Uint8Array(memory.buffer, 0, data.input.byteLength).set(new Uint8Array(data.input));
    const instance = await WASM.instantiate(module, { env: { memory } });
    const count = instance.exports["count"];
    if (typeof count !== "function") {
      fail();
      return;
    }
    const tokens: unknown = Reflect.apply(count, undefined, [0, data.input.byteLength]);
    if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) {
      fail();
      return;
    }
    parentPort.postMessage({ ok: true, tokens } satisfies ExactWorkerResult);
  } catch {
    fail();
  }
}

await run();
