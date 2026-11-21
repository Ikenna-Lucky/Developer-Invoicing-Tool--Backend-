const maxLogoBytes = 512 * 1024;

function dimensions(bytes: Buffer, type: string): [number, number] | null {
  if (type === "png") {
    if (
      bytes.length < 33 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      return null;
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) return null;
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL")
        return null;
      offset += length + 12;
    }
    if (offset !== bytes.length) return null;
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length)
      return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (marker === 0xc0 || marker === 0xc2) {
      if (length < 8) return null;
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  return null;
}

// Logos are embedded, never fetched. SVG and animated formats cannot enter Chromium.
export function safePdfLogo(value: string | null): string | null {
  if (!value || value.length > Math.ceil(maxLogoBytes / 3) * 4 + 32)
    return null;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    value,
  );
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > maxLogoBytes || bytes.toString("base64") !== match[2])
    return null;
  const size = dimensions(bytes, match[1]);
  if (
    !size ||
    size.some((value) => value <= 0 || value > 2048) ||
    size[0] * size[1] > 4_000_000
  )
    return null;
  return value;
}
