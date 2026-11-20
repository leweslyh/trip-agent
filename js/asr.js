/* 语音输入：浏览器录音 + 硅基流动语音转文字 */
(function (global) {
  'use strict';

  const App = global.App = global.App || {};

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/mpeg'
    ];
    for (const type of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(type)) return type;
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  class AudioRecorder {
    constructor() {
      this.stream = null;
      this.recorder = null;
      this.chunks = [];
      this.audioCtx = null;
      this.analyser = null;
      this.raf = null;
      this.onLevel = null;
      this.mime = '';
      this.startedAt = 0;
    }

    get supported() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
    }

    get recording() {
      return !!this.recorder && this.recorder.state === 'recording';
    }

    get elapsed() {
      return this.startedAt ? Date.now() - this.startedAt : 0;
    }

    async start(onLevel) {
      if (!this.supported) {
        throw new Error('当前浏览器不支持录音，请使用最新版 Chrome / Edge / Safari');
      }
      if (this.recording) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
      this.stream = stream;
      this.chunks = [];
      this.mime = pickMime();
      const options = this.mime ? { mimeType: this.mime, audioBitsPerSecond: 64000 } : undefined;

      this.recorder = new MediaRecorder(stream, options);
      this.recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
      this.recorder.start(250);
      this.startedAt = Date.now();
      this.onLevel = onLevel || null;
      this._startMeter(stream);
    }

    _startMeter(stream) {
      try {
        const Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return;
        this.audioCtx = new Ctx();
        const source = this.audioCtx.createMediaStreamSource(stream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.65;
        source.connect(this.analyser);
        const buf = new Uint8Array(this.analyser.frequencyBinCount);
        const tick = () => {
          if (!this.analyser) return;
          this.analyser.getByteFrequencyData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i];
          const level = Math.min(1, (sum / buf.length) / 90);
          if (this.onLevel) this.onLevel(level);
          this.raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) { /* 可视化失败不影响录音 */ }
    }

    _teardown() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
      this.analyser = null;
      if (this.audioCtx) {
        try { this.audioCtx.close(); } catch (e) { /* ignore */ }
        this.audioCtx = null;
      }
      if (this.stream) {
        this.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } });
        this.stream = null;
      }
    }

    stop() {
      return new Promise((resolve, reject) => {
        if (!this.recorder) { reject(new Error('尚未开始录音')); return; }
        const rec = this.recorder;
        const finish = () => {
          this._teardown();
          const type = this.mime || 'audio/webm';
          const blob = new Blob(this.chunks, { type });
          const duration = this.elapsed;
          this.recorder = null;
          this.chunks = [];
          this.startedAt = 0;
          if (!blob.size) { reject(new Error('没有录到声音，请检查麦克风权限')); return; }
          resolve({ blob, duration, ext: type.indexOf('mp4') >= 0 ? 'mp4' : type.indexOf('ogg') >= 0 ? 'ogg' : 'webm' });
        };
        if (rec.state === 'inactive') { finish(); return; }
        rec.onstop = finish;
        try { rec.stop(); } catch (e) { finish(); }
      });
    }

    cancel() {
      if (this.recorder && this.recorder.state !== 'inactive') {
        try { this.recorder.onstop = null; this.recorder.stop(); } catch (e) { /* ignore */ }
      }
      this.recorder = null;
      this.chunks = [];
      this.startedAt = 0;
      this._teardown();
    }
  }

  async function transcribe(blob, ext) {
    const cfg = App.store.readConfig();
    const key = (cfg.siliconKey || '').trim();
    if (!key) throw new Error('尚未配置硅基流动 API Key，语音转文字需要它');
    if (!blob || !blob.size) throw new Error('音频为空');
    if (blob.size > 12 * 1024 * 1024) throw new Error('录音过长（超过约 5 分钟），请缩短后重试');

    const base = (cfg.siliconBase || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
    const form = new FormData();
    form.append('file', blob, 'record_' + Date.now() + '.' + (ext || 'webm'));
    form.append('model', cfg.asrModel || 'FunAudioLLM/SenseVoiceSmall');

    let res;
    try {
      res = await fetch(base + '/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key },
        body: form
      });
    } catch (e) {
      throw new Error('语音识别请求失败：' + e.message + '（可能是网络或跨域限制）');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && ((data.error && data.error.message) || data.message || data.detail)) || text.slice(0, 160) || ('HTTP ' + res.status);
      if (res.status === 401) throw new Error('硅基流动 API Key 无效，请重新填写');
      if (res.status === 402 || res.status === 403) throw new Error('硅基流动账户余额不足或无权限：' + msg);
      throw new Error('语音识别失败：' + msg);
    }
    const result = (data && (data.text || (data.segments && data.segments.map((s) => s.text).join('')))) || '';
    if (!result.trim()) throw new Error('没有识别到语音内容，请靠近麦克风再说一次');
    return result.trim();
  }

  App.asr = { AudioRecorder, transcribe, pickMime };
})(window);
