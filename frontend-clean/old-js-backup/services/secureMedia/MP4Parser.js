/**
 * MP4Parser - Parse MP4 moov atom for codec info and seek table
 *
 * Extracts:
 * - Codec strings (avc1/hev1 for video, mp4a for audio)
 * - Duration and timescale
 * - Sample table for time→byte offset mapping
 */

/**
 * Read a 32-bit big-endian unsigned integer from DataView
 */
function readUint32(view, offset) {
  return view.getUint32(offset, false); // Big-endian
}

/**
 * Read a 64-bit big-endian unsigned integer from DataView
 */
function readUint64(view, offset) {
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  return high * 0x100000000 + low;
}

/**
 * Read atom type as 4-character string
 */
function readAtomType(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

/**
 * Find an atom within a buffer, optionally searching recursively
 * @param {DataView} view - DataView of the buffer
 * @param {number} start - Start offset
 * @param {number} end - End offset
 * @param {string} atomType - Atom type to find (e.g., 'moov', 'trak')
 * @returns {{offset: number, size: number} | null}
 */
function findAtom(view, start, end, atomType) {
  let offset = start;

  while (offset < end) {
    if (offset + 8 > end) break;

    let size = readUint32(view, offset);
    const type = readAtomType(view, offset + 4);

    // Handle extended size (size == 1 means 64-bit size follows)
    if (size === 1) {
      if (offset + 16 > end) break;
      size = readUint64(view, offset + 8);
    } else if (size === 0) {
      // Size 0 means atom extends to end of file
      size = end - offset;
    }

    if (type === atomType) {
      return { offset, size };
    }

    offset += size;
  }

  return null;
}

/**
 * Find an atom by path (e.g., 'moov/trak/mdia/minf/stbl/stco')
 */
function findAtomPath(view, start, end, path) {
  const parts = path.split('/');
  let currentStart = start;
  let currentEnd = end;
  let headerSize = 8;

  for (const part of parts) {
    const atom = findAtom(view, currentStart, currentEnd, part);
    if (!atom) return null;

    // Move into the atom (skip header)
    headerSize = 8;
    if (readUint32(view, atom.offset) === 1) {
      headerSize = 16; // Extended size
    }

    currentStart = atom.offset + headerSize;
    currentEnd = atom.offset + atom.size;
  }

  return { offset: currentStart - headerSize, size: currentEnd - currentStart + headerSize };
}

/**
 * Parse stts (time-to-sample) atom
 * Returns array of { sampleCount, sampleDelta }
 */
function parseStts(view, atomOffset, atomSize) {
  const entries = [];
  const version = view.getUint8(atomOffset + 8);
  const entryCount = readUint32(view, atomOffset + 12);

  let offset = atomOffset + 16;
  for (let i = 0; i < entryCount && offset + 8 <= atomOffset + atomSize; i++) {
    entries.push({
      sampleCount: readUint32(view, offset),
      sampleDelta: readUint32(view, offset + 4),
    });
    offset += 8;
  }

  return entries;
}

/**
 * Parse stsc (sample-to-chunk) atom
 * Returns array of { firstChunk, samplesPerChunk, sampleDescriptionIndex }
 */
function parseStsc(view, atomOffset, atomSize) {
  const entries = [];
  const entryCount = readUint32(view, atomOffset + 12);

  let offset = atomOffset + 16;
  for (let i = 0; i < entryCount && offset + 12 <= atomOffset + atomSize; i++) {
    entries.push({
      firstChunk: readUint32(view, offset),
      samplesPerChunk: readUint32(view, offset + 4),
      sampleDescriptionIndex: readUint32(view, offset + 8),
    });
    offset += 12;
  }

  return entries;
}

/**
 * Parse stco (chunk offset) or co64 (64-bit chunk offset) atom
 * Returns array of chunk byte offsets
 */
function parseStco(view, atomOffset, atomSize, is64Bit = false) {
  const offsets = [];
  const entryCount = readUint32(view, atomOffset + 12);

  let offset = atomOffset + 16;
  const entrySize = is64Bit ? 8 : 4;

  for (let i = 0; i < entryCount && offset + entrySize <= atomOffset + atomSize; i++) {
    if (is64Bit) {
      offsets.push(readUint64(view, offset));
    } else {
      offsets.push(readUint32(view, offset));
    }
    offset += entrySize;
  }

  return offsets;
}

/**
 * Parse stsz (sample size) atom
 * Returns { defaultSize, sizes[] }
 */
function parseStsz(view, atomOffset, atomSize) {
  const defaultSize = readUint32(view, atomOffset + 12);
  const sampleCount = readUint32(view, atomOffset + 16);

  const sizes = [];
  if (defaultSize === 0) {
    let offset = atomOffset + 20;
    for (let i = 0; i < sampleCount && offset + 4 <= atomOffset + atomSize; i++) {
      sizes.push(readUint32(view, offset));
      offset += 4;
    }
  }

  return { defaultSize, sizes, sampleCount };
}

/**
 * Parse stss (sync sample / keyframe) atom
 * Returns array of sync sample numbers (1-indexed)
 */
function parseStss(view, atomOffset, atomSize) {
  const syncSamples = [];
  const entryCount = readUint32(view, atomOffset + 12);

  let offset = atomOffset + 16;
  for (let i = 0; i < entryCount && offset + 4 <= atomOffset + atomSize; i++) {
    syncSamples.push(readUint32(view, offset));
    offset += 4;
  }

  return syncSamples;
}

/**
 * Extract codec string from avcC (AVC) or hvcC (HEVC) config
 */
function extractVideoCodecString(view, stsdOffset, stsdSize) {
  // Look for avc1 or hev1/hvc1 sample entry
  let offset = stsdOffset + 16; // Skip version, flags, entry count
  const end = stsdOffset + stsdSize;

  while (offset + 8 < end) {
    const entrySize = readUint32(view, offset);
    const entryType = readAtomType(view, offset + 4);

    if (entryType === 'avc1' || entryType === 'avc3') {
      // AVC/H.264 - look for avcC atom
      const avcCOffset = offset + 86; // avcC starts after sample entry header
      if (avcCOffset + 12 < end) {
        const avcCSize = readUint32(view, avcCOffset);
        const avcCType = readAtomType(view, avcCOffset + 4);
        if (avcCType === 'avcC') {
          const profile = view.getUint8(avcCOffset + 9);
          const compat = view.getUint8(avcCOffset + 10);
          const level = view.getUint8(avcCOffset + 11);
          return `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
        }
      }
      return 'avc1.640028'; // Default high profile
    }

    if (entryType === 'hev1' || entryType === 'hvc1') {
      // HEVC/H.265
      return 'hev1.1.6.L93.B0'; // Default HEVC profile
    }

    if (entryType === 'vp09') {
      return 'vp09.00.10.08'; // Default VP9 profile
    }

    if (entryType === 'av01') {
      return 'av01.0.04M.08'; // Default AV1 profile
    }

    offset += entrySize;
  }

  return 'avc1.640028'; // Fallback
}

/**
 * Extract audio codec string from esds or other atoms
 */
function extractAudioCodecString(view, stsdOffset, stsdSize) {
  let offset = stsdOffset + 16;
  const end = stsdOffset + stsdSize;

  while (offset + 8 < end) {
    const entrySize = readUint32(view, offset);
    const entryType = readAtomType(view, offset + 4);

    if (entryType === 'mp4a') {
      // AAC audio
      return 'mp4a.40.2'; // AAC-LC
    }

    if (entryType === 'ac-3' || entryType === 'ac3 ') {
      return 'ac-3';
    }

    if (entryType === 'ec-3') {
      return 'ec-3';
    }

    if (entryType === 'Opus') {
      return 'opus';
    }

    offset += entrySize;
  }

  return 'mp4a.40.2'; // Fallback to AAC-LC
}

/**
 * Parse mvhd (movie header) atom for duration and timescale
 */
function parseMvhd(view, atomOffset, atomSize) {
  const version = view.getUint8(atomOffset + 8);

  if (version === 1) {
    // 64-bit version
    const timescale = readUint32(view, atomOffset + 20);
    const duration = readUint64(view, atomOffset + 24);
    return { timescale, duration };
  } else {
    // 32-bit version
    const timescale = readUint32(view, atomOffset + 12);
    const duration = readUint32(view, atomOffset + 16);
    return { timescale, duration };
  }
}

/**
 * Build seek table from sample tables
 * Returns array of { time, byteOffset, chunkIndex, isKeyframe }
 */
function buildSeekTable(stts, stsc, stco, stsz, stss, timescale, chunkSize = 64 * 1024 * 1024) {
  const seekTable = [];
  const syncSet = new Set(stss || []);

  // Calculate sample byte offsets
  let sampleIndex = 1;
  let currentTime = 0;
  let stscIndex = 0;
  let sttsIndex = 0;
  let sttsRemaining = stts[0]?.sampleCount || 0;
  let currentDelta = stts[0]?.sampleDelta || 1;

  for (let chunkIdx = 0; chunkIdx < stco.length; chunkIdx++) {
    const chunkNumber = chunkIdx + 1;
    let chunkOffset = stco[chunkIdx];

    // Determine samples per chunk
    while (stscIndex + 1 < stsc.length && stsc[stscIndex + 1].firstChunk <= chunkNumber) {
      stscIndex++;
    }
    const samplesInChunk = stsc[stscIndex]?.samplesPerChunk || 1;

    // Process each sample in chunk
    for (let s = 0; s < samplesInChunk; s++) {
      const isKeyframe = syncSet.size === 0 || syncSet.has(sampleIndex);

      // Add keyframes to seek table (or every ~1 second for audio-only)
      if (isKeyframe) {
        const timeSeconds = currentTime / timescale;
        const encryptedChunkIndex = Math.floor(chunkOffset / chunkSize);

        seekTable.push({
          time: timeSeconds,
          byteOffset: chunkOffset,
          sampleIndex,
          chunkIndex: encryptedChunkIndex,
          isKeyframe: true,
        });
      }

      // Get sample size
      const sampleSize = stsz.defaultSize || stsz.sizes[sampleIndex - 1] || 0;
      chunkOffset += sampleSize;

      // Advance time
      currentTime += currentDelta;
      sampleIndex++;

      // Update stts
      sttsRemaining--;
      if (sttsRemaining === 0 && sttsIndex + 1 < stts.length) {
        sttsIndex++;
        sttsRemaining = stts[sttsIndex].sampleCount;
        currentDelta = stts[sttsIndex].sampleDelta;
      }
    }
  }

  return seekTable;
}

/**
 * Main parse function - extract codec info and seek table from MP4 header
 * @param {ArrayBuffer} headerData - First 5MB of decrypted video
 * @param {number} chunkSize - Encrypted chunk size for chunk index calculation
 * @returns {Object} Parsed data
 */
export function parse(headerData, chunkSize = 64 * 1024 * 1024) {
  const view = new DataView(headerData);
  const result = {
    videoCodec: null,
    audioCodec: null,
    codecs: '',
    duration: 0,
    timescale: 90000,
    seekTable: [],
    moovOffset: 0,
    mdatOffset: 0,
    hasVideo: false,
    hasAudio: false,
    isFragmented: false, // True if MP4 has mvex (Movie Extends) atom
  };

  // Find moov atom
  const moov = findAtom(view, 0, headerData.byteLength, 'moov');
  if (!moov) {
    console.error('[MP4Parser] moov atom not found');
    return result;
  }
  result.moovOffset = moov.offset;

  // Check for mvex atom (indicates fragmented MP4)
  // Fragmented MP4s have mvex inside moov, regular MP4s don't
  const mvex = findAtom(view, moov.offset + 8, moov.offset + moov.size, 'mvex');
  result.isFragmented = !!mvex;
  console.log('[MP4Parser] Fragmentation check:', {
    hasMvex: !!mvex,
    isFragmented: result.isFragmented,
  });

  // Find mdat atom (may be before or after moov)
  const mdat = findAtom(view, 0, headerData.byteLength, 'mdat');
  if (mdat) {
    result.mdatOffset = mdat.offset;
  }

  // Parse mvhd for duration
  const mvhd = findAtomPath(view, moov.offset + 8, moov.offset + moov.size, 'mvhd');
  if (mvhd) {
    const { timescale, duration } = parseMvhd(view, mvhd.offset, mvhd.size);
    result.timescale = timescale;
    result.duration = duration / timescale;
  }

  // Find all trak atoms
  let trakOffset = moov.offset + 8;
  const moovEnd = moov.offset + moov.size;

  while (trakOffset < moovEnd) {
    const trak = findAtom(view, trakOffset, moovEnd, 'trak');
    if (!trak) break;

    const trakEnd = trak.offset + trak.size;

    // Find mdia/hdlr to determine track type
    const hdlr = findAtomPath(view, trak.offset + 8, trakEnd, 'mdia/hdlr');
    if (hdlr) {
      const handlerType = readAtomType(view, hdlr.offset + 16);

      if (handlerType === 'vide' && !result.hasVideo) {
        // Video track
        result.hasVideo = true;

        // Get video codec from stsd
        const stsd = findAtomPath(view, trak.offset + 8, trakEnd, 'mdia/minf/stbl/stsd');
        if (stsd) {
          result.videoCodec = extractVideoCodecString(view, stsd.offset, stsd.size);
        }

        // Build seek table from video track
        const stbl = findAtomPath(view, trak.offset + 8, trakEnd, 'mdia/minf/stbl');
        if (stbl) {
          const stblEnd = stbl.offset + stbl.size;

          const sttsAtom = findAtom(view, stbl.offset + 8, stblEnd, 'stts');
          const stscAtom = findAtom(view, stbl.offset + 8, stblEnd, 'stsc');
          const stcoAtom = findAtom(view, stbl.offset + 8, stblEnd, 'stco');
          const co64Atom = findAtom(view, stbl.offset + 8, stblEnd, 'co64');
          const stszAtom = findAtom(view, stbl.offset + 8, stblEnd, 'stsz');
          const stssAtom = findAtom(view, stbl.offset + 8, stblEnd, 'stss');

          // Get mdhd for track timescale
          const mdhd = findAtomPath(view, trak.offset + 8, trakEnd, 'mdia/mdhd');
          let trackTimescale = result.timescale;
          if (mdhd) {
            const mdhdVersion = view.getUint8(mdhd.offset + 8);
            trackTimescale = mdhdVersion === 1
              ? readUint32(view, mdhd.offset + 20)
              : readUint32(view, mdhd.offset + 12);
          }

          if (sttsAtom && stscAtom && (stcoAtom || co64Atom) && stszAtom) {
            const stts = parseStts(view, sttsAtom.offset, sttsAtom.size);
            const stsc = parseStsc(view, stscAtom.offset, stscAtom.size);
            const stco = co64Atom
              ? parseStco(view, co64Atom.offset, co64Atom.size, true)
              : parseStco(view, stcoAtom.offset, stcoAtom.size, false);
            const stsz = parseStsz(view, stszAtom.offset, stszAtom.size);
            const stss = stssAtom ? parseStss(view, stssAtom.offset, stssAtom.size) : [];

            result.seekTable = buildSeekTable(stts, stsc, stco, stsz, stss, trackTimescale, chunkSize);
          }
        }
      } else if (handlerType === 'soun' && !result.hasAudio) {
        // Audio track
        result.hasAudio = true;

        const stsd = findAtomPath(view, trak.offset + 8, trakEnd, 'mdia/minf/stbl/stsd');
        if (stsd) {
          result.audioCodec = extractAudioCodecString(view, stsd.offset, stsd.size);
        }
      }
    }

    trakOffset = trak.offset + trak.size;
  }

  // Build codec string
  const codecs = [];
  if (result.videoCodec) codecs.push(result.videoCodec);
  if (result.audioCodec) codecs.push(result.audioCodec);
  result.codecs = codecs.join(',');

  console.log('[MP4Parser] Parsed result:', {
    codecs: result.codecs,
    duration: result.duration,
    seekTableSize: result.seekTable.length,
    hasVideo: result.hasVideo,
    hasAudio: result.hasAudio,
    isFragmented: result.isFragmented,
  });

  return result;
}

/**
 * Find byte offset for a given time using seek table
 * @param {number} timeSeconds - Target time in seconds
 * @param {Array} seekTable - Seek table from parse()
 * @returns {{ time: number, byteOffset: number, chunkIndex: number }}
 */
export function timeToByteOffset(timeSeconds, seekTable) {
  if (!seekTable || seekTable.length === 0) {
    return { time: 0, byteOffset: 0, chunkIndex: 0 };
  }

  // Binary search for nearest keyframe before target time
  let left = 0;
  let right = seekTable.length - 1;

  while (left < right) {
    const mid = Math.ceil((left + right + 1) / 2);
    if (seekTable[mid].time <= timeSeconds) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }

  return seekTable[left];
}

/**
 * Find chunk index for a given byte offset
 * @param {number} byteOffset
 * @param {number} chunkSize - Encrypted chunk size
 * @returns {number}
 */
export function byteOffsetToChunkIndex(byteOffset, chunkSize = 64 * 1024 * 1024) {
  return Math.floor(byteOffset / chunkSize);
}

export default {
  parse,
  timeToByteOffset,
  byteOffsetToChunkIndex,
};
