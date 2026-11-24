// Preserve GIF/WebP frame data while excluding optional metadata, before a file leaves the browser.
export function cleanAnimation(bytes, type) {
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  const invalid = () => { throw new Error("这张动图不完整，请重新选择。"); };
  const parts = [];
  if (type === "image/webp") {
    if (bytes.length < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 !== bytes.length) return invalid();
    let size = 4, animated = false;
    for (let pos = 12; pos < bytes.length;) {
      if (pos + 8 > bytes.length) return invalid();
      const kind = ascii(pos, 4), length = view.getUint32(pos + 4, true);
      const end = pos + 8 + length + (length % 2);
      if (end > bytes.length) return invalid();
      if (["VP8X", "ALPH", "VP8 ", "VP8L", "ANIM", "ANMF"].includes(kind)) {
        const chunk = bytes.slice(pos, end);
        if (kind === "VP8X") {
          if (length !== 10) return invalid();
          animated = !!(chunk[8] & 2);
          chunk[8] &= 0x12; // alpha and animation flags
        }
        parts.push(chunk);
        size += chunk.length;
      }
      pos = end;
    }
    if (!animated) return null; // Draw static photos so that their display orientation is preserved.
    const header = bytes.slice(0, 12);
    new DataView(header.buffer).setUint32(4, size, true);
    return new Blob([header, ...parts], { type });
  }
  if (bytes.length < 13 || !["GIF87a", "GIF89a"].includes(ascii(0, 6))) return invalid();
  const paletteSize = flags => flags & 0x80 ? 3 * (2 ** ((flags & 7) + 1)) : 0;
  const skipBlocks = start => {
    let cursor = start;
    while (cursor < bytes.length) {
      const length = bytes[cursor++];
      if (!length) return cursor;
      cursor += length;
    }
    return invalid();
  };
  let pos = 13 + paletteSize(bytes[10]);
  parts.push(bytes.subarray(0, pos));
  while (pos < bytes.length) {
    const start = pos, kind = bytes[pos++];
    if (kind === 0x3b) return new Blob([...parts, bytes.subarray(start, pos)], { type });
    if (kind === 0x2c) {
      if (start + 10 > bytes.length) return invalid();
      pos = skipBlocks(start + 11 + paletteSize(bytes[start + 9]));
      parts.push(bytes.subarray(start, pos));
    } else if (kind === 0x21) {
      const label = bytes[pos++];
      const looping = label === 0xff && bytes[pos] === 11 && ["NETSCAPE2.0", "ANIMEXTS1.0"].includes(ascii(pos + 1, 11));
      pos = skipBlocks(pos);
      if (label === 0xf9) {
        if (bytes[start + 2] !== 4 || pos !== start + 8) return invalid();
        parts.push(bytes.subarray(start, pos));
      } else if (looping && bytes[start + 14] === 3 && bytes[start + 15] === 1) {
        parts.push(bytes.subarray(start, start + 18), new Uint8Array([0]));
      }
    } else return invalid();
  }
  return invalid();
}
