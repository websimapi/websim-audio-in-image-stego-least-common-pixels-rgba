import CRC32 from "crc-32";

/**
 * Quantize color to 5 bits per channel (ignore lower 3 bits)
 */
function qKey(r, g, b) {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/**
 * Build histogram and rarity-ordered pixel indices
 */
export function rankLeastCommonPixels(imgData) {
  const { data, width, height } = imgData;
  const len = width * height;
  const hist = new Map();
  for (let i = 0; i < len; i++) {
    const o = i * 4;
    const key = qKey(data[o], data[o + 1], data[o + 2]);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  const rarity = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const o = i * 4;
    const key = qKey(data[o], data[o + 1], data[o + 2]);
    rarity[i] = hist.get(key) || 0;
  }
  const idx = new Uint32Array(len);
  for (let i = 0; i < len; i++) idx[i] = i;
  idx.sort((a, b) => {
    const da = rarity[a] - rarity[b];
    return da !== 0 ? da : a - b;
  });
  return idx;
}

/**
 * Write bits into blue channel LSB along given indices
 */
function writeBitsToBlueLSB(imgData, indices, bits) {
  const d = imgData.data;
  let bi = 0;
  for (let j = 0; j < indices.length && bi < bits.length; j++) {
    const px = indices[j] * 4;
    const b = d[px + 2];
    const bit = bits[bi++];
    d[px + 2] = (b & 0xFE) | bit;
  }
  return bi; // bits written
}

/**
 * Read bits from blue channel LSB along given indices
 */
function readBitsFromBlueLSB(imgData, indices, bitCount) {
  const d = imgData.data;
  const out = new Uint8Array(bitCount);
  let bi = 0;
  for (let j = 0; j < indices.length && bi < bitCount; j++) {
    const px = indices[j] * 4;
    out[bi++] = d[px + 2] & 1;
  }
  return out;
}

// Write bits across RGBA LSBs (R,G,B,A) along given indices
function writeBitsToRGBALSB(imgData, indices, bits) {
  const d = imgData.data;
  let bi = 0;
  for (let j = 0; j < indices.length && bi < bits.length; j++) {
    const px = indices[j] * 4;
    for (let c = 0; c < 4 && bi < bits.length; c++) {
      d[px + c] = (d[px + c] & 0xFE) | bits[bi++];
    }
  }
  return bi;
}

// Read bits across RGBA LSBs (R,G,B,A) along given indices
function readBitsFromRGBALSB(imgData, indices, bitCount) {
  const d = imgData.data;
  const out = new Uint8Array(bitCount);
  let bi = 0;
  for (let j = 0; j < indices.length && bi < bitCount; j++) {
    const px = indices[j] * 4;
    for (let c = 0; c < 4 && bi < bitCount; c++) {
      out[bi++] = d[px + c] & 1;
    }
  }
  return out;
}

function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  let k = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    for (let b = 7; b >= 0; b--) bits[k++] = (v >> b) & 1;
  }
  return bits;
}

function bitsToBytes(bits) {
  const len = Math.floor(bits.length / 8);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    bytes[i] = v;
  }
  return bytes;
}

/**
 * Simple header: 32b magic, 16b version, 32b audioLen, 32b crc32, 16b reserved, 16b headerBits
 * Total 16 bytes. Stored MSB-first.
 */
function makeHeader(audioBytes) {
  const magic = 0x41554449; // 'AUDI'
  const version = 0x0001;
  const len = audioBytes.length >>> 0;
  const crc = CRC32.buf(audioBytes) >>> 0;
  const reserved = 0;
  const header = new Uint8Array(16);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, magic);
  dv.setUint16(4, version);
  dv.setUint32(6, len);
  dv.setUint32(10, crc);
  dv.setUint16(14, reserved);
  return header;
}

function parseHeader(headerBytes) {
  const dv = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  const magic = dv.getUint32(0);
  const version = dv.getUint16(4);
  const len = dv.getUint32(6);
  const crc = dv.getUint32(10);
  const reserved = dv.getUint16(14);
  if (magic !== 0x41554449 || version !== 0x0001) return null;
  return { len, crc, reserved };
}

/**
 * Embed audio using least-common pixels (RGBA LSB).
 * This function MODIFIES the passed imageData object directly.
 * Returns: { usedIndices, maskUint8 } where maskUint8 is 0(protected)/255(free)
 */
export function embedAudioInImage(imageDataToModify, audioArrayBuffer) {
  const audioBytes = new Uint8Array(audioArrayBuffer);
  const header = makeHeader(audioBytes);
  const payload = new Uint8Array(header.length + audioBytes.length);
  payload.set(header, 0);
  payload.set(audioBytes, header.length);

  const bits = bytesToBits(payload);
  const ordered = rankLeastCommonPixels(imageDataToModify);
  const capacity = ordered.length * 4; // 4 bits per pixel (RGBA LSBs)
  if (bits.length > capacity) {
    throw new Error(`Insufficient capacity. Need ${bits.length} bits, have ${capacity}`);
  }

  const pixelsNeeded = Math.ceil(bits.length / 4);
  const used = ordered.slice(0, pixelsNeeded);
  const written = writeBitsToRGBALSB(imageDataToModify, used, bits);
  if (written !== bits.length) throw new Error("Failed to write all bits.");

  const mask = new Uint8ClampedArray(imageDataToModify.width * imageDataToModify.height);
  mask.fill(255);
  for (let i = 0; i < used.length; i++) mask[used[i]] = 0;

  return { usedIndices: used, maskUint8: mask };
}

/**
 * Attempt extraction from an image that used the same method
 */
export function extractAudioFromImage(imgData) {
  const ordered = rankLeastCommonPixels(imgData);
  // Header is 16 bytes => 128 bits
  const headerBits = readBitsFromRGBALSB(imgData, ordered, 128);
  const headerBytes = bitsToBytes(headerBits);
  const meta = parseHeader(headerBytes);
  if (!meta) throw new Error("Header not found.");
  const totalBits = 128 + meta.len * 8;
  if (totalBits > ordered.length * 4) throw new Error("Not enough capacity to read payload.");
  const allBits = readBitsFromRGBALSB(imgData, ordered, totalBits);
  const allBytes = bitsToBytes(allBits);
  const payload = allBytes.slice(16);
  const crc = CRC32.buf(payload) >>> 0;
  if (crc !== meta.crc) throw new Error("CRC mismatch. Data likely corrupted.");
  return payload.buffer;
}

/**
 * Utility: draw a 1-channel mask into a canvas ImageData (black protected, white free)
 */
export function maskToImageData(mask, width, height) {
  const out = new ImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i];
    const o = i * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
    out.data[o + 3] = 255;
  }
  return out;
}