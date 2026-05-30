import { DocumentStore } from "./documents.ts";
import { hoverAt } from "./hover.ts";
import { decodeMessages, encodeMessage, type RpcMessage } from "./rpc.ts";
import { validateUri } from "./validation.ts";

const documents = new DocumentStore();
const publishedDiagnostics = new Map<string, string>();
let editValidationTimer: ReturnType<typeof setTimeout> | undefined;
let isShutdown = false;
let writeChain: Promise<void> = Promise.resolve();

if (import.meta.main) await runServer();

export async function runServer() {
  log("server start");
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for await (const chunk of Deno.stdin.readable) {
    buffer = concat(buffer, chunk);
    const decoded = decodeMessages(buffer);
    buffer = decoded.rest;
    for (const message of decoded.messages) {
      const started = Date.now();
      log("recv", summarize(message));
      try {
        await handleMessage(message);
        log("done", summarize(message), `${Date.now() - started}ms`);
      } catch (error) {
        log("error", summarize(message), showError(error));
        await respondError(message.id, -32603, showError(error));
      }
    }
  }
  log("server stop");
}

async function handleMessage(message: RpcMessage) {
  if (message.method === "initialize") {
    await respond(message.id, {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 1,
          save: true,
        },
        hoverProvider: true,
      },
      serverInfo: { name: "wm-mini-lsp", version: "0.0.1" },
    });
    return;
  }
  if (message.method === "shutdown") {
    isShutdown = true;
    await respond(message.id, null);
    return;
  }
  if (message.method === "exit") Deno.exit(isShutdown ? 0 : 1);
  if (message.method === "textDocument/didOpen") {
    const params = message.params as DidOpenParams;
    documents.open(params.textDocument.uri, params.textDocument.text, params.textDocument.version);
    await publishValidation(params.textDocument.uri);
    return;
  }
  if (message.method === "textDocument/didChange") {
    const params = message.params as DidChangeParams;
    const text = params.contentChanges.at(-1)?.text;
    if (text === undefined) return;
    documents.change(params.textDocument.uri, text, params.textDocument.version);
    await debounceValidation(params.textDocument.uri);
    return;
  }
  if (message.method === "textDocument/didSave") {
    const params = message.params as DidSaveParams;
    await publishValidation(params.textDocument.uri);
    return;
  }
  if (message.method === "textDocument/hover") {
    const params = message.params as HoverParams;
    const hover = await hoverAt(params.textDocument.uri, params.position, documents.sourceOverrides());
    log(
      "hover result",
      `id=${String(message.id ?? "-")}`,
      hover ? "has-contents" : "null",
    );
    await respond(
      message.id,
      hover,
    );
    return;
  }
  if (message.method === "textDocument/didClose") {
    const params = message.params as DidCloseParams;
    documents.close(params.textDocument.uri);
    publishedDiagnostics.delete(params.textDocument.uri);
    await notify("textDocument/publishDiagnostics", {
      uri: params.textDocument.uri,
      diagnostics: [],
    });
    return;
  }
  if (message.method === "workspace/didChangeWatchedFiles") {
    await Promise.all(documents.uris().map((uri) => publishValidation(uri)));
  }
}

async function publishValidation(uri: string) {
  const started = Date.now();
  log("validate start", uri);
  const results = await validateUri(uri, documents.sourceOverrides());
  await Promise.all(
    results.map((result) => publishDiagnostics(result.uri, result.diagnostics)),
  );
  log("validate done", uri, `${Date.now() - started}ms`, `results=${results.length}`);
}

async function debounceValidation(uri: string): Promise<void> {
  if (editValidationTimer !== undefined) clearTimeout(editValidationTimer);
  await new Promise<void>((resolve) => {
    editValidationTimer = setTimeout(() => resolve(), 75);
  });
  editValidationTimer = undefined;
  await publishValidation(uri);
}

async function publishDiagnostics(uri: string, diagnostics: unknown[]) {
  const fingerprint = JSON.stringify(diagnostics);
  if (publishedDiagnostics.get(uri) === fingerprint) return;
  publishedDiagnostics.set(uri, fingerprint);
  log("publish diagnostics", uri, `count=${diagnostics.length}`);
  await notify("textDocument/publishDiagnostics", { uri, diagnostics });
}

async function respond(id: RpcMessage["id"], result: unknown) {
  if (id === undefined) return;
  log("send result", `id=${String(id)}`);
  await write({ jsonrpc: "2.0", id, result });
}

async function respondError(id: RpcMessage["id"], code: number, message: string) {
  if (id === undefined) return;
  log("send error", `id=${String(id)}`, `code=${code}`, message);
  await write({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

async function notify(method: string, params: unknown) {
  log("send notify", method);
  await write({ jsonrpc: "2.0", method, params });
}

async function write(message: RpcMessage) {
  const payload = encodeMessage(message);
  const pending = writeChain.then(async () => {
    await writeAll(payload);
  });
  writeChain = pending.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });
  await pending;
}

async function writeAll(payload: Uint8Array<ArrayBufferLike>) {
  let offset = 0;
  while (offset < payload.length) {
    const written = await Deno.stdout.write(payload.subarray(offset));
    if (written <= 0) throw new Error("failed to write LSP message to stdout");
    offset += written;
  }
}

function concat(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}

function log(...parts: string[]) {
  console.error(`[wm-lsp] ${parts.join(" ")}`);
}

function summarize(message: RpcMessage): string {
  const id = message.id === undefined ? "-" : String(message.id);
  const method = message.method ?? "<result/error>";
  return `id=${id} method=${method}`;
}

function showError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

type DidOpenParams = {
  textDocument: { uri: string; version?: number; text: string };
};

type DidChangeParams = {
  textDocument: { uri: string; version?: number };
  contentChanges: { text: string }[];
};

type DidCloseParams = {
  textDocument: { uri: string };
};

type DidSaveParams = {
  textDocument: { uri: string };
};

type HoverParams = {
  textDocument: { uri: string };
  position: { line: number; character: number };
};
