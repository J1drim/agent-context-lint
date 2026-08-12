import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createNodeWritableOutput, runProcessCli } from "../src/process-cli.js";

import type { CallbackWritable, ProcessCliHost, SigintSource } from "../src/process-cli.js";

class FakeSigintSource implements SigintSource {
  public readonly listeners = new Set<() => void>();

  public addListener(listener: () => void): void {
    this.listeners.add(listener);
  }

  public emit(): void {
    for (const listener of this.listeners) listener();
  }

  public removeListener(listener: () => void): void {
    this.listeners.delete(listener);
  }
}

class FakeWritable extends EventEmitter implements CallbackWritable {
  readonly #implementation: (
    emitter: EventEmitter,
    callback: (error?: Error | null) => void,
  ) => void;

  public constructor(
    implementation: (emitter: EventEmitter, callback: (error?: Error | null) => void) => void,
  ) {
    super();
    this.#implementation = implementation;
  }

  public write(text: string, callback: (error?: Error | null) => void): boolean {
    void text;
    this.#implementation(this, callback);
    return true;
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createHost(
  argv: readonly string[],
  events: string[] = [],
): { readonly host: ProcessCliHost; readonly sigint: FakeSigintSource } {
  const sigint = new FakeSigintSource();
  return {
    host: {
      argv,
      setExitCode: (code): void => {
        events.push(`exit:${String(code)}`);
      },
      sigint,
      stderr: {
        write: async (): Promise<void> => {
          await Promise.resolve();
          events.push("stderr");
        },
      },
      stdout: {
        write: async (): Promise<void> => {
          await Promise.resolve();
          events.push("stdout");
        },
      },
    },
    sigint,
  };
}

describe("process CLI boundary", () => {
  it("awaits output, removes its SIGINT listener, and only then sets exitCode", async () => {
    const events: string[] = [];
    const { host, sigint } = createHost([], events);

    const result = await runProcessCli(host);

    expect(result.exitCode).toBe(0);
    expect(events).toEqual(["stdout", "exit:0"]);
    expect(sigint.listeners.size).toBe(0);
  });

  it("maps first and repeated SIGINT to conventional exit 130", async () => {
    const events: string[] = [];
    const { host, sigint } = createHost(["scan"], events);
    const started = deferred();
    const running = runProcessCli(host, {
      scan: ({ signal }) =>
        new Promise((resolve) => {
          started.resolve();
          signal.addEventListener(
            "abort",
            () => {
              resolve({ status: "success" });
            },
            { once: true },
          );
        }),
    });
    await started.promise;
    sigint.emit();
    sigint.emit();

    expect(await running).toEqual({ exitCode: 130, operationalError: null });
    expect(events).toEqual(["exit:130"]);
    expect(sigint.listeners.size).toBe(0);
  });

  it("removes its listener after handler rejection and operational failure", async () => {
    const events: string[] = [];
    const { host, sigint } = createHost(["scan"], events);
    const result = await runProcessCli(host, {
      scan: () => Promise.reject(new Error("untrusted")),
    });

    expect(result.exitCode).toBe(2);
    expect(events).toEqual(["stderr", "exit:2"]);
    expect(sigint.listeners.size).toBe(0);
  });

  it("returns exit 2 if signal installation or removal fails", async () => {
    const installEvents: string[] = [];
    const install = createHost([], installEvents).host;
    const removeEvents: string[] = [];
    const remove = createHost([], removeEvents).host;
    const installFailure: ProcessCliHost = {
      ...install,
      sigint: {
        addListener: () => {
          throw new Error("secret");
        },
        removeListener: vi.fn(),
      },
    };
    const removalFailure: ProcessCliHost = {
      ...remove,
      sigint: {
        addListener: vi.fn(),
        removeListener: () => {
          throw new Error("secret");
        },
      },
    };

    expect((await runProcessCli(installFailure)).exitCode).toBe(2);
    expect((await runProcessCli(removalFailure)).exitCode).toBe(2);
    expect(installEvents).toEqual(["exit:2"]);
    expect(removeEvents.at(-1)).toBe("exit:2");
  });
});

describe("Node writable adapter", () => {
  function writable(
    implementation: (emitter: EventEmitter, callback: (error?: Error | null) => void) => void,
  ): CallbackWritable & EventEmitter {
    return new FakeWritable(implementation);
  }

  it("resolves callback writes and removes its temporary error listener", async () => {
    const signal = new AbortController().signal;
    const stream = writable((_emitter, callback) => {
      callback();
    });

    await expect(createNodeWritableOutput(stream).write("ok", signal)).resolves.toBeUndefined();
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("rejects callback, event, and synchronous stream failures without leaking listeners", async () => {
    const signal = new AbortController().signal;
    const callback = writable((_emitter, done) => {
      done(new Error("callback"));
    });
    const event = writable((emitter) => {
      emitter.emit("error", new Error("event"));
    });
    const synchronous = writable(() => {
      throw new Error("sync");
    });
    const hostile = writable((emitter) => {
      emitter.emit("error", { secret: "not-an-error" });
    });

    await expect(createNodeWritableOutput(callback).write("x", signal)).rejects.toThrow(
      "stream write failed",
    );
    await expect(createNodeWritableOutput(event).write("x", signal)).rejects.toThrow(
      "stream write failed",
    );
    await expect(createNodeWritableOutput(synchronous).write("x", signal)).rejects.toThrow(
      "stream write failed",
    );
    await expect(createNodeWritableOutput(hostile).write("x", signal)).rejects.toThrow(
      "stream write failed",
    );
    expect(callback.listenerCount("error")).toBe(0);
    expect(event.listenerCount("error")).toBe(0);
    expect(synchronous.listenerCount("error")).toBe(0);
    expect(hostile.listenerCount("error")).toBe(0);
  });

  it("contains hostile listener registration and cleanup failures", async () => {
    const signal = new AbortController().signal;
    const registration: CallbackWritable = {
      off: vi.fn(),
      once: () => {
        throw new Error("registration secret");
      },
      write: vi.fn(() => true),
    };
    const cleanup: CallbackWritable = {
      off: () => {
        throw new Error("cleanup secret");
      },
      once: vi.fn(),
      write: (_text, callback): boolean => {
        callback();
        callback(new Error("late secret"));
        return true;
      },
    };

    await expect(createNodeWritableOutput(registration).write("x", signal)).rejects.toThrow(
      "stream write failed",
    );
    await expect(createNodeWritableOutput(cleanup).write("x", signal)).resolves.toBeUndefined();
    expect(registration.write).not.toHaveBeenCalled();
  });

  it("rejects an invalid AbortSignal brand before stream access", async () => {
    const stream = writable(() => {
      throw new Error("must not run");
    });
    const forgedSignal = Object.create(AbortSignal.prototype) as AbortSignal;

    await expect(createNodeWritableOutput(stream).write("ignored", forgedSignal)).rejects.toThrow(
      "stream write failed",
    );
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("settles a non-callbacking write on abort and removes its stream error listener", async () => {
    const controller = new AbortController();
    const stream = writable(() => undefined);
    const writing = createNodeWritableOutput(stream).write("pending", controller.signal);
    expect(stream.listenerCount("error")).toBe(1);

    controller.abort();

    await expect(writing).rejects.toThrow("stream write failed");
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("rejects a pre-aborted write before touching the stream", async () => {
    const controller = new AbortController();
    controller.abort();
    const write = vi.fn();
    const stream = writable(() => {
      write();
    });

    await expect(
      createNodeWritableOutput(stream).write("ignored", controller.signal),
    ).rejects.toThrow("stream write failed");
    expect(write).not.toHaveBeenCalled();
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("rejects an abort that races stream-listener installation before writing", async () => {
    const controller = new AbortController();
    const off = vi.fn();
    const write = vi.fn(() => true);
    const stream: CallbackWritable = {
      off,
      once: vi.fn(() => {
        controller.abort();
        return stream;
      }),
      write,
    };

    await expect(
      createNodeWritableOutput(stream).write("ignored", controller.signal),
    ).rejects.toThrow("stream write failed");
    expect(write).not.toHaveBeenCalled();
    expect(off).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledWith("error", expect.any(Function));
  });
});
