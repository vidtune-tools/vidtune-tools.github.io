/* VidTune core: pure helpers with no DOM access, so they can be unit-tested in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- Format catalog -------------------------------------------------------
     engine 'audio'  : decoded with the Web Audio API and encoded in JS (fast, small download)
     engine 'ffmpeg' : ffmpeg.wasm (loads once, ~30 MB, used for M4A / MP4 / WebM and as a fallback) */
  const FORMATS = {
    mp3:  { label: 'MP3',  kind: 'audio', ext: 'mp3',  mime: 'audio/mpeg', engine: 'audio', qualities: [
      { id: '128', label: '128 kbps', kbps: 128 }, { id: '192', label: '192 kbps', kbps: 192 }, { id: '320', label: '320 kbps', kbps: 320, def: true } ] },
    wav:  { label: 'WAV',  kind: 'audio', ext: 'wav',  mime: 'audio/wav', engine: 'audio', qualities: [
      { id: 'lossless', label: 'Lossless, 16-bit', def: true } ] },
    m4a:  { label: 'M4A',  kind: 'audio', ext: 'm4a',  mime: 'audio/mp4', engine: 'ffmpeg', qualities: [
      { id: '128', label: '128 kbps AAC', kbps: 128 }, { id: '256', label: '256 kbps AAC', kbps: 256, def: true } ] },
    mp4:  { label: 'MP4',  kind: 'video', ext: 'mp4',  mime: 'video/mp4', engine: 'ffmpeg', qualities: [
      { id: '360', label: '360p', height: 360, crf: 30 }, { id: '720', label: '720p', height: 720, crf: 28, def: true }, { id: '1080', label: '1080p', height: 1080, crf: 26 } ] },
    webm: { label: 'WebM', kind: 'video', ext: 'webm', mime: 'video/webm', engine: 'ffmpeg', qualities: [
      { id: '360', label: '360p', height: 360, kbps: 700 }, { id: '720', label: '720p', height: 720, kbps: 1500, def: true }, { id: '1080', label: '1080p', height: 1080, kbps: 3000 } ] }
  };
  const defaultQuality = f => (FORMATS[f].qualities.find(q => q.def) || FORMATS[f].qualities[0]).id;
  const qualityOf = (f, id) => FORMATS[f].qualities.find(q => q.id === id) || FORMATS[f].qualities[0];

  /* ---- File-type detection ---- */
  const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif', 'amr'];
  const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'wmv', 'flv', 'mpg', 'mpeg', 'ts'];
  const extOf = name => { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; };
  /* returns 'audio' | 'video' | 'maybe-video' | null (null = not media at all) */
  function kindFromFile(name, mime) {
    const ext = extOf(name), t = (mime || '').toLowerCase();
    if (t.startsWith('audio/') || AUDIO_EXT.includes(ext)) return 'audio';
    if (t.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'maybe-video'; // mp4/mov can be audio-only; probe decides
    return null;
  }
  /* ---- Formatting ---- */
  const fmtBytes = b => b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : b < 1024 ** 3 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`;
  const fmtDur = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
  const baseName = name => (name || 'file').replace(/\.[^.]+$/, '');
  const slug = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'converted';

  /* ---- PCM helpers ---- */
  function floatTo16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; }
    return out;
  }
  /* buf: AudioBuffer-like { numberOfChannels, sampleRate, length, getChannelData(i) } (max 2 channels used) */
  function encodeWav(buf) {
    const ch = Math.min(2, buf.numberOfChannels), n = buf.length, rate = buf.sampleRate;
    const dataLen = n * ch * 2, ab = new ArrayBuffer(44 + dataLen), v = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, dataLen, true);
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, chans[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
    return ab;
  }
  const LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  /* ---- ffmpeg argument builder (used for M4A / MP4 / WebM and as a fallback) ---- */
  function ffmpegArgs(inName, outName, format, qualityId, inputKind) {
    const q = qualityOf(format, qualityId);
    const scale = h => `scale=-2:'min(${h},ih)'`;
    const toVideo = (format === 'mp4' || format === 'webm') && inputKind === 'audio';
    if (toVideo) {
      /* audio-only input: pair the audio with a plain dark frame so it can be used where a video is required */
      const size = { 360: '640x360', 720: '1280x720', 1080: '1920x1080' }[q.height];
      const src = ['-f', 'lavfi', '-i', `color=c=0x111111:s=${size}:r=5`, '-i', inName, '-map', '0:v', '-map', '1:a', '-shortest'];
      return format === 'mp4'
        ? [...src, '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'ultrafast', '-crf', '35', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outName]
        : [...src, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-c:a', 'libvorbis', '-b:a', '192k', outName];
    }
    switch (format) {
      case 'mp3':  return ['-i', inName, '-vn', '-c:a', 'libmp3lame', '-b:a', `${q.kbps}k`, outName];
      case 'wav':  return ['-i', inName, '-vn', '-c:a', 'pcm_s16le', outName];
      case 'm4a':  return ['-i', inName, '-vn', '-c:a', 'aac', '-b:a', `${q.kbps}k`, outName];
      case 'mp4':  return ['-i', inName, '-vf', scale(q.height), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(q.crf), '-pix_fmt', 'yuv420p',
                           '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outName];
      case 'webm': return ['-i', inName, '-vf', scale(q.height), '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', `${q.kbps}k`,
                           '-c:a', 'libvorbis', '-b:a', '128k', outName];
      default: throw new Error('Unknown format ' + format);
    }
  }

  return { FORMATS, defaultQuality, qualityOf, AUDIO_EXT, VIDEO_EXT, extOf, kindFromFile, fmtBytes, fmtDur, baseName, slug, floatTo16, encodeWav, LAME_RATES, ffmpegArgs };
});
