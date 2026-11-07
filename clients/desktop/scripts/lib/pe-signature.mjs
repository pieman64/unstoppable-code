const DOS_HEADER_PE_OFFSET = 0x3c;
const PE_SIGNATURE_SIZE = 4;
const COFF_HEADER_SIZE = 20;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const CHECKSUM_OFFSET = 64;
const CERTIFICATE_DIRECTORY_INDEX = 4;

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
// e_lfanew bound for the header read; real images keep it far below this.
export const PE_HEADER_SEARCH_BYTES = 4096;

/** Whether `bytes` begin an x64 (AMD64, PE32+) executable or DLL image. */
export function isX64PeImage(bytes) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) return false;
  const offset = bytes.readUInt32LE(DOS_HEADER_PE_OFFSET);
  return (
    offset >= 64 &&
    offset <= PE_HEADER_SEARCH_BYTES &&
    offset + PE_SIGNATURE_SIZE + COFF_HEADER_SIZE + 2 <= bytes.length &&
    bytes.readUInt32LE(offset) === 0x4550 &&
    bytes.readUInt16LE(offset + PE_SIGNATURE_SIZE) ===
      IMAGE_FILE_MACHINE_AMD64 &&
    bytes.readUInt16LE(offset + PE_SIGNATURE_SIZE + COFF_HEADER_SIZE) ===
      PE32_PLUS_MAGIC
  );
}

function requireRange(buffer, offset, length, description) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`Invalid PE file: ${description} is out of bounds`);
  }
}

/**
 * Remove an Authenticode certificate table from a PE executable.
 *
 * Distributed Node.js Windows binaries are already signed. Node's SEA flow
 * injects a resource into a copy of that binary, so the inherited signature
 * must be removed first or the resource rewrite leaves a stale certificate
 * directory that SignTool cannot replace.
 */
export function stripPeAuthenticodeSignature(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  requireRange(buffer, 0, DOS_HEADER_PE_OFFSET + 4, 'DOS header');

  if (buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Invalid PE file: missing DOS header signature');
  }

  const peOffset = buffer.readUInt32LE(DOS_HEADER_PE_OFFSET);
  requireRange(
    buffer,
    peOffset,
    PE_SIGNATURE_SIZE + COFF_HEADER_SIZE,
    'PE header',
  );
  if (buffer.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('Invalid PE file: missing PE header signature');
  }

  const coffHeaderOffset = peOffset + PE_SIGNATURE_SIZE;
  const optionalHeaderSize = buffer.readUInt16LE(coffHeaderOffset + 16);
  const optionalHeaderOffset = coffHeaderOffset + COFF_HEADER_SIZE;
  requireRange(
    buffer,
    optionalHeaderOffset,
    optionalHeaderSize,
    'optional header',
  );

  const magic = buffer.readUInt16LE(optionalHeaderOffset);
  const dataDirectoryOffset =
    magic === PE32_MAGIC
      ? optionalHeaderOffset + 96
      : magic === PE32_PLUS_MAGIC
        ? optionalHeaderOffset + 112
        : null;
  const dataDirectoryCountOffset =
    magic === PE32_MAGIC
      ? optionalHeaderOffset + 92
      : magic === PE32_PLUS_MAGIC
        ? optionalHeaderOffset + 108
        : null;
  if (dataDirectoryOffset === null) {
    throw new Error(
      `Invalid PE file: unsupported optional header magic 0x${magic.toString(16)}`,
    );
  }

  requireRange(buffer, dataDirectoryCountOffset, 4, 'data directory count');
  if (
    dataDirectoryCountOffset + 4 >
    optionalHeaderOffset + optionalHeaderSize
  ) {
    throw new Error(
      'Invalid PE file: data directory count is outside the optional header',
    );
  }
  const dataDirectoryCount = buffer.readUInt32LE(dataDirectoryCountOffset);

  const certificateDirectoryOffset =
    dataDirectoryOffset + CERTIFICATE_DIRECTORY_INDEX * 8;
  if (
    certificateDirectoryOffset + 8 >
    optionalHeaderOffset + optionalHeaderSize
  ) {
    throw new Error(
      'Invalid PE file: certificate directory is outside the optional header',
    );
  }
  if (dataDirectoryCount <= CERTIFICATE_DIRECTORY_INDEX) {
    throw new Error('Invalid PE file: certificate directory is not declared');
  }

  const certificateOffset = buffer.readUInt32LE(certificateDirectoryOffset);
  const certificateSize = buffer.readUInt32LE(certificateDirectoryOffset + 4);
  if (certificateOffset === 0 && certificateSize === 0) {
    return { buffer, removedCertificateSize: 0 };
  }
  if (certificateOffset === 0 || certificateSize === 0) {
    throw new Error(
      'Invalid PE file: certificate directory has a partial location',
    );
  }
  if (certificateOffset % 8 !== 0 || certificateSize % 8 !== 0) {
    throw new Error(
      'Invalid PE file: certificate table is not aligned to 8 bytes',
    );
  }

  requireRange(buffer, certificateOffset, certificateSize, 'certificate table');
  if (certificateOffset + certificateSize !== buffer.length) {
    throw new Error(
      'Unsupported PE file: certificate table is not the final file data',
    );
  }

  const stripped = Buffer.from(buffer.subarray(0, certificateOffset));
  stripped.writeUInt32LE(0, certificateDirectoryOffset);
  stripped.writeUInt32LE(0, certificateDirectoryOffset + 4);
  stripped.writeUInt32LE(0, optionalHeaderOffset + CHECKSUM_OFFSET);

  return { buffer: stripped, removedCertificateSize: certificateSize };
}
