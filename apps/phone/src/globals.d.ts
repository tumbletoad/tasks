// What Hermes, the app's JavaScript engine, has beside the React Native types: the shared packages
// count bytes with it.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
  encodeInto(input: string, into: Uint8Array): { read: number; written: number };
}
