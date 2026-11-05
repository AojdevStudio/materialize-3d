import { readFileSync } from 'fs';
import { inflateRawSync } from 'zlib';

const END_OF_CENTRAL_DIR = 0x06054b50;
const CENTRAL_DIR_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** Reads one stored or deflated entry from a ZIP archive (no ZIP64). */
export function readZipEntry(zipPath: string, entryName: string): Buffer {
  const zip = readFileSync(zipPath);

  // The end record sits at the tail, after an optional comment of up to 64 KiB.
  let end = zip.length - 22;
  const earliest = Math.max(0, end - 0xffff);
  while (end >= earliest && zip.readUInt32LE(end) !== END_OF_CENTRAL_DIR) end--;
  if (end < earliest) throw new Error(`${zipPath}: not a ZIP archive`);

  const entryCount = zip.readUInt16LE(end + 10);
  let entry = zip.readUInt32LE(end + 16);
  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(entry) !== CENTRAL_DIR_ENTRY) {
      throw new Error(`${zipPath}: corrupt central directory`);
    }
    const method = zip.readUInt16LE(entry + 10);
    const compressedSize = zip.readUInt32LE(entry + 20);
    const nameLength = zip.readUInt16LE(entry + 28);
    const extraLength = zip.readUInt16LE(entry + 30);
    const commentLength = zip.readUInt16LE(entry + 32);
    const localHeader = zip.readUInt32LE(entry + 42);
    const name = zip.toString('utf-8', entry + 46, entry + 46 + nameLength);

    if (name === entryName) {
      if (zip.readUInt32LE(localHeader) !== LOCAL_FILE_HEADER) {
        throw new Error(`${zipPath}: corrupt local header for ${entryName}`);
      }
      const dataStart =
        localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === STORED) return data;
      if (method === DEFLATED) return inflateRawSync(data);
      throw new Error(`${zipPath}: ${entryName} uses unsupported compression method ${method}`);
    }
    entry += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${zipPath}: no ${entryName} entry`);
}
