/** A dependency-free client for the checker bundled with `deno lsp`. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: Array<{
    location: { uri: string; range: LspRange };
    message: string;
  }>;
  tags?: number[];
  data?: unknown;
}

export interface DenoLspOptions {
  root: string;
  config?: string;
  /** Supplemental import map; Deno keeps a project's own map in preference. */
  importMap?: string;
  /** Additional Deno feature flags, merged with the project's own flags. */
  unstable?: string[];
  denoPath?: string;
  /** Maximum time for one request, write, or shutdown. Defaults to 30 seconds. */
  timeoutMs?: number;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const encoder = new TextEncoder();
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function directoryUrl(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  const encoded = encodeURI(normalized).replaceAll("#", "%23").replaceAll(
    "?",
    "%3F",
  );
  return new URL(`file://${normalized.startsWith("/") ? "" : "/"}${encoded}/`)
    .href;
}

/**
 * Open transformed source with languageId `typescript` at its original file URL.
 * The server then resolves imports against those buffers and the project config.
 */
export class DenoLsp {
  readonly #child: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #timeoutMs: number;
  readonly #settings: Record<string, unknown>;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #documents = new Map<
    string,
    { version: number; languageId: string }
  >();
  readonly #stdoutTask: Promise<void>;
  readonly #stderrTask: Promise<void>;
  readonly #statusTask: Promise<Deno.CommandStatus>;
  #writeTail: Promise<void> = Promise.resolve();
  #nextId = 1;
  #stderr = "";
  #failure?: Error;
  #closing = false;
  #exited = false;
  #closeTask?: Promise<void>;

  private constructor(
    child: Deno.ChildProcess,
    timeoutMs: number,
    settings: Record<string, unknown>,
  ) {
    this.#child = child;
    this.#writer = child.stdin.getWriter();
    this.#timeoutMs = timeoutMs;
    this.#settings = settings;
    this.#stderrTask = this.#readStderr().catch((error) => {
      this.#fail(
        new Error(`Cannot read Deno LSP stderr: ${asError(error).message}`),
      );
    });
    this.#stdoutTask = this.#readStdout().catch((error) => {
      this.#fail(
        new Error(`Invalid Deno LSP output: ${asError(error).message}`),
      );
    });
    this.#statusTask = child.status.then(async (status) => {
      this.#exited = true;
      await this.#stderrTask;
      if (!this.#closing) {
        this.#fail(
          new Error(
            `Deno LSP exited unexpectedly (code ${status.code}${
              status.signal ? `, ${status.signal}` : ""
            })`,
          ),
        );
      }
      return status;
    }, (error) => {
      this.#exited = true;
      this.#fail(
        new Error(`Cannot wait for Deno LSP: ${asError(error).message}`),
      );
      return { success: false, code: -1, signal: null };
    });
  }

  static async start(options: DenoLspOptions): Promise<DenoLsp> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Deno LSP timeoutMs must be a positive finite number");
    }
    // Preserve symlink spelling so caller-supplied document URLs remain inside
    // the same workspace. macOS temp paths commonly use a /var symlink.
    const root =
      options.root.startsWith("/") || /^[a-z]:[\\/]/i.test(options.root)
        ? options.root
        : `${Deno.cwd()}/${options.root}`;
    if (!(await Deno.stat(root)).isDirectory) {
      throw new Error(`LSP root is not a directory: ${root}`);
    }
    const rootUri = directoryUrl(root);
    const settings: Record<string, unknown> = { enable: true, lint: false };
    if (options.unstable) settings.unstable = options.unstable;
    if (options.importMap) {
      settings.importMap = /^[a-z][a-z0-9+.-]*:/i.test(options.importMap)
        ? options.importMap
        : new URL(options.importMap, rootUri).href;
    }
    if (options.config !== undefined) {
      const config = options.config;
      settings.config = await Deno.realPath(
        config.startsWith("file:")
          ? new URL(config)
          : config.startsWith("/") || /^[a-z]:[\\/]/i.test(config)
          ? config
          : `${root}/${config}`,
      );
    }
    const child = new Deno.Command(options.denoPath ?? Deno.execPath(), {
      args: ["lsp"],
      cwd: root,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const client = new DenoLsp(child, timeoutMs, settings);
    try {
      const result = await client.#request<{
        capabilities?: { diagnosticProvider?: unknown };
      }>("initialize", {
        processId: Deno.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: root.split(/[\\/]/).at(-1) }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: { diagnostic: { relatedDocumentSupport: true } },
        },
        initializationOptions: settings,
      });
      if (!result?.capabilities?.diagnosticProvider) {
        throw new Error(
          "Deno LSP does not support textDocument/diagnostic; use a Deno release with pull diagnostics",
        );
      }
      await client.#notify("initialized", {});
      return client;
    } catch (error) {
      client.#fail(asError(error));
      await client.close();
      throw client.#failure;
    }
  }

  async open(
    uri: string,
    text: string,
    languageId = "typescript",
  ): Promise<void> {
    this.#assertOpen();
    const existing = this.#documents.get(uri);
    if (existing) {
      if (existing.languageId !== languageId) {
        throw new Error(`Cannot change an open document's language: ${uri}`);
      }
      return await this.change(uri, text);
    }
    this.#documents.set(uri, { version: 1, languageId });
    await this.#notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  async change(uri: string, text: string): Promise<void> {
    this.#assertOpen();
    const document = this.#documents.get(uri);
    if (!document) throw new Error(`Document is not open: ${uri}`);
    const version = ++document.version;
    await this.#notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  async diagnostics(uri: string): Promise<LspDiagnostic[]> {
    this.#assertOpen();
    const report = await this.#request<
      { kind?: string; items?: LspDiagnostic[] }
    >(
      "textDocument/diagnostic",
      { textDocument: { uri } },
    );
    if (report?.kind !== "full" || !Array.isArray(report.items)) {
      throw new Error(
        `Deno LSP returned an invalid diagnostic report for ${uri}`,
      );
    }
    return report.items;
  }

  /** Cache imports using open buffers, including virtual component sources. */
  async cache(uri: string): Promise<void> {
    this.#assertOpen();
    await this.#request("workspace/executeCommand", {
      command: "deno.cache",
      arguments: [[], uri, { forceGlobalCache: false }],
    });
  }

  /** Idempotent cleanup. A failed session is killed without hiding its first error. */
  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    this.#closing = true;
    try {
      if (!this.#failure && !this.#exited) {
        await this.#request("shutdown");
        await this.#notify("exit");
        await this.#bounded(this.#writer.close(), "closing stdin");
        await this.#bounded(this.#statusTask, "waiting for shutdown");
      }
    } catch (error) {
      this.#fail(asError(error));
    } finally {
      if (!this.#exited) this.#kill();
      await this.#statusTask;
      await Promise.all([this.#stdoutTask, this.#stderrTask]);
      try {
        await this.#writer.abort();
      } catch { /* The pipe may already be closed. */ }
      this.#writer.releaseLock();
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(this.#failure ?? new Error("Deno LSP closed"));
      }
      this.#pending.clear();
    }
  }

  #assertOpen(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closing || this.#exited) throw new Error("Deno LSP is closed");
  }

  #kill(): void {
    try {
      this.#child.kill("SIGKILL");
    } catch { /* The process may already be gone. */ }
  }

  #fail(error: Error): Error {
    if (!this.#failure) {
      this.#failure = new Error(
        `${error.message}${
          this.#stderr ? `\nDeno LSP stderr:\n${this.#stderr.trim()}` : ""
        }`,
        { cause: error },
      );
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(this.#failure);
      }
      this.#pending.clear();
      if (!this.#exited) this.#kill();
    }
    return this.#failure;
  }

  async #bounded<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              this.#fail(
                new Error(
                  `Deno LSP timed out after ${this.#timeoutMs}ms while ${label}`,
                ),
              ),
            );
          }, this.#timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #write(message: RpcMessage): Promise<void> {
    const operation = this.#writeTail.then(async () => {
      if (this.#failure) throw this.#failure;
      const body = encoder.encode(
        JSON.stringify({ jsonrpc: "2.0", ...message }),
      );
      const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
      const frame = new Uint8Array(header.length + body.length);
      frame.set(header);
      frame.set(body, header.length);
      await this.#writer.write(frame);
    });
    this.#writeTail = operation.catch(() => {});
    try {
      await this.#bounded(operation, `writing ${message.method ?? "response"}`);
    } catch (error) {
      throw this.#fail(asError(error));
    }
  }

  #notify(method: string, params?: unknown): Promise<void> {
    return this.#write({ method, params });
  }

  #request<T>(method: string, params?: unknown): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(
          new Error(
            `Deno LSP timed out after ${this.#timeoutMs}ms waiting for ${method}`,
          ),
        );
      }, this.#timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      void this.#write({ id, method, params }).catch((error) =>
        this.#fail(asError(error))
      );
    });
  }

  async #readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.#child.stderr) {
      this.#stderr = (this.#stderr + decoder.decode(chunk, { stream: true }))
        .slice(-MAX_STDERR_CHARS);
    }
    this.#stderr = (this.#stderr + decoder.decode()).slice(-MAX_STDERR_CHARS);
  }

  async #readStdout(): Promise<void> {
    let buffered: Uint8Array = new Uint8Array();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const chunk of this.#child.stdout) {
      const combined = new Uint8Array(buffered.length + chunk.length);
      combined.set(buffered);
      combined.set(chunk, buffered.length);
      buffered = combined;
      for (;;) {
        let headerEnd = -1;
        for (let index = 0; index + 3 < buffered.length; index++) {
          if (
            buffered[index] === 13 && buffered[index + 1] === 10 &&
            buffered[index + 2] === 13 && buffered[index + 3] === 10
          ) {
            headerEnd = index;
            break;
          }
        }
        if (headerEnd < 0) {
          if (buffered.length > MAX_HEADER_BYTES) {
            throw new Error("LSP header is too large");
          }
          break;
        }
        if (headerEnd > MAX_HEADER_BYTES) {
          throw new Error("LSP header is too large");
        }
        const header = decoder.decode(buffered.subarray(0, headerEnd));
        const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
        if (lengths.length !== 1) {
          throw new Error("Expected exactly one Content-Length header");
        }
        const length = Number(lengths[0][1]);
        if (!Number.isSafeInteger(length) || length > MAX_MESSAGE_BYTES) {
          throw new Error("LSP message is too large");
        }
        const end = headerEnd + 4 + length;
        if (buffered.length < end) break;
        const message: unknown = JSON.parse(
          decoder.decode(buffered.subarray(headerEnd + 4, end)),
        );
        buffered = buffered.subarray(end);
        if (
          typeof message !== "object" || message === null ||
          Array.isArray(message)
        ) throw new Error("Expected an LSP message object");
        this.#handle(message as RpcMessage);
      }
    }
    if (buffered.length && !this.#closing && !this.#failure) {
      throw new Error("Deno LSP ended in the middle of a frame");
    }
  }

  #handle(message: RpcMessage): void {
    if (message.method) {
      if (message.id === undefined || message.id === null) return;
      let response: RpcMessage;
      if (message.method === "workspace/configuration") {
        const items = (message.params as { items?: unknown[] } | undefined)
          ?.items;
        response = {
          id: message.id,
          result: Array.isArray(items) ? items.map(() => this.#settings) : [],
        };
      } else {
        response = {
          id: message.id,
          error: {
            code: -32601,
            message: `Method not supported: ${message.method}`,
          },
        };
      }
      void this.#write(response).catch((error) => this.#fail(asError(error)));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(
          `Deno LSP error ${message.error.code}: ${message.error.message}${
            this.#stderr ? `\nDeno LSP stderr:\n${this.#stderr.trim()}` : ""
          }`,
        ),
      );
    } else pending.resolve(message.result);
  }
}
