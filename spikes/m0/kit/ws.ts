// A minimal RFC 6455 WebSocket server for the stand-in service: the upgrade handshake and
// unfragmented text frames, ping and close. Enough for the browser rows (U01-U03) to see a real
// WebSocket from the loopback page. The product uses the `ws` package (A2 3.8.1). The kit writes
// these 100 lines instead, so it needs no dependency.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 1024 * 1024;

export interface WebSocketPeer {
  sendText(text: string): void;
  close(code?: number): void;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(126, 1);
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  size: number;
}

/** Parses one client frame from the start of `buf`: a frame, null (need more) or an error. */
function parseFrame(buf: Buffer): Frame | null | "error" {
  if (buf.length < 2) return null;
  const b0 = buf.readUInt8(0);
  const b1 = buf.readUInt8(1);
  if ((b1 & 0x80) === 0) return "error"; // client frames are always masked
  let length = b1 & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = buf.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_PAYLOAD)) return "error";
    length = Number(big);
    offset = 10;
  }
  if (length > MAX_PAYLOAD) return "error";
  if (buf.length < offset + 4 + length) return null;
  const mask = buf.subarray(offset, offset + 4);
  const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < payload.length; i++) {
    payload[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
  }
  return { fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload, size: offset + 4 + length };
}

/**
 * Completes the upgrade on `socket` and calls `onText` for every text message. The caller has
 * already checked Host, Origin and the ticket.
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  onText: (text: string, peer: WebSocketPeer) => void,
): WebSocketPeer | undefined {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return undefined;
  }
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let closed = false;
  const peer: WebSocketPeer = {
    sendText: (text) => {
      if (!closed) socket.write(frame(1, Buffer.from(text, "utf8")));
    },
    close: (code = 1000) => {
      if (closed) return;
      closed = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      socket.end(frame(8, payload));
    },
  };
  let buffer: Buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      const parsed = parseFrame(buffer);
      if (parsed === null) return;
      if (parsed === "error") {
        peer.close(1002);
        return;
      }
      buffer = buffer.subarray(parsed.size);
      if (parsed.opcode === 8) {
        peer.close(1000);
        return;
      }
      if (parsed.opcode === 9) {
        socket.write(frame(10, parsed.payload));
      } else if (parsed.opcode === 1 && parsed.fin) {
        onText(parsed.payload.toString("utf8"), peer);
      } else if (parsed.opcode !== 10) {
        peer.close(1003); // binary and fragmented messages are not part of the spike
        return;
      }
    }
  };
  socket.on("data", onData);
  socket.on("error", () => {
    closed = true;
  });
  socket.on("close", () => {
    closed = true;
  });
  if (head.length > 0) onData(Buffer.from(head));
  return peer;
}
