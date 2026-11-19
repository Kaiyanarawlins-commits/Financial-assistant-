/**
 * Packs PNGs into an .ico.
 *
 * Written out by hand because the alternative is a dependency for a file
 * format that is a six-byte header, a sixteen-byte entry per image, and then
 * the images themselves. Every browser since IE11 reads PNG-inside-ICO.
 *
 * Each entry's declared size must match its PNG or the browser picks the wrong
 * one, so the caller passes the side length alongside the bytes rather than
 * letting this guess from array order.
 */
export function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ side, data }) => {
    const entry = Buffer.alloc(16);
    // 256 is stored as 0, which is the one quirk in the whole format.
    entry.writeUInt8(side === 256 ? 0 : side, 0);
    entry.writeUInt8(side === 256 ? 0 : side, 1);
    entry.writeUInt8(0, 2); // palette size: none
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}
