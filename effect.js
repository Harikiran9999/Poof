// Poof — core rendering engine.
//
// Intercepts the webcam stream via an offscreen canvas and composites three
// layers each frame: the stored background plate, the masked live feed, and
// a particle overlay. Person isolation uses frame-differencing against a
// multi-frame-averaged reference image, cleaned up with blur/threshold/
// connected-component/hole-fill passes. The dissolve effect sweeps a radial
// threshold outward from the frame centre, spawning colour-sampled particles
// at the dissolving boundary.
(() => {
  'use strict';
  const P = (window.__poof = window.__poof || {});

  const WORK_W = 480;          // width of the low-res mask
  const DIFF_T = 70;           // colour difference that counts as "person"
  const DURATION = 2200;       // ms for the dissolve (slightly longer for a dreamier feel)
  const BAND = 0.04;           // softness of the dissolve edge
  const P_MIN = -0.05;
  const P_MAX = 1.05;
  const MAX_PARTICLES = 5000;  // more particles for a denser cloud effect
  const BG_FRAMES = 14;        // frames averaged for the empty room photo

  function mkCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function blurH(src, dst, w, h, r) {
    const k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        dst[row + x] = (sum / k) | 0;
        sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
  }

  function blurV(src, dst, w, h, r) {
    const k = 2 * r + 1;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += src[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = (sum / k) | 0;
        sum += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
      }
    }
  }

  function blur(a, tmp, w, h, r) { blurH(a, tmp, w, h, r); blurV(tmp, a, w, h, r); }

  const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

  class Pipeline {
    constructor(video, shared) {
      this.video = video;
      this.sh = shared;
      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;
      const scale = Math.min(1, 1280 / vw);
      this.W = Math.max(2, Math.round((vw * scale) / 2) * 2);
      this.H = Math.max(2, Math.round((vh * scale) / 2) * 2);
      this.WW = Math.min(WORK_W, this.W);
      this.HH = Math.max(2, Math.round((this.WW * this.H) / this.W));

      this.canvas = mkCanvas(this.W, this.H);
      this.ctx = this.canvas.getContext('2d');
      this.layer = mkCanvas(this.W, this.H);
      this.layerCtx = this.layer.getContext('2d');
      this.bgFull = mkCanvas(this.W, this.H);
      this.small = mkCanvas(this.WW, this.HH);
      this.smallCtx = this.small.getContext('2d', { willReadFrequently: true });
      this.alphaC = mkCanvas(this.WW, this.HH);
      this.alphaCtx = this.alphaC.getContext('2d');
      this.alphaImg = this.alphaCtx.createImageData(this.WW, this.HH);

      const n = this.WW * this.HH;
      this.n = n;
      this.mask = new Uint8Array(n);
      this.maskAvg = new Float32Array(n);
      this.tmp = new Uint8Array(n);
      this.bin = new Uint8Array(n);
      this.labels = new Int32Array(n);
      this.stack = new Int32Array(n);
      this.thr = this.makeThreshold();

      this.bgVer = -1;
      this.bgSmall = null;
      this.parts = [];
      this.p = P_MIN;
      this.prevP = P_MIN;
      this.t0 = 0;
      this.maskFrames = 0;
      this.last = performance.now();
      this.timer = null;
      this.dead = false;
    }

    // Build a per-pixel dissolve ordering. Values near 0 dissolve first,
    // values near 1 dissolve last. The pattern radiates outward from the
    // frame centre with angular wobble and per-pixel jitter for an organic,
    // non-uniform break-apart.
    makeThreshold() {
      const { WW, HH } = this;
      const thr = new Float32Array(WW * HH);
      const cx = WW / 2, cy = HH / 2;
      const maxR = Math.sqrt(cx * cx + cy * cy);
      for (let y = 0; y < HH; y++) {
        for (let x = 0; x < WW; x++) {
          const dx = x - cx, dy = y - cy;
          const r = Math.sqrt(dx * dx + dy * dy) / maxR;
          // radial outward sweep with randomness for organic feel
          thr[y * WW + x] = 0.45 * r + 0.15 * Math.sin(Math.atan2(dy, dx) * 3) * 0.5 + 0.4 * Math.random();
        }
      }
      return thr;
    }

    start() {
      this.timer = setInterval(() => this.frame(), 1000 / 30);
      this.frame();
    }

    destroy() {
      this.dead = true;
      clearInterval(this.timer);
      if (this.sh.active === this) this.sh.active = null;
    }

    // Acquire the reference background plate. Grabs BG_FRAMES consecutive
    // frames and averages them to suppress sensor noise, producing a clean
    // baseline for the frame-differencing mask.
    async captureBg() {
      const sh = this.sh;
      const { W, H } = this;
      const grab = mkCanvas(W, H);
      const gctx = grab.getContext('2d', { willReadFrequently: true });
      const acc = new Float32Array(W * H * 3);
      for (let f = 0; f < BG_FRAMES; f++) {
        gctx.drawImage(this.video, 0, 0, W, H);
        const d = gctx.getImageData(0, 0, W, H).data;
        for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { acc[j] += d[i]; acc[j + 1] += d[i + 1]; acc[j + 2] += d[i + 2]; }
        await new Promise((r) => setTimeout(r, 45));
      }
      const out = gctx.createImageData(W, H);
      for (let i = 0, j = 0; i < out.data.length; i += 4, j += 3) {
        out.data[i] = acc[j] / BG_FRAMES; out.data[i + 1] = acc[j + 1] / BG_FRAMES; out.data[i + 2] = acc[j + 2] / BG_FRAMES; out.data[i + 3] = 255;
      }
      if (!sh.bg || sh.bg.width !== W || sh.bg.height !== H) sh.bg = mkCanvas(W, H);
      sh.bg.getContext('2d').putImageData(out, 0, 0);
      sh.bgVer++;
      sh.mode = 'live';
      this.parts.length = 0;
    }

    syncBg() {
      const sh = this.sh;
      this.bgFull.getContext('2d').drawImage(sh.bg, 0, 0, this.W, this.H);
      this.smallCtx.drawImage(this.bgFull, 0, 0, this.WW, this.HH);
      this.bgSmall = this.smallCtx.getImageData(0, 0, this.WW, this.HH).data.slice();
      this.bgVer = sh.bgVer;
    }

    // returns 'vanishing' | 'appearing' | 'nobg' | 'busy'
    trigger() {
      const sh = this.sh;
      if (!sh.bg) return 'nobg';
      if (sh.mode === 'live') {
        sh.mode = 'vanishing'; this.t0 = performance.now(); this.p = P_MIN; this.prevP = P_MIN; this.maskFrames = 0;
        return 'vanishing';
      }
      if (sh.mode === 'gone') {
        sh.mode = 'appearing'; this.t0 = performance.now(); this.p = P_MAX; this.prevP = P_MAX; this.maskFrames = 0;
        return 'appearing';
      }
      return 'busy';
    }

    // Segment the person from the background. Pipeline:
    //   1. Estimate global illumination drift and compensate
    //   2. Per-pixel colour diff → binary mask
    //   3. Morphological denoise (blur + threshold)
    //   4. Connected-component labelling — keep only large blobs
    //   5. Flood-fill from frame edges to close interior holes
    //   6. Temporal EMA smoothing to suppress inter-frame flicker
    computeMask(d) {
      const { WW, HH, n, bgSmall, bin, tmp, labels, stack, mask, maskAvg } = this;

      // Pass 1: global brightness offset estimation. Compares all pixels on
      // the first pass, then only "unchanged" pixels on the second pass to
      // avoid the person's silhouette biasing the offset.
      let o0 = 0, o1 = 0, o2 = 0;
      for (let pass = 0; pass < 2; pass++) {
        let s0 = 0, s1 = 0, s2 = 0, c = 0;
        for (let i = 0; i < n; i += 3) {
          const j = i * 4;
          const e0 = d[j] - bgSmall[j] - o0, e1 = d[j + 1] - bgSmall[j + 1] - o1, e2 = d[j + 2] - bgSmall[j + 2] - o2;
          if (Math.abs(e0) + Math.abs(e1) + Math.abs(e2) < 70 || pass === 0) {
            s0 += e0 + o0; s1 += e1 + o1; s2 += e2 + o2; c++;
          }
        }
        if (c) { o0 = s0 / c; o1 = s1 / c; o2 = s2 / c; }
      }
      for (let i = 0; i < n; i++) {
        const j = i * 4;
        const diff = Math.abs(d[j] - bgSmall[j] - o0) + Math.abs(d[j + 1] - bgSmall[j + 1] - o1) + Math.abs(d[j + 2] - bgSmall[j + 2] - o2);
        bin[i] = diff > DIFF_T ? 255 : 0;
      }

      // Morphological open-close: blur → hard threshold erodes speckle,
      // second blur → softer threshold dilates the remaining blobs back.
      blur(bin, tmp, WW, HH, 2);
      for (let i = 0; i < n; i++) bin[i] = bin[i] > 150 ? 255 : 0;
      blur(bin, tmp, WW, HH, 3);
      for (let i = 0; i < n; i++) bin[i] = bin[i] > 70 ? 1 : 0;

      // Connected-component labelling via iterative flood-fill.
      // Discard blobs smaller than 1.5% of the frame or 25% of the
      // largest component — keeps the person, drops noise patches.
      labels.fill(0);
      const sizes = [0];
      let next = 0;
      for (let s = 0; s < n; s++) {
        if (!bin[s] || labels[s]) continue;
        next++;
        let sp = 0, size = 0;
        stack[sp++] = s; labels[s] = next;
        while (sp) {
          const p = stack[--sp]; size++;
          const x = p % WW;
          if (x > 0 && bin[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
          if (x < WW - 1 && bin[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
          if (p >= WW && bin[p - WW] && !labels[p - WW]) { labels[p - WW] = next; stack[sp++] = p - WW; }
          if (p < n - WW && bin[p + WW] && !labels[p + WW]) { labels[p + WW] = next; stack[sp++] = p + WW; }
        }
        sizes.push(size);
      }
      let largest = 0;
      for (let k = 1; k < sizes.length; k++) if (sizes[k] > largest) largest = sizes[k];
      const minKeep = Math.max(n * 0.015, largest * 0.25);
      for (let i = 0; i < n; i++) bin[i] = labels[i] && sizes[labels[i]] >= minKeep ? 1 : 0;

      // Interior hole fill: flood from every edge pixel; anything the flood
      // can't reach is enclosed by the silhouette and gets filled in.
      labels.fill(0);
      let sp = 0;
      const seed = (p) => { if (!bin[p] && !labels[p]) { labels[p] = 1; stack[sp++] = p; } };
      for (let x = 0; x < WW; x++) { seed(x); seed((HH - 1) * WW + x); }
      for (let y = 0; y < HH; y++) { seed(y * WW); seed(y * WW + WW - 1); }
      while (sp) {
        const p = stack[--sp];
        const x = p % WW;
        if (x > 0) seed(p - 1);
        if (x < WW - 1) seed(p + 1);
        if (p >= WW) seed(p - WW);
        if (p < n - WW) seed(p + WW);
      }
      for (let i = 0; i < n; i++) mask[i] = bin[i] || !labels[i] ? 255 : 0;

      // Final soft-edge blur + exponential moving average across frames
      // to stabilise the mask boundary and prevent per-frame jitter.
      blur(mask, tmp, WW, HH, 2);
      const k = this.maskFrames === 0 ? 1 : 0.5;
      for (let i = 0; i < n; i++) maskAvg[i] += (mask[i] - maskAvg[i]) * k;
      this.maskFrames++;
    }

    spawn(x, y, r, g, b, inward) {
      if (this.parts.length >= MAX_PARTICLES) return;
      const sx = this.W / this.WW, sy = this.H / this.HH;
      const life = 0.8 + Math.random() * 1.0;
      const p = { x: x * sx, y: y * sy, r, g, b, age: 0, life, size: 1.2 + Math.random() * 3.0, inward };
      if (inward) {
        // reassembling: swirl inward
        p.tx = p.x; p.ty = p.y;
        p.ox = 80 + Math.random() * 140; p.oy = -(50 + Math.random() * 100);
        p.spin = (Math.random() - 0.5) * 4;
      } else {
        // dissolving: drift outward with a slight upward swirl
        const angle = Math.random() * Math.PI * 2;
        const speed = 40 + Math.random() * 130;
        p.vx = Math.cos(angle) * speed;
        p.vy = Math.sin(angle) * speed - 30;
        p.spin = (Math.random() - 0.5) * 3;
      }
      this.parts.push(p);
    }

    updateParticles(dt) {
      const arr = this.parts;
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        p.age += dt;
        if (p.age >= p.life) continue;
        if (!p.inward) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          // gentle upward drift + spiral
          p.vx += (p.spin || 0) * 15 * dt;
          p.vy -= 25 * dt;
        }
        arr[w++] = p;
      }
      arr.length = w;
    }

    drawParticles() {
      const ctx = this.ctx;
      for (const p of this.parts) {
        const u = p.age / p.life;
        let x = p.x, y = p.y, a;
        if (p.inward) {
          const k = (1 - u) * (1 - u);
          x = p.tx + p.ox * k; y = p.ty + p.oy * k; a = Math.min(1, u * 1.6);
        } else {
          a = 1 - u * u; // slower fade for a more magical trail
        }
        ctx.globalAlpha = Math.max(0, a);
        // add a warm glow tint to particles
        const glow = Math.min(255, p.r + 40);
        ctx.fillStyle = `rgb(${glow},${Math.max(0, p.g - 10)},${Math.min(255, p.b + 20)})`;
        const s = p.size * (1 + u * 0.5); // particles grow slightly as they age
        ctx.fillRect(x, y, s, s);
      }
      ctx.globalAlpha = 1;
    }

    frame() {
      if (this.dead) return;
      const v = this.video;
      if (v.readyState < 2) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      const sh = this.sh;
      const ctx = this.ctx;
      if (sh.bg && this.bgVer !== sh.bgVer) this.syncBg();

      if (sh.mode === 'live' || !sh.bg) {
        ctx.drawImage(v, 0, 0, this.W, this.H);
      } else if (sh.mode === 'gone') {
        ctx.drawImage(this.bgFull, 0, 0, this.W, this.H);
      } else {
        this.transition(now);
      }
      this.updateParticles(dt);
      if (this.parts.length) this.drawParticles();
      if (sh.onFrame && sh.active === this) sh.onFrame();
    }

    transition(now) {
      const { WW, HH, W, H, ctx, sh } = this;
      const vanishing = sh.mode === 'vanishing';
      const t = Math.min(1, (now - this.t0) / DURATION);
      const e = 0.5 * t + 0.5 * (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));   // gentle ease in and out
      this.prevP = this.p;
      this.p = vanishing ? P_MIN + e * (P_MAX - P_MIN) : P_MAX - e * (P_MAX - P_MIN);
      const p = this.p, prev = this.prevP;
      const lo = Math.min(p, prev), hi = Math.max(p, prev);

      this.smallCtx.drawImage(this.video, 0, 0, WW, HH);
      const d = this.smallCtx.getImageData(0, 0, WW, HH).data;
      this.computeMask(d);

      const a = this.alphaImg.data, mask = this.maskAvg, thr = this.thr;
      const n = WW * HH;
      for (let i = 0; i < n; i++) {
        const m = mask[i] / 255;
        const th = thr[i];
        const vis = smooth((th - p) / BAND + 0.5);
        a[i * 4 + 3] = m * vis * 255;
        // spawn cloud particles where the body is dissolving
        if (m > 0.6 && th >= lo && th < hi && Math.random() < 0.12) {
          const j = i * 4;
          this.spawn(i % WW, (i / WW) | 0, d[j], d[j + 1], d[j + 2], !vanishing);
        }
      }
      this.alphaCtx.putImageData(this.alphaImg, 0, 0);

      // Composite: background plate → masked live feed (destination-in
      // blend with the alpha mask) → particle overlay on top.
      ctx.drawImage(this.bgFull, 0, 0, W, H);
      const lc = this.layerCtx;
      lc.globalCompositeOperation = 'source-over';
      lc.clearRect(0, 0, W, H);
      lc.drawImage(this.video, 0, 0, W, H);
      lc.globalCompositeOperation = 'destination-in';
      lc.filter = 'blur(1.5px)';
      lc.drawImage(this.alphaC, 0, 0, W, H);
      lc.filter = 'none';
      lc.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.layer, 0, 0);

      if (t >= 1) sh.mode = vanishing ? 'gone' : 'live';
    }
  }

  P.Pipeline = Pipeline;
})();
