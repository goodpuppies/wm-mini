const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type RpcMessage = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export function encodeMessage(message: RpcMessage): Uint8Array {
  const body = JSON.stringify(message);
  const bytes = encoder.encode(body);
  return encoder.encode(`Content-Length: ${bytes.length}\r\n\r\n${body}`);
}

export function decodeMessages(
  buffer: Uint8Array<ArrayBufferLike>,
): { messages: RpcMessage[]; rest: Uint8Array<ArrayBufferLike> } {
  const messages: RpcMessage[] = [];
  let bytes = buffer;
  while (true) {
    const headerEnd = headerEndIndex(bytes);
    if (headerEnd < 0) break;
    const header = decoder.decode(bytes.slice(0, headerEnd));
    const length = contentLength(header);
    if (length === undefined) break;
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (bytes.length < bodyEnd) break;
    messages.push(JSON.parse(decoder.decode(bytes.slice(bodyStart, bodyEnd))));
    bytes = bytes.slice(bodyEnd);
  }
  return { messages, rest: bytes };
}

function contentLength(header: string): number | undefined {
  const match = /^Content-Length:\s*(\d+)$/im.exec(header);
  return match ? Number(match[1]) : undefined;
}

function headerEndIndex(bytes: Uint8Array): number {
  for (let i = 0; i <= bytes.length - 4; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}
