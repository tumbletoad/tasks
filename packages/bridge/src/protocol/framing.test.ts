// Framing of tasks-local/1 (A2 3.6.2, A2 5 "Framing: split and merged chunks, 8 MiB limit,
// invalid UTF-8, lines without a terminator at close").
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { MAX_LINE_BYTES } from "./constants.ts";
import { FrameSizeError, LineDecoder, encodeLine, type Frame } from "./framing.ts";

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");

/** Every frame the decoder can give now. */
function drain(decoder: LineDecoder): Frame[] {
  const frames: Frame[] = [];
  for (let frame = decoder.next(); frame !== undefined; frame = decoder.next()) {
    frames.push(frame);
    if ("error" in frame && frame.error === "frame_too_large") break;
  }
  return frames;
}

/** Feeds `data` cut at `cuts` and returns the lines. */
function feed(data: Buffer, cuts: number[], max = MAX_LINE_BYTES): Frame[] {
  const decoder = new LineDecoder(max);
  const frames: Frame[] = [];
  let at = 0;
  for (const cut of [...cuts.filter((c) => c > 0 && c < data.length)].sort((a, b) => a - b)) {
    decoder.push(data.subarray(at, cut));
    frames.push(...drain(decoder));
    at = cut;
  }
  decoder.push(data.subarray(at));
  frames.push(...drain(decoder));
  return frames;
}

describe("[A2.3.6.local.framing] line framing", () => {
  test("merged messages in one chunk come out as separate lines", () => {
    const frames = feed(bytes('{"a":1}\n{"b":2}\n{"c":"x\\ny"}\n'), []);
    expect(frames).toEqual([{ line: '{"a":1}' }, { line: '{"b":2}' }, { line: '{"c":"x\\ny"}' }]);
  });

  test("a message split at every byte gives the same line", () => {
    const data = bytes('{"text":"Grüße ✓ 𝄞"}\n');
    for (let cut = 1; cut < data.length; cut += 1) {
      expect(feed(data, [cut])).toEqual([{ line: '{"text":"Grüße ✓ 𝄞"}' }]);
    }
  });

  test("any chunking of any sequence of lines gives the same lines in order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: "grapheme", maxLength: 40 }), { maxLength: 8 }),
        fc.array(fc.nat({ max: 400 }), { maxLength: 12 }),
        (texts, cuts) => {
          const lines = texts.map((text) => JSON.stringify({ text }));
          const data = bytes(lines.map((line) => `${line}\n`).join(""));
          expect(feed(data, cuts)).toEqual(lines.map((line) => ({ line })));
        },
      ),
      { numRuns: 300 },
    );
  });

  test("a line at the limit passes and one byte more stops the decoder for good", () => {
    const max = 1024;
    const exact = "x".repeat(max);
    expect(feed(bytes(`${exact}\n`), [100, 700])).toEqual([{ line: exact }]);

    const decoder = new LineDecoder(max);
    decoder.push(bytes(`${exact}y\n{"after":1}\n`));
    expect(decoder.next()).toEqual({ error: "frame_too_large" });
    expect(decoder.next()).toEqual({ error: "frame_too_large" });
    decoder.push(bytes('{"later":1}\n'));
    expect(decoder.next()).toEqual({ error: "frame_too_large" });
    expect(decoder.buffered).toBe(0);
  });

  test("a line over the limit is refused before its terminator arrives", () => {
    const decoder = new LineDecoder(16);
    decoder.push(bytes("0123456789"));
    expect(decoder.next()).toBeUndefined();
    decoder.push(bytes("0123456789"));
    expect(decoder.next()).toEqual({ error: "frame_too_large" });
  });

  test("the default limit is 8 MiB", { timeout: 60_000 }, () => {
    expect(MAX_LINE_BYTES).toBe(8 * 1024 * 1024);
    const decoder = new LineDecoder();
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let sent = 0; sent < MAX_LINE_BYTES; sent += chunk.length) decoder.push(chunk);
    expect(decoder.next()).toBeUndefined();
    decoder.push(bytes("\n"));
    const frame = decoder.next();
    expect(frame !== undefined && "line" in frame ? frame.line.length : -1).toBe(MAX_LINE_BYTES);
    decoder.push(chunk);
    for (let sent = 0; sent < MAX_LINE_BYTES; sent += chunk.length) decoder.push(chunk);
    expect(decoder.next()).toEqual({ error: "frame_too_large" });
  });

  test("invalid UTF-8 fails only its own line", () => {
    const data = Buffer.concat([
      bytes('{"a":1}\n'),
      Buffer.from([0x7b, 0xc3, 0x28, 0x7d, 0x0a]), // an invalid two-byte sequence
      Buffer.from([0xed, 0xa0, 0x80, 0x0a]), // an encoded surrogate
      Buffer.from([0xf8, 0x88, 0x80, 0x80, 0x80, 0x0a]), // a five-byte form
      bytes('{"b":2}\n'),
    ]);
    expect(feed(data, [3, 9, 12])).toEqual([
      { line: '{"a":1}' },
      { error: "invalid_utf8" },
      { error: "invalid_utf8" },
      { error: "invalid_utf8" },
      { line: '{"b":2}' },
    ]);
  });

  test("a BOM is kept, so the message parser refuses the line", () => {
    const frames = feed(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('{"a":1}\n')]), []);
    expect(frames).toEqual([{ line: `${String.fromCharCode(0xfeff)}{"a":1}` }]);
    const first = frames[0];
    expect(
      () => JSON.parse(first !== undefined && "line" in first ? first.line : "") as unknown,
    ).toThrow();
  });

  test("a line without its terminator at the end of the stream is never returned", () => {
    const decoder = new LineDecoder();
    decoder.push(bytes('{"a":1}\n{"cut":'));
    expect(decoder.next()).toEqual({ line: '{"a":1}' });
    expect(decoder.next()).toBeUndefined();
    expect(decoder.buffered).toBe(Buffer.byteLength('{"cut":'));
    decoder.clear();
    expect(decoder.buffered).toBe(0);
    expect(decoder.next()).toBeUndefined();
  });

  test("encodeLine writes one line and refuses a message over the limit", () => {
    expect(encodeLine({ text: "a\nb" })).toBe('{"text":"a\\nb"}\n');
    expect(encodeLine({ text: "a\nb" }).split("\n")).toHaveLength(2);
    expect(() => encodeLine({ text: "x".repeat(100) }, 50)).toThrow(FrameSizeError);
  });
});

describe("[A2.3.7.bridge.frames] resync: the bridge's stdin drops an oversized line and goes on", () => {
  /** Feeds `data` cut at `cuts` into a resync decoder and returns every frame. */
  function feedResync(data: Buffer, cuts: number[], max: number): Frame[] {
    const decoder = new LineDecoder(max, { resync: true });
    const frames: Frame[] = [];
    const take = () => {
      for (let frame = decoder.next(); frame !== undefined; frame = decoder.next()) {
        frames.push(frame);
      }
    };
    let at = 0;
    for (const cut of [...cuts.filter((c) => c > 0 && c < data.length)].sort((a, b) => a - b)) {
      decoder.push(data.subarray(at, cut));
      take();
      at = cut;
    }
    decoder.push(data.subarray(at));
    take();
    return frames;
  }

  test("a line over the limit gives one frame_too_large, and the lines around it pass", () => {
    const max = 16;
    const data = bytes(`{"a":1}\n${"x".repeat(40)}\n{"b":2}\n`);
    const expected = [{ line: '{"a":1}' }, { error: "frame_too_large" }, { line: '{"b":2}' }];
    expect(feedResync(data, [], max)).toEqual(expected);
    // The oversized line arriving before its terminator, in pieces.
    expect(feedResync(data, [10, 20, 30, 49], max)).toEqual(expected);
  });

  test("the decoder holds at most the limit plus one chunk while it skips", () => {
    const max = 1024;
    const decoder = new LineDecoder(max, { resync: true });
    const chunk = Buffer.alloc(512, 0x61);
    let errors = 0;
    for (let n = 0; n < 100; n += 1) {
      decoder.push(chunk);
      const frame = decoder.next();
      if (frame !== undefined && "error" in frame) errors += 1;
      expect(decoder.buffered).toBeLessThanOrEqual(max + chunk.length);
    }
    expect(errors).toBe(1);
    decoder.push(bytes('tail\n{"next":1}\n'));
    expect(decoder.next()).toEqual({ line: '{"next":1}' });
    expect(decoder.failed).toBe(false);
  });

  test("any chunking of lines with oversized ones among them gives the same frames", () => {
    const max = 24;
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: "grapheme", maxLength: 30 }), { maxLength: 8 }),
        fc.array(fc.nat({ max: 400 }), { maxLength: 12 }),
        (texts, cuts) => {
          const lines = texts.map((text) => JSON.stringify({ text }));
          const data = bytes(lines.map((line) => `${line}\n`).join(""));
          const expected = lines.map((line) =>
            Buffer.byteLength(line) > max ? { error: "frame_too_large" } : { line },
          );
          expect(feedResync(data, cuts, max)).toEqual(expected);
        },
      ),
      { numRuns: 300 },
    );
  });
});
