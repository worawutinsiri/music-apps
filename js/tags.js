/* Minimal metadata readers: ID3v2 (mp3), FLAC Vorbis comments and MP4/M4A ilst atoms.
   Returns { title, artist, album, picture: { mime, data } } with any field possibly missing. */
const Tags = (() => {
  const utf8 = new TextDecoder('utf-8');
  const utf8Strict = new TextDecoder('utf-8', { fatal: true });
  const utf16le = new TextDecoder('utf-16le');
  const utf16be = new TextDecoder('utf-16be');
  const latin1 = new TextDecoder('windows-1252');
  let thai = null;
  try { thai = new TextDecoder('windows-874'); } catch (e) { /* not supported */ }

  const slice = async (file, start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());
  const ascii = (b, start, len) => String.fromCharCode(...b.subarray(start, start + len));
  const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
  const u32le = (b, p) => b[p] + (b[p + 1] << 8) + (b[p + 2] << 16) + ((b[p + 3] << 24) >>> 0);
  const synchsafe = (b, p) => (b[p] << 21) | (b[p + 1] << 14) | (b[p + 2] << 7) | b[p + 3];
  const firstValue = (s) => s.split('\u0000')[0].trim();

  /* TIS-620 bytes that form plausible Thai: has a consonant, and vowel/tone marks follow Thai chars
     (so Latin-1 text such as "Café" is not mistaken for Thai) */
  function looksThai(bytes) {
    let consonant = false, prevThai = false;
    for (const b of bytes) {
      if (b < 0x80) { prevThai = false; continue; }
      if (b < 0xA1 || b > 0xFB) return false;
      const mark = b === 0xD1 || (b >= 0xD4 && b <= 0xDA) || (b >= 0xE7 && b <= 0xEE);
      if (mark && !prevThai) return false;
      if (b <= 0xCE) consonant = true;
      prevThai = true;
    }
    return consonant;
  }

  /* Thai MP3s frequently store TIS-620 bytes while declaring ISO-8859-1 */
  function decodeLegacy(bytes) {
    if (!bytes.some((b) => b >= 0x80)) return latin1.decode(bytes);
    try { return utf8Strict.decode(bytes); } catch (e) { /* not utf-8 */ }
    if (thai && looksThai(bytes)) return thai.decode(bytes);
    return latin1.decode(bytes);
  }

  function decodeText(enc, bytes) {
    switch (enc) {
      case 0: return firstValue(decodeLegacy(bytes));
      case 1:
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) return firstValue(utf16be.decode(bytes.subarray(2)));
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) return firstValue(utf16le.decode(bytes.subarray(2)));
        return firstValue(utf16le.decode(bytes));
      case 2: return firstValue(utf16be.decode(bytes));
      default: return firstValue(utf8.decode(bytes));
    }
  }

  function unsync(b) {
    const out = new Uint8Array(b.length);
    let j = 0;
    for (let i = 0; i < b.length; i++) {
      out[j++] = b[i];
      if (b[i] === 0xFF && b[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
  }

  /* index just past a null terminator (single or double byte depending on encoding) */
  function skipString(b, start, enc) {
    if (enc === 1 || enc === 2) {
      for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2;
    } else {
      for (let i = start; i < b.length; i++) if (b[i] === 0) return i + 1;
    }
    return b.length;
  }

  /* ---------- ID3v2 ---------- */
  async function readId3(file) {
    const head = await slice(file, 0, 10);
    const ver = head[3];
    const flags = head[5];
    const size = synchsafe(head, 6);
    let data = await slice(file, 10, 10 + size);
    if ((flags & 0x80) && ver < 4) data = unsync(data);

    let pos = 0;
    if ((flags & 0x40) && ver >= 3) pos = ver === 4 ? synchsafe(data, 0) : u32(data, 0) + 4;

    const out = {};
    const idLen = ver === 2 ? 3 : 4;
    const hdrLen = ver === 2 ? 6 : 10;
    let picType = -1;

    while (pos + hdrLen < data.length) {
      const id = ascii(data, pos, idLen);
      if (!/^[A-Z0-9]+$/.test(id)) break;
      const fsize = ver === 2 ? (data[pos + 3] << 16) | (data[pos + 4] << 8) | data[pos + 5]
        : ver === 4 ? synchsafe(data, pos + 4) : u32(data, pos + 4);
      const fflags = ver >= 3 ? data[pos + 9] : 0;
      pos += hdrLen;
      if (fsize <= 0 || pos + fsize > data.length) break;
      let body = data.subarray(pos, pos + fsize);
      pos += fsize;

      if (ver === 4) {
        if (fflags & 0x0C) continue; // compressed / encrypted
        if (fflags & 0x40) body = body.subarray(1);
        if (fflags & 0x01) body = body.subarray(4);
        if (fflags & 0x02) body = unsync(body);
      } else if (ver === 3) {
        if (fflags & 0xC0) continue;
        if (fflags & 0x20) body = body.subarray(1);
      }

      const enc = body[0];
      switch (id) {
        case 'TIT2': case 'TT2': out.title = out.title || decodeText(enc, body.subarray(1)); break;
        case 'TPE1': case 'TP1': out.artist = out.artist || decodeText(enc, body.subarray(1)); break;
        case 'TPE2': case 'TP2': out.albumArtist = out.albumArtist || decodeText(enc, body.subarray(1)); break;
        case 'TALB': case 'TAL': out.album = out.album || decodeText(enc, body.subarray(1)); break;
        case 'APIC': case 'PIC': {
          let p = 1, mime;
          if (id === 'PIC') {
            const fmt = ascii(body, 1, 3).toLowerCase();
            mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
            p = 4;
          } else {
            const end = skipString(body, 1, 0);
            mime = ascii(body, 1, end - 2) || 'image/jpeg';
            if (!mime.includes('/')) mime = 'image/' + mime.toLowerCase();
            p = end;
          }
          const type = body[p];
          p = skipString(body, p + 1, enc);
          // prefer the front cover (type 3), otherwise keep the first picture
          if (picType === -1 || (type === 3 && picType !== 3)) {
            out.picture = { mime, data: body.slice(p) };
            picType = type;
          }
          break;
        }
      }
    }
    if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
    return out;
  }

  /* ---------- FLAC ---------- */
  async function readFlac(file) {
    const out = {};
    let pos = 4;
    for (let i = 0; i < 128; i++) {
      const h = await slice(file, pos, pos + 4);
      if (h.length < 4) break;
      const last = h[0] & 0x80;
      const type = h[0] & 0x7F;
      const len = (h[1] << 16) | (h[2] << 8) | h[3];
      pos += 4;
      if (type === 4) vorbisComments(await slice(file, pos, pos + len), out);
      if (type === 6 && !out.picture) {
        const b = await slice(file, pos, pos + len);
        let p = 4;
        const mimeLen = u32(b, p); p += 4;
        const mime = ascii(b, p, mimeLen); p += mimeLen;
        const descLen = u32(b, p); p += 4 + descLen + 16;
        const dataLen = u32(b, p); p += 4;
        out.picture = { mime, data: b.slice(p, p + dataLen) };
      }
      pos += len;
      if (last) break;
    }
    return out;
  }

  function vorbisComments(b, out) {
    let p = 0;
    p += 4 + u32le(b, p);
    const count = u32le(b, p); p += 4;
    for (let i = 0; i < count && p < b.length; i++) {
      const len = u32le(b, p); p += 4;
      const s = utf8.decode(b.subarray(p, p + len)); p += len;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const key = s.slice(0, eq).toUpperCase();
      const val = s.slice(eq + 1).trim();
      if (key === 'TITLE' && !out.title) out.title = val;
      else if (key === 'ARTIST' && !out.artist) out.artist = val;
      else if (key === 'ALBUM' && !out.album) out.album = val;
    }
  }

  /* ---------- MP4 / M4A ---------- */
  function* atoms(b, start, end) {
    let p = start;
    while (p + 8 <= end) {
      let size = u32(b, p);
      const type = ascii(b, p + 4, 4);
      let hdr = 8;
      if (size === 1) { size = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) return;
      yield { type, start: p + hdr, end: p + size };
      p += size;
    }
  }
  const child = (b, box, type, skip = 0) => {
    for (const a of atoms(b, box.start + skip, box.end)) if (a.type === type) return a;
    return null;
  };

  async function readMp4(file) {
    // locate the top-level moov atom without reading the whole file
    let pos = 0, moov = null;
    while (pos + 8 <= file.size) {
      const h = await slice(file, pos, pos + 16);
      let size = u32(h, 0);
      const type = ascii(h, 4, 4);
      if (size === 1) size = u32(h, 8) * 2 ** 32 + u32(h, 12);
      else if (size === 0) size = file.size - pos;
      if (size < 8) break;
      if (type === 'moov') { moov = { pos, size }; break; }
      pos += size;
    }
    if (!moov || moov.size > 64 * 1024 * 1024) return {};

    const b = await slice(file, moov.pos, moov.pos + moov.size);
    const root = { start: 8, end: b.length };
    const udta = child(b, root, 'udta');
    const meta = udta && child(b, udta, 'meta', 4);
    const ilst = meta && child(b, meta, 'ilst');
    if (!ilst) return {};

    const out = {};
    for (const item of atoms(b, ilst.start, ilst.end)) {
      const data = child(b, item, 'data');
      if (!data) continue;
      const kind = u32(b, data.start) & 0xFFFFFF;
      const value = b.subarray(data.start + 8, data.end);
      switch (item.type) {
        case '©nam': out.title = utf8.decode(value).trim(); break;
        case '©ART': out.artist = utf8.decode(value).trim(); break;
        case 'aART': out.albumArtist = utf8.decode(value).trim(); break;
        case '©alb': out.album = utf8.decode(value).trim(); break;
        case 'covr': out.picture = { mime: kind === 14 ? 'image/png' : 'image/jpeg', data: value.slice() }; break;
      }
    }
    if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
    return out;
  }

  async function read(file) {
    try {
      const sig = await slice(file, 0, 12);
      if (ascii(sig, 0, 3) === 'ID3') return await readId3(file);
      if (ascii(sig, 0, 4) === 'fLaC') return await readFlac(file);
      if (ascii(sig, 4, 4) === 'ftyp') return await readMp4(file);
    } catch (err) {
      console.warn('Could not read tags of', file.name, err);
    }
    return {};
  }

  return { read };
})();
