// =============================================================================
// StreamSniffer — offscreen.js
// Dedicated persistent offscreen document for:
// 1. High-concurrency parallel HLS downloading & AES-128 decryption (24 workers)
// 2. Real-time MPEG-TS -> Fragmented MP4 (fMP4) remuxing (Video + Audio)
// 3. Direct OPFS disk streaming & automatic blob URL creation
// =============================================================================

// ---------------------------------------------------------------------------
// FMP4Muxer — Converts MPEG-TS (H.264 + AAC) segments into playable .mp4
// ---------------------------------------------------------------------------
class FMP4Muxer {
  constructor() {
    this.initialized = false;
    this.seqNumber = 1;
    this.sps = null;
    this.pps = null;
    this.width = 1280;
    this.height = 720;
    this.audioObjectType = 2; // AAC-LC
    this.sampleRateIndex = 3; // 48000 Hz
    this.sampleRate = 48000;
    this.channelCount = 2;
    this.baseVideoDts = null;
    this.baseAudioPts = null;
    this.nextVideoDts = 0;
    this.nextAudioSampleIdx = 0;
  }

  static box(type, ...payloads) {
    let size = 8;
    for (const p of payloads) size += p.byteLength;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, size, false);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    let off = 8;
    for (const p of payloads) {
      out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), off);
      off += p.byteLength;
    }
    return out;
  }

  static fullBox(type, version, flags, ...payloads) {
    let size = 12;
    for (const p of payloads) size += p.byteLength;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, size, false);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    view.setUint32(8, ((version & 0xFF) << 24) | (flags & 0xFFFFFF), false);
    let off = 12;
    for (const p of payloads) {
      out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), off);
      off += p.byteLength;
    }
    return out;
  }

  static parseTsPackets(buf) {
    const PKT = 188;
    const bytes = new Uint8Array(buf);
    let pmtPid = 0x1000;
    let videoPid = null;
    let audioPid = null;

    // 1. Scan PAT & PMT
    for (let i = 0; i + PKT <= bytes.length; i += PKT) {
      if (bytes[i] !== 0x47) continue;
      const pid = ((bytes[i + 1] & 0x1F) << 8) | bytes[i + 2];
      const afc = (bytes[i + 3] >> 4) & 3;
      if (afc === 2) continue;
      let o = i + 4;
      if (afc === 3) o += 1 + bytes[i + 4];
      if (o >= i + PKT) continue;

      if (pid === 0) {
        const ptr = bytes[o];
        const sec = o + 1 + ptr;
        if (sec + 12 <= i + PKT) {
          const secLen = ((bytes[sec + 1] & 0x0F) << 8) | bytes[sec + 2];
          const end = Math.min(i + PKT, sec + 3 + secLen - 4);
          for (let j = sec + 8; j + 4 <= end; j += 4) {
            const prog = (bytes[j] << 8) | bytes[j + 1];
            if (prog !== 0) pmtPid = ((bytes[j + 2] & 0x1F) << 8) | bytes[j + 3];
          }
        }
      } else if (pid === pmtPid) {
        const ptr = bytes[o];
        const sec = o + 1 + ptr;
        if (sec + 12 <= i + PKT) {
          const secLen = ((bytes[sec + 1] & 0x0F) << 8) | bytes[sec + 2];
          const progInfoLen = ((bytes[sec + 10] & 0x0F) << 8) | bytes[sec + 11];
          let j = sec + 12 + progInfoLen;
          const end = Math.min(i + PKT, sec + 3 + secLen - 4);
          while (j + 5 <= end) {
            const stype = bytes[j];
            const epid = ((bytes[j + 1] & 0x1F) << 8) | bytes[j + 2];
            const esLen = ((bytes[j + 3] & 0x0F) << 8) | bytes[j + 4];
            if (stype === 0x1B) videoPid = epid;
            else if (stype === 0x0F || stype === 0x03 || stype === 0x04) audioPid = epid;
            j += 5 + esLen;
          }
        }
      }
    }

    // 2. Reassemble PES packets per PID
    const pesByPid = new Map();
    const curByPid = new Map();

    for (let i = 0; i + PKT <= bytes.length; i += PKT) {
      if (bytes[i] !== 0x47) continue;
      const pid = ((bytes[i + 1] & 0x1F) << 8) | bytes[i + 2];
      if (pid === 0 || pid === pmtPid || pid === 0x11 || pid === 0x1FFF) continue;
      const pusi = (bytes[i + 1] >> 6) & 1;
      const afc = (bytes[i + 3] >> 4) & 3;
      if (afc === 2) continue;
      let o = i + 4;
      if (afc === 3) o += 1 + bytes[i + 4];
      if (o >= i + PKT) continue;
      const payload = bytes.subarray(o, i + PKT);

      if (pusi) {
        if (curByPid.has(pid)) {
          if (!pesByPid.has(pid)) pesByPid.set(pid, []);
          pesByPid.get(pid).push(curByPid.get(pid));
        }
        curByPid.set(pid, [payload]);
      } else if (curByPid.has(pid)) {
        curByPid.get(pid).push(payload);
      }
    }
    for (const [pid, chunks] of curByPid.entries()) {
      if (!pesByPid.has(pid)) pesByPid.set(pid, []);
      pesByPid.get(pid).push(chunks);
    }

    const videoPes = [];
    const audioPes = [];

    for (const [pid, list] of pesByPid.entries()) {
      for (const chunks of list) {
        const parsed = FMP4Muxer.parsePes(chunks);
        if (!parsed) continue;
        if (pid === videoPid || (videoPid === null && parsed.streamId >= 0xE0 && parsed.streamId <= 0xEF)) {
          videoPes.push(parsed);
        } else if (pid === audioPid || (audioPid === null && parsed.streamId >= 0xC0 && parsed.streamId <= 0xDF)) {
          audioPes.push(parsed);
        }
      }
    }

    return { videoPes, audioPes };
  }

  static parsePes(chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const data = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) { data.set(c, off); off += c.length; }

    if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return null;
    const streamId = data[3];
    const flags = data[7];
    const hlen = data[8];
    const ptsDtsFlags = (flags >> 6) & 3;
    let pts = null, dts = null;
    if (ptsDtsFlags >= 2 && data.length >= 14) {
      pts = FMP4Muxer.readPts(data, 9);
      dts = pts;
    }
    if (ptsDtsFlags === 3 && data.length >= 19) {
      dts = FMP4Muxer.readPts(data, 14);
    }
    if (9 + hlen > data.length) return null;
    return { streamId, pts, dts, es: data.subarray(9 + hlen) };
  }

  static readPts(buf, o) {
    return ((buf[o] & 0x0E) >> 1) * 0x40000000 +
           buf[o + 1] * 0x400000 +
           ((buf[o + 2] & 0xFE) >> 1) * 0x8000 +
           buf[o + 3] * 0x80 +
           ((buf[o + 4] & 0xFE) >> 1);
  }

  static splitAnnexBNals(es) {
    const nals = [];
    const starts = [];
    const n = es.length;
    let i = 0;
    while (i < n - 3) {
      if (es[i] === 0 && es[i + 1] === 0) {
        if (es[i + 2] === 1) {
          starts.push({ nalStart: i + 3, prefixStart: i });
          i += 3;
          continue;
        } else if (i + 3 < n && es[i + 2] === 0 && es[i + 3] === 1) {
          starts.push({ nalStart: i + 4, prefixStart: i });
          i += 4;
          continue;
        }
      }
      i++;
    }
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k].nalStart;
      const e = k + 1 < starts.length ? starts[k + 1].prefixStart : n;
      if (e > s) nals.push(es.subarray(s, e));
    }
    return nals;
  }

  static parseAdtsFrames(es, basePts) {
    const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const frames = [];
    let i = 0;
    let frameIdx = 0;
    while (i + 7 <= es.length) {
      if (es[i] !== 0xFF || (es[i + 1] & 0xF0) !== 0xF0) {
        i++;
        continue;
      }
      const protectionAbsent = es[i + 1] & 1;
      const profile = ((es[i + 2] >> 6) & 3) + 1;
      const freqIdx = (es[i + 2] >> 2) & 0x0F;
      const chanCfg = ((es[i + 2] & 1) << 2) | ((es[i + 3] >> 6) & 3);
      const frameLen = ((es[i + 3] & 3) << 11) | (es[i + 4] << 3) | ((es[i + 5] >> 5) & 7);
      const hdrLen = protectionAbsent ? 7 : 9;
      if (frameLen < hdrLen || i + frameLen > es.length) break;

      const sampleRate = SAMPLE_RATES[freqIdx] || 48000;
      const pts = basePts !== null ? basePts + Math.round((frameIdx * 1024 * 90000) / sampleRate) : 0;
      frames.push({
        profile,
        freqIdx,
        chanCfg,
        sampleRate,
        pts,
        data: es.subarray(i + hdrLen, i + frameLen),
      });
      i += frameLen;
      frameIdx++;
    }
    return frames;
  }

  remuxSegment(videoBuf, audioBuf) {
    const vParsed = videoBuf ? FMP4Muxer.parseTsPackets(videoBuf) : { videoPes: [], audioPes: [] };
    const aParsed = audioBuf ? FMP4Muxer.parseTsPackets(audioBuf) : { videoPes: [], audioPes: [] };

    const rawVideoPes = vParsed.videoPes;
    const rawAudioPes = aParsed.audioPes.length > 0 ? aParsed.audioPes : vParsed.audioPes;

    // Sort video PES in decoding order (DTS)
    rawVideoPes.sort((a, b) => (a.dts ?? a.pts ?? 0) - (b.dts ?? b.pts ?? 0));

    const videoSamples = [];
    for (const pes of rawVideoPes) {
      const nals = FMP4Muxer.splitAnnexBNals(pes.es);
      const avccChunks = [];
      let isIdr = false;
      for (const nal of nals) {
        const nalType = nal[0] & 0x1F;
        if (nalType === 7) {
          if (!this.sps) this.sps = new Uint8Array(nal);
        } else if (nalType === 8) {
          if (!this.pps) this.pps = new Uint8Array(nal);
        } else if (nalType === 9) {
          continue; // omit AUD
        }
        if (nalType === 5) isIdr = true;
        const lenBuf = new Uint8Array(4);
        new DataView(lenBuf.buffer).setUint32(0, nal.byteLength, false);
        avccChunks.push(lenBuf, nal);
      }
      if (avccChunks.length === 0) continue;

      let totalBytes = 0;
      for (const c of avccChunks) totalBytes += c.byteLength;
      const sampleData = new Uint8Array(totalBytes);
      let off = 0;
      for (const c of avccChunks) { sampleData.set(c, off); off += c.byteLength; }

      const rawDts = pes.dts ?? pes.pts ?? 0;
      const rawPts = pes.pts ?? rawDts;
      if (this.baseVideoDts === null) this.baseVideoDts = rawDts;

      let relDts = rawDts - this.baseVideoDts;
      // Handle segment-relative timestamp resets gracefully
      if (relDts < this.nextVideoDts - 90000) {
        this.baseVideoDts = rawDts - this.nextVideoDts;
        relDts = this.nextVideoDts;
      }

      videoSamples.push({
        dts: Math.max(0, relDts),
        cts: rawPts - rawDts,
        isIdr,
        data: sampleData,
      });
    }

    const audioSamples = [];
    for (const pes of rawAudioPes) {
      const frames = FMP4Muxer.parseAdtsFrames(pes.es, pes.pts);
      for (const f of frames) {
        this.audioObjectType = f.profile;
        this.sampleRateIndex = f.freqIdx;
        this.sampleRate = f.sampleRate;
        this.channelCount = f.chanCfg;
        if (this.baseAudioPts === null) this.baseAudioPts = f.pts;
        audioSamples.push({
          data: f.data,
          duration: 1024,
        });
      }
    }

    const hasVideo = videoSamples.length > 0;
    const hasAudio = audioSamples.length > 0;
    const outputChunks = [];

    if (!this.initialized && (hasVideo || hasAudio)) {
      outputChunks.push(this.buildInitSegment(hasVideo, hasAudio));
      this.initialized = true;
    }

    if (hasVideo) {
      outputChunks.push(this.buildVideoFragment(videoSamples));
    }
    if (hasAudio) {
      outputChunks.push(this.buildAudioFragment(audioSamples));
    }

    let totalLen = 0;
    for (const c of outputChunks) totalLen += c.byteLength;
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of outputChunks) {
      result.set(c, offset);
      offset += c.byteLength;
    }
    return result;
  }

  buildInitSegment(hasVideo, hasAudio) {
    const ftyp = FMP4Muxer.box(
      "ftyp",
      new Uint8Array([
        0x69, 0x73, 0x6F, 0x6D,
        0x00, 0x00, 0x02, 0x00,
        0x69, 0x73, 0x6F, 0x6D,
        0x69, 0x73, 0x6F, 0x32,
        0x61, 0x76, 0x63, 0x31,
        0x6D, 0x70, 0x34, 0x31,
      ])
    );

    const mvhdPayload = new Uint8Array(96);
    const mvhdView = new DataView(mvhdPayload.buffer);
    mvhdView.setUint32(8, 90000, false);
    mvhdView.setUint32(12, 0, false);
    mvhdView.setUint32(16, 0x00010000, false);
    mvhdView.setUint16(20, 0x0100, false);
    mvhdView.setUint32(32, 0x00010000, false);
    mvhdView.setUint32(48, 0x00010000, false);
    mvhdView.setUint32(64, 0x40000000, false);
    mvhdView.setUint32(92, 3, false);
    const mvhd = FMP4Muxer.fullBox("mvhd", 0, 0, mvhdPayload);

    const moovChildren = [mvhd];
    const trexChildren = [];

    if (hasVideo) {
      moovChildren.push(this.buildVideoTrak());
      trexChildren.push(this.buildTrex(1));
    }
    if (hasAudio) {
      moovChildren.push(this.buildAudioTrak());
      trexChildren.push(this.buildTrex(2));
    }
    moovChildren.push(FMP4Muxer.box("mvex", ...trexChildren));

    const moov = FMP4Muxer.box("moov", ...moovChildren);
    const out = new Uint8Array(ftyp.byteLength + moov.byteLength);
    out.set(ftyp, 0);
    out.set(moov, ftyp.byteLength);
    return out;
  }

  buildTrex(trackId) {
    const p = new Uint8Array(20);
    const v = new DataView(p.buffer);
    v.setUint32(0, trackId, false);
    v.setUint32(4, 1, false);
    return FMP4Muxer.fullBox("trex", 0, 0, p);
  }

  buildVideoTrak() {
    const tkhdPayload = new Uint8Array(80);
    const tkhdView = new DataView(tkhdPayload.buffer);
    tkhdView.setUint32(8, 1, false);
    tkhdView.setUint32(36, 0x00010000, false);
    tkhdView.setUint32(52, 0x00010000, false);
    tkhdView.setUint32(68, 0x40000000, false);
    tkhdView.setUint32(72, this.width << 16, false);
    tkhdView.setUint32(76, this.height << 16, false);
    const tkhd = FMP4Muxer.fullBox("tkhd", 0, 7, tkhdPayload);

    const mdhdPayload = new Uint8Array(20);
    const mdhdView = new DataView(mdhdPayload.buffer);
    mdhdView.setUint32(8, 90000, false);
    mdhdView.setUint16(16, 0x55C4, false);
    const mdhd = FMP4Muxer.fullBox("mdhd", 0, 0, mdhdPayload);

    const hdlr = FMP4Muxer.fullBox(
      "hdlr", 0, 0,
      new Uint8Array([
        0x00, 0x00, 0x00, 0x00,
        0x76, 0x69, 0x64, 0x65,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x56, 0x69, 0x64, 0x65, 0x6F, 0x48, 0x61, 0x6E, 0x64, 0x6C, 0x65, 0x72, 0x00,
      ])
    );

    const vmhd = FMP4Muxer.fullBox("vmhd", 0, 1, new Uint8Array(8));
    const dref = FMP4Muxer.fullBox("dref", 0, 0, new Uint8Array([0, 0, 0, 1]), FMP4Muxer.fullBox("url ", 0, 1));
    const dinf = FMP4Muxer.box("dinf", dref);

    const sps = this.sps || new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xAC, 0xD9, 0x40, 0x78, 0x02, 0x27, 0xE5, 0xC0]);
    const pps = this.pps || new Uint8Array([0x68, 0xEB, 0xE2, 0xCB, 0x22, 0xC0]);
    const avcCPayload = new Uint8Array(11 + sps.byteLength + pps.byteLength);
    avcCPayload[0] = 1;
    avcCPayload[1] = sps[1];
    avcCPayload[2] = sps[2];
    avcCPayload[3] = sps[3];
    avcCPayload[4] = 0xFF;
    avcCPayload[5] = 0xE1;
    avcCPayload[6] = (sps.byteLength >> 8) & 0xFF;
    avcCPayload[7] = sps.byteLength & 0xFF;
    avcCPayload.set(sps, 8);
    let o = 8 + sps.byteLength;
    avcCPayload[o] = 1;
    avcCPayload[o + 1] = (pps.byteLength >> 8) & 0xFF;
    avcCPayload[o + 2] = pps.byteLength & 0xFF;
    avcCPayload.set(pps, o + 3);
    const avcC = FMP4Muxer.box("avcC", avcCPayload);

    const avc1Header = new Uint8Array(78);
    const avc1View = new DataView(avc1Header.buffer);
    avc1View.setUint16(6, 1, false);
    avc1View.setUint16(24, this.width, false);
    avc1View.setUint16(26, this.height, false);
    avc1View.setUint32(28, 0x00480000, false);
    avc1View.setUint32(32, 0x00480000, false);
    avc1View.setUint16(40, 1, false);
    avc1View.setUint16(74, 0x0018, false);
    avc1View.setInt16(76, -1, false);
    const avc1 = FMP4Muxer.box("avc1", avc1Header, avcC);

    const stsd = FMP4Muxer.fullBox("stsd", 0, 0, new Uint8Array([0, 0, 0, 1]), avc1);
    const emptyTbl = new Uint8Array(4);
    const stbl = FMP4Muxer.box(
      "stbl",
      stsd,
      FMP4Muxer.fullBox("stts", 0, 0, emptyTbl),
      FMP4Muxer.fullBox("stsc", 0, 0, emptyTbl),
      FMP4Muxer.fullBox("stsz", 0, 0, new Uint8Array(8)),
      FMP4Muxer.fullBox("stco", 0, 0, emptyTbl)
    );
    const minf = FMP4Muxer.box("minf", vmhd, dinf, stbl);
    const mdia = FMP4Muxer.box("mdia", mdhd, hdlr, minf);
    return FMP4Muxer.box("trak", tkhd, mdia);
  }

  buildAudioTrak() {
    const tkhdPayload = new Uint8Array(80);
    const tkhdView = new DataView(tkhdPayload.buffer);
    tkhdView.setUint32(8, 2, false);
    tkhdView.setUint16(28, 0x0100, false);
    tkhdView.setUint32(36, 0x00010000, false);
    tkhdView.setUint32(52, 0x00010000, false);
    tkhdView.setUint32(68, 0x40000000, false);
    const tkhd = FMP4Muxer.fullBox("tkhd", 0, 7, tkhdPayload);

    const mdhdPayload = new Uint8Array(20);
    const mdhdView = new DataView(mdhdPayload.buffer);
    mdhdView.setUint32(8, this.sampleRate, false);
    mdhdView.setUint16(16, 0x55C4, false);
    const mdhd = FMP4Muxer.fullBox("mdhd", 0, 0, mdhdPayload);

    const hdlr = FMP4Muxer.fullBox(
      "hdlr", 0, 0,
      new Uint8Array([
        0x00, 0x00, 0x00, 0x00,
        0x73, 0x6F, 0x75, 0x6E,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x53, 0x6F, 0x75, 0x6E, 0x64, 0x48, 0x61, 0x6E, 0x64, 0x6C, 0x65, 0x72, 0x00,
      ])
    );

    const smhd = FMP4Muxer.fullBox("smhd", 0, 0, new Uint8Array(4));
    const dref = FMP4Muxer.fullBox("dref", 0, 0, new Uint8Array([0, 0, 0, 1]), FMP4Muxer.fullBox("url ", 0, 1));
    const dinf = FMP4Muxer.box("dinf", dref);

    const asc0 = ((this.audioObjectType & 0x1F) << 3) | ((this.sampleRateIndex >> 1) & 0x07);
    const asc1 = ((this.sampleRateIndex & 1) << 7) | ((this.channelCount & 0x0F) << 3);
    const esds = FMP4Muxer.fullBox(
      "esds", 0, 0,
      new Uint8Array([
        0x03, 0x19, 0x00, 0x02, 0x00,
        0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x01, 0xF4, 0x00, 0x00, 0x01, 0xF4, 0x00,
        0x05, 0x02, asc0, asc1,
        0x06, 0x01, 0x02,
      ])
    );

    const mp4aHeader = new Uint8Array(28);
    const mp4aView = new DataView(mp4aHeader.buffer);
    mp4aView.setUint16(6, 1, false);
    mp4aView.setUint16(16, this.channelCount, false);
    mp4aView.setUint16(18, 16, false);
    mp4aView.setUint32(24, this.sampleRate << 16, false);
    const mp4a = FMP4Muxer.box("mp4a", mp4aHeader, esds);

    const stsd = FMP4Muxer.fullBox("stsd", 0, 0, new Uint8Array([0, 0, 0, 1]), mp4a);
    const emptyTbl = new Uint8Array(4);
    const stbl = FMP4Muxer.box(
      "stbl",
      stsd,
      FMP4Muxer.fullBox("stts", 0, 0, emptyTbl),
      FMP4Muxer.fullBox("stsc", 0, 0, emptyTbl),
      FMP4Muxer.fullBox("stsz", 0, 0, new Uint8Array(8)),
      FMP4Muxer.fullBox("stco", 0, 0, emptyTbl)
    );
    const minf = FMP4Muxer.box("minf", smhd, dinf, stbl);
    const mdia = FMP4Muxer.box("mdia", mdhd, hdlr, minf);
    return FMP4Muxer.box("trak", tkhd, mdia);
  }

  buildVideoFragment(samples) {
    for (let i = 0; i < samples.length; i++) {
      if (i + 1 < samples.length) {
        const diff = samples[i + 1].dts - samples[i].dts;
        samples[i].duration = diff > 0 ? diff : 3750;
      } else {
        samples[i].duration = i > 0 ? samples[i - 1].duration : 3750;
      }
    }
    const lastSample = samples[samples.length - 1];
    this.nextVideoDts = lastSample.dts + lastSample.duration;

    const mfhdPayload = new Uint8Array(4);
    new DataView(mfhdPayload.buffer).setUint32(0, this.seqNumber++, false);
    const mfhd = FMP4Muxer.fullBox("mfhd", 0, 0, mfhdPayload);

    const tfhdPayload = new Uint8Array(4);
    new DataView(tfhdPayload.buffer).setUint32(0, 1, false);
    const tfhd = FMP4Muxer.fullBox("tfhd", 0, 0x020000, tfhdPayload);

    const baseDts = samples[0].dts;
    const tfdtPayload = new Uint8Array(8);
    const tfdtView = new DataView(tfdtPayload.buffer);
    tfdtView.setUint32(0, Math.floor(baseDts / 0x100000000), false);
    tfdtView.setUint32(4, baseDts >>> 0, false);
    const tfdt = FMP4Muxer.fullBox("tfdt", 1, 0, tfdtPayload);

    const trunPayload = new Uint8Array(8 + samples.length * 16);
    const trunView = new DataView(trunPayload.buffer);
    trunView.setUint32(0, samples.length, false);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const o = 8 + i * 16;
      trunView.setUint32(o, s.duration, false);
      trunView.setUint32(o + 4, s.data.byteLength, false);
      trunView.setUint32(o + 8, s.isIdr ? 0x02000000 : 0x01010000, false);
      trunView.setInt32(o + 12, s.cts, false);
    }
    const trun = FMP4Muxer.fullBox("trun", 1, 0x000F01, trunPayload);
    const traf = FMP4Muxer.box("traf", tfhd, tfdt, trun);
    const moof = FMP4Muxer.box("moof", mfhd, traf);

    new DataView(moof.buffer, moof.byteOffset, moof.byteLength).setInt32(84, moof.byteLength + 8, false);

    const mdat = FMP4Muxer.box("mdat", ...samples.map(s => s.data));
    const out = new Uint8Array(moof.byteLength + mdat.byteLength);
    out.set(moof, 0);
    out.set(mdat, moof.byteLength);
    return out;
  }

  buildAudioFragment(samples) {
    const mfhdPayload = new Uint8Array(4);
    new DataView(mfhdPayload.buffer).setUint32(0, this.seqNumber++, false);
    const mfhd = FMP4Muxer.fullBox("mfhd", 0, 0, mfhdPayload);

    const tfhdPayload = new Uint8Array(4);
    new DataView(tfhdPayload.buffer).setUint32(0, 2, false);
    const tfhd = FMP4Muxer.fullBox("tfhd", 0, 0x020000, tfhdPayload);

    const baseTime = this.nextAudioSampleIdx * 1024;
    this.nextAudioSampleIdx += samples.length;

    const tfdtPayload = new Uint8Array(8);
    const tfdtView = new DataView(tfdtPayload.buffer);
    tfdtView.setUint32(0, Math.floor(baseTime / 0x100000000), false);
    tfdtView.setUint32(4, baseTime >>> 0, false);
    const tfdt = FMP4Muxer.fullBox("tfdt", 1, 0, tfdtPayload);

    const trunPayload = new Uint8Array(8 + samples.length * 8);
    const trunView = new DataView(trunPayload.buffer);
    trunView.setUint32(0, samples.length, false);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const o = 8 + i * 8;
      trunView.setUint32(o, s.duration, false);
      trunView.setUint32(o + 4, s.data.byteLength, false);
    }
    const trun = FMP4Muxer.fullBox("trun", 0, 0x000301, trunPayload);
    const traf = FMP4Muxer.box("traf", tfhd, tfdt, trun);
    const moof = FMP4Muxer.box("moof", mfhd, traf);

    new DataView(moof.buffer, moof.byteOffset, moof.byteLength).setInt32(84, moof.byteLength + 8, false);

    const mdat = FMP4Muxer.box("mdat", ...samples.map(s => s.data));
    const out = new Uint8Array(moof.byteLength + mdat.byteLength);
    out.set(moof, 0);
    out.set(mdat, moof.byteLength);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Network & AES-128 helpers
// ---------------------------------------------------------------------------

function resolveUrl(base, relative) {
  try { return new URL(relative, base).href; } catch { return relative; }
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
  return r.text();
}

async function fetchBinaryWithRetry(url, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.arrayBuffer();
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < retries) {
        await new Promise(res => setTimeout(res, 300 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/i, "").padStart(32, "0");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const keyCache = new Map();

async function fetchAesKey(keyUrl) {
  if (keyCache.has(keyUrl)) return keyCache.get(keyUrl);
  const p = (async () => {
    const raw = await fetchBinaryWithRetry(keyUrl);
    return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]);
  })();
  keyCache.set(keyUrl, p);
  return p;
}

async function decryptSegment(buf, key, iv) {
  return crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, buf);
}

// ---------------------------------------------------------------------------
// Playlist resolution & parsing
// ---------------------------------------------------------------------------

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split("\n").map(l => l.trim());
  const segments = [];
  const encMap = new Map();
  let keyUrl = null, keyIv = null, idx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-KEY")) {
      const m = line.match(/METHOD=([^,\s]+)/i)?.[1]?.toUpperCase();
      if (m === "NONE") { keyUrl = null; keyIv = null; }
      else if (m === "AES-128") {
        const u = line.match(/URI="([^"]+)"/i);
        if (u) keyUrl = resolveUrl(baseUrl, u[1]);
        const v = line.match(/IV=([0-9a-fx]+)/i);
        keyIv = v ? hexToBytes(v[1]) : null;
      } else { keyUrl = `__UNSUPPORTED__:${m}`; }
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    const segUrl = resolveUrl(baseUrl, line);
    segments.push(segUrl);
    if (keyUrl && !keyUrl.startsWith("__UNSUPPORTED__")) {
      const iv = keyIv ?? (() => {
        const b = new Uint8Array(16);
        new DataView(b.buffer).setUint32(12, idx, false);
        return b;
      })();
      encMap.set(segUrl, { keyUrl, iv });
    }
    idx++;
  }
  return { segments, encMap };
}

function parseMasterPlaylist(text, masterUrl) {
  const lines = text.split("\n").map(l => l.trim());
  const audioGroups = new Map();
  for (const line of lines) {
    if (!line.startsWith("#EXT-X-MEDIA") || !/TYPE=AUDIO/i.test(line)) continue;
    const gm = line.match(/GROUP-ID="([^"]+)"/i);
    const um = line.match(/URI="([^"]+)"/i);
    if (!gm || !um) continue;
    if (!audioGroups.has(gm[1]) || /DEFAULT=YES/i.test(line)) {
      audioGroups.set(gm[1], resolveUrl(masterUrl, um[1]));
    }
  }
  let bestBw = -1, bestVideo = null, bestAudioGroup = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = parseInt(lines[i].match(/BANDWIDTH=(\d+)/i)?.[1] || "0", 10);
    let uri = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith("#")) { uri = lines[j]; break; }
    }
    if (!uri) continue;
    if (bw > bestBw) {
      bestBw = bw;
      bestVideo = resolveUrl(masterUrl, uri);
      bestAudioGroup = lines[i].match(/AUDIO="([^"]+)"/i)?.[1] ?? null;
    }
  }
  const audioUrl = bestAudioGroup
    ? (audioGroups.get(bestAudioGroup) ?? null)
    : (audioGroups.size > 0 ? audioGroups.values().next().value : null);
  return { videoUrl: bestVideo, audioUrl };
}

async function resolvePlaylistTracks(url, text, tabStreams = []) {
  if (text.includes("#EXT-X-STREAM-INF")) {
    return { masterUrl: url, masterText: text, isMaster: true };
  }

  // 1. Check sibling HLS streams captured on the same tab
  const candidates = [];
  for (const s of tabStreams) {
    if (s.url !== url && s.fileType === "HLS") candidates.push(s.url);
  }

  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const audioIdx = parts.findIndex(p => p.toLowerCase() === "audio");
    if (audioIdx > 0) {
      const parent = "/" + parts.slice(0, audioIdx).join("/");
      candidates.push(
        new URL(parent + "/index.m3u8", u.origin).href,
        new URL(parent + "/master.m3u8", u.origin).href,
      );
    }
    for (let i = parts.length - 2; i >= 1; i--) {
      const p = "/" + parts.slice(0, i).join("/");
      candidates.push(
        new URL(p + "/index.m3u8", u.origin).href,
        new URL(p + "/master.m3u8", u.origin).href,
      );
    }
  } catch {}

  for (const cand of [...new Set(candidates)]) {
    try {
      const t = await fetchText(cand);
      if (t.includes("#EXT-X-STREAM-INF")) {
        return { masterUrl: cand, masterText: t, isMaster: true };
      }
    } catch {}
  }

  // 2. If initial URL is an audio track, probe companion video tracks
  if (/\/audio\//i.test(url)) {
    const videoCands = [
      url.replace(/\/audio\/[^/]+\//i, "/1080/"),
      url.replace(/\/audio\/[^/]+\//i, "/1080p/"),
      url.replace(/\/audio\/[^/]+\//i, "/720/"),
      url.replace(/\/audio\/[^/]+\//i, "/720p/"),
      url.replace(/\/audio\/[^/]+\//i, "/480/"),
      url.replace(/\/audio\/[^/]+\//i, "/video/"),
      url.replace(/\/audio\/[^/]+\//i, "/"),
    ];
    for (const vc of videoCands) {
      try {
        const vt = await fetchText(vc);
        if (vt.includes("#EXTINF")) {
          return { videoUrl: vc, audioUrl: url, isMaster: false };
        }
      } catch {}
    }
  }

  // 3. If initial URL is a video track (e.g., /720p/index.m3u8 or /1080/index.m3u8), check if any tabStream is an audio track or probe /audio/eng/
  const siblingAudio = tabStreams.find(s => s.fileType === "HLS" && /\/audio\//i.test(s.url));
  if (siblingAudio) {
    return { videoUrl: url, audioUrl: siblingAudio.url, isMaster: false };
  }

  if (/\/\d{3,4}p?\//i.test(url)) {
    const audioCand = url.replace(/\/\d{3,4}p?\//i, "/audio/eng/");
    try {
      const at = await fetchText(audioCand);
      if (at.includes("#EXTINF")) {
        return { videoUrl: url, audioUrl: audioCand, isMaster: false };
      }
    } catch {}
  }

  return { masterUrl: url, masterText: text, isMaster: false };
}

async function fetchAndDecrypt(parsed, index) {
  if (!parsed || index >= parsed.segments.length) return null;
  const url = parsed.segments[index];
  let buf = await fetchBinaryWithRetry(url);
  const enc = parsed.encMap.get(url);
  if (enc) {
    const key = await fetchAesKey(enc.keyUrl);
    buf = await decryptSegment(buf, key, enc.iv);
  }
  return buf;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return "";
  const mb = bytesPerSec / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "";
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s left`;
}

// ---------------------------------------------------------------------------
// Active download controller
// ---------------------------------------------------------------------------

let cancelFlag = false;
const activeObjectUrls = new Map();

function reportState(patch) {
  chrome.runtime.sendMessage({ type: "OFFSCREEN_DL_UPDATE", patch }).catch(() => {});
}

async function runOffscreenHlsDownload(m3u8Url, tabStreams, suggestedTitle) {
  cancelFlag = false;
  keyCache.clear();

  let writable = null;
  let tempName = `sniffer_${Date.now()}.mp4`;
  let rootDir = null;

  try {
    reportState({
      phase: "running",
      url: m3u8Url,
      progress: 0,
      sub: "Resolving video & audio tracks…",
      error: null,
    });

    const initText = await fetchText(m3u8Url);
    const resolved = await resolvePlaylistTracks(m3u8Url, initText, tabStreams);

    if (cancelFlag) {
      reportState({ phase: "cancelled" });
      return;
    }

    let videoUrl, audioUrl;
    if (resolved.isMaster) {
      reportState({ sub: "Selecting highest quality variant…" });
      const p = parseMasterPlaylist(resolved.masterText, resolved.masterUrl);
      if (!p.videoUrl) throw new Error("No playable video variant found in master playlist.");
      videoUrl = p.videoUrl;
      audioUrl = p.audioUrl;
    } else if (resolved.videoUrl) {
      videoUrl = resolved.videoUrl;
      audioUrl = resolved.audioUrl;
    } else {
      videoUrl = m3u8Url;
      audioUrl = null;
    }

    reportState({ sub: "Loading segment lists…", progress: 2 });
    const [vText, aText] = await Promise.all([
      fetchText(videoUrl),
      audioUrl ? fetchText(audioUrl).catch(() => null) : Promise.resolve(null),
    ]);

    const vParsed = parseMediaPlaylist(vText, videoUrl);
    if (!vParsed.segments.length) throw new Error("No video segments found in playlist.");

    const aParsed = aText ? parseMediaPlaylist(aText, audioUrl) : null;
    const hasAudio = Boolean(aParsed && aParsed.segments.length > 0);
    const totalSegs = hasAudio
      ? Math.max(vParsed.segments.length, aParsed.segments.length)
      : vParsed.segments.length;

    // Pre-warm AES keys before launching 24 workers so workers don't stall on key import
    const uniqueKeyUrls = new Set();
    for (const v of vParsed.encMap.values()) uniqueKeyUrls.add(v.keyUrl);
    if (hasAudio) {
      for (const a of aParsed.encMap.values()) uniqueKeyUrls.add(a.keyUrl);
    }
    if (uniqueKeyUrls.size > 0) {
      await Promise.all([...uniqueKeyUrls].map(u => fetchAesKey(u)));
    }

    // Build clean .mp4 filename
    const urlPath = (() => { try { return new URL(videoUrl).pathname; } catch { return "video"; } })();
    const rawName = suggestedTitle || urlPath.split("/").filter(Boolean).slice(-3).join("_").replace(/\.m3u8$/i, "");
    const cleanBase = (rawName || "video").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.(ts|mp4|m3u8)$/i, "");
    const filename = `${cleanBase}.mp4`;

    rootDir = await navigator.storage.getDirectory();
    const fileHandle = await rootDir.getFileHandle(tempName, { create: true });
    writable = await fileHandle.createWritable();

    const muxer = new FMP4Muxer();

    // ── High-Speed Sliding-Window Parallel Pool (24 concurrent segments) ────
    const CONCURRENCY = 24;
    const completed = new Map();
    let nextToFetch = 0;
    let nextToWrite = 0;
    let activeWorkers = 0;
    let bytesDownloaded = 0;
    const startTime = performance.now();
    let workerError = null;
    let writeLock = Promise.resolve();

    function flushReadySegments() {
      writeLock = writeLock.then(async () => {
        while (completed.has(nextToWrite) && !cancelFlag && !workerError) {
          const { vBuf, aBuf } = completed.get(nextToWrite);
          completed.delete(nextToWrite);

          const mp4Chunk = muxer.remuxSegment(vBuf, aBuf);
          if (mp4Chunk.byteLength > 0) {
            await writable.write(mp4Chunk);
          }

          nextToWrite++;
          const elapsedSec = Math.max(0.1, (performance.now() - startTime) / 1000);
          const speedBps = bytesDownloaded / elapsedSec;
          const avgSegBytes = bytesDownloaded / nextToWrite;
          const remainingBytes = (totalSegs - nextToWrite) * avgSegBytes;
          const etaSec = speedBps > 0 ? remainingBytes / speedBps : 0;

          const pct = Math.min(97, Math.round((nextToWrite / totalSegs) * 97));
          const speedStr = formatSpeed(speedBps);
          const etaStr = formatEta(etaSec);
          const meta = [speedStr, etaStr].filter(Boolean).join(" · ");

          reportState({
            progress: pct,
            sub: `Segment ${nextToWrite}/${totalSegs}${hasAudio ? " (V+A)" : ""}${meta ? ` — ${meta}` : ""}`,
          });
        }
      }).catch(err => {
        workerError = err;
      });
      return writeLock;
    }

    await new Promise((resolve, reject) => {
      function spawnNext() {
        while (
          activeWorkers < CONCURRENCY &&
          nextToFetch < totalSegs &&
          !cancelFlag &&
          !workerError &&
          (nextToFetch - nextToWrite) < CONCURRENCY * 2
        ) {
          const idx = nextToFetch++;
          activeWorkers++;

          Promise.all([
            fetchAndDecrypt(vParsed, idx),
            hasAudio ? fetchAndDecrypt(aParsed, idx) : Promise.resolve(null),
          ])
            .then(async ([vBuf, aBuf]) => {
              if (vBuf) bytesDownloaded += vBuf.byteLength;
              if (aBuf) bytesDownloaded += aBuf.byteLength;
              completed.set(idx, { vBuf, aBuf });
              await flushReadySegments();
            })
            .catch(err => {
              workerError = err;
            })
            .finally(() => {
              activeWorkers--;
              if (workerError) {
                reject(workerError);
                return;
              }
              if (cancelFlag) {
                if (activeWorkers === 0) resolve();
                return;
              }
              if (nextToWrite >= totalSegs && activeWorkers === 0) {
                resolve();
                return;
              }
              spawnNext();
            });
        }
      }
      spawnNext();
    });

    await writeLock;

    if (cancelFlag) {
      try { await writable.abort(); } catch {}
      try { await rootDir.removeEntry(tempName); } catch {}
      reportState({ phase: "cancelled" });
      return;
    }

    if (workerError) throw workerError;

    reportState({ progress: 99, sub: "Finalizing MP4 container…" });
    await writable.close();

    // Create typed video/mp4 Blob URL right here in the offscreen document!
    const finalFile = await fileHandle.getFile();
    const mp4Blob = new Blob([finalFile], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(mp4Blob);
    activeObjectUrls.set(tempName, blobUrl);

    // Ask background service worker to trigger chrome.downloads.download immediately
    chrome.runtime.sendMessage({
      type: "OFFSCREEN_SAVE_READY",
      blobUrl,
      filename,
      opfsName: tempName,
    });
  } catch (err) {
    if (writable) { try { await writable.abort(); } catch {} }
    if (rootDir && tempName) { try { await rootDir.removeEntry(tempName); } catch {} }
    reportState({
      phase: "error",
      error: err.message || String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Message listener from background service worker
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "OFFSCREEN_START_HLS") {
    runOffscreenHlsDownload(msg.url, msg.tabStreams || [], msg.title || "");
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "OFFSCREEN_CANCEL") {
    cancelFlag = true;
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "OFFSCREEN_CLEANUP") {
    const blobUrl = activeObjectUrls.get(msg.opfsName);
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      activeObjectUrls.delete(msg.opfsName);
    }
    navigator.storage.getDirectory()
      .then(root => root.removeEntry(msg.opfsName))
      .catch(() => {})
      .finally(() => sendResponse({ ok: true }));
    return true;
  }
});
