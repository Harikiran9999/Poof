// Poof: clap/pop sound detector.
// Listens to the microphone (raw, without the browser's noise suppression,
// which would eat the click) and looks for a short sharp burst — a clap,
// pop, or finger snap — basically any short percussive sound.
(() => {
  'use strict';
  const P = (window.__poof = window.__poof || {});

  P.sensitivity = 9; // multiplier over the room noise floor, lower = more sensitive
  try {
    const saved = parseFloat(localStorage.getItem('poof.sens'));
    if (saved >= 2 && saved <= 20) P.sensitivity = Math.max(saved, 7);
  } catch (e) { /* storage can be blocked */ }

  P.setSensitivity = (v) => {
    P.sensitivity = v;
    try { localStorage.setItem('poof.sens', String(v)); } catch (e) { /* ignore */ }
  };

  P.startPoofDetector = async function (getUserMedia, onPoof) {
    const stream = await getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const src = ac.createMediaStreamSource(stream);
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    // ScriptProcessor is old but it needs no extra files, so Meet's page
    // security rules cannot block it
    const sp = ac.createScriptProcessor(512, 1, 1);
    const mute = ac.createGain();
    mute.gain.value = 0;
    src.connect(hp); hp.connect(sp); sp.connect(mute); mute.connect(ac.destination);

    const resume = () => { if (ac.state !== 'running') ac.resume().catch(() => {}); };
    ['pointerdown', 'keydown', 'click'].forEach((ev) => window.addEventListener(ev, resume, true));
    resume();

    let floor = 0.004;
    let state = 'idle';
    let peak = 0, t0 = 0, lastFire = 0;
    const MIN_ABS = 0.022;
    let prev = 0, prev2 = 0;

    function step(rms, now) {
      if (now - lastFire < 2500) { state = 'idle'; return; }
      const trigger = Math.max(floor * P.sensitivity, MIN_ABS);
      if (state === 'idle') {
        // a poof starts suddenly: the sound just before it must be quiet
        if (rms > trigger) {
          if (prev < trigger * 0.4 && prev2 < trigger * 0.4) { state = 'burst'; peak = rms; t0 = now; }
          else state = 'long';
        } else floor = floor * 0.98 + rms * 0.02;
      } else if (state === 'long') {
        // a long or gradual sound (speech, hiss, knocks): ignore until quiet again
        if (rms < trigger * 0.5) state = 'idle';
      } else {
        peak = Math.max(peak, rms);
        const dur = now - t0;
        if (dur > 140) state = 'long';                       // too long to be a poof trigger
        else if (rms < peak * 0.3 && dur >= 8) {             // burst ended quickly
          state = 'idle';
          lastFire = now;
          try { onPoof({ peak, dur }); } catch (err) { console.warn('[poof]', err); }
        }
      }
    }

    sp.onaudioprocess = (e) => {
      const buf = e.inputBuffer.getChannelData(0);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const rms = Math.sqrt(s / buf.length);
      step(rms, performance.now());
      prev2 = prev; prev = rms;
    };
    return { ac, stream };
  };
})();
