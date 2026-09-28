// Poof: hooks the camera in Google Meet, adds the floating control orb,
// and wires sound detection + hotkeys to the vanish effect.
(() => {
  'use strict';
  const P = (window.__poof = window.__poof || {});
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || P.installed) return;
  P.installed = true;

  const shared = { mode: 'live', bg: null, bgVer: 0, active: null, onFrame: null };
  P.shared = shared;
  const origGUM = md.getUserMedia.bind(md);

  let detectorStarted = false;
  let uiRefresh = () => {};
  let flashMsg = '', flashUntil = 0;

  function flash(msg, ms = 2200) { flashMsg = msg; flashUntil = performance.now() + ms; uiRefresh(); setTimeout(uiRefresh, ms + 50); }

  function toggle() {
    const p = shared.active;
    if (!p) return flash('no camera yet');
    const r = p.trigger();
    if (r === 'nobg') flash('capture the room first');
    uiRefresh();
  }
  P.toggle = toggle;

  async function startDetector() {
    if (detectorStarted) return;
    detectorStarted = true;
    try {
      await P.startPoofDetector(origGUM, () => toggle());
    } catch (e) {
      console.warn('[poof] mic sound detection unavailable', e);
      flash('sound trigger off — use the button');
    }
  }

  md.getUserMedia = async function (constraints) {
    if (!constraints || !constraints.video) return origGUM(constraints);
    const real = await origGUM(constraints);
    try {
      const vt = real.getVideoTracks()[0];
      if (!vt) return real;
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([vt]);
      await new Promise((res) => {
        video.onloadedmetadata = res;
        setTimeout(res, 3000);
      });
      await video.play().catch(() => {});

      const pipe = new P.Pipeline(video, shared);
      pipe.start();
      shared.active = pipe;

      const outTrack = pipe.canvas.captureStream(30).getVideoTracks()[0];
      const realStop = outTrack.stop.bind(outTrack);
      const cleanup = () => { pipe.destroy(); try { vt.stop(); } catch (e) { /* ignore */ } };
      outTrack.stop = () => { realStop(); cleanup(); };
      vt.addEventListener('ended', () => { cleanup(); try { outTrack.dispatchEvent(new Event('ended')); } catch (e) { /* ignore */ } });
      const vs = vt.getSettings ? vt.getSettings() : {};
      outTrack.getSettings = () => Object.assign({}, vs, { width: pipe.W, height: pipe.H });
      outTrack.applyConstraints = async () => {};
      try { Object.defineProperty(outTrack, 'label', { value: vt.label }); } catch (e) { /* ignore */ }

      startDetector();
      uiRefresh();
      return new MediaStream([outTrack, ...real.getAudioTracks()]);
    } catch (e) {
      console.warn('[poof] falling back to the normal camera', e);
      return real;
    }
  };

  // ---------- UI ----------
  // Poof uses a warm coral/magenta palette with soft rounded styling
  function mountUI() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:14px;left:14px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    // built with DOM calls, not innerHTML: Meet enforces Trusted Types and
    // would silently block innerHTML
    const el = (tag, props, kids) => {
      const n = document.createElement(tag);
      Object.assign(n, props || {});
      (kids || []).forEach((k) => n.appendChild(k));
      return n;
    };
    const style = el('style', { textContent: `
        *{box-sizing:border-box;font-family:'Inter',system-ui,-apple-system,sans-serif}

        /* ── Floating orb (replaces the pill) ── */
        .orb{
          display:flex;align-items:center;gap:10px;
          background:linear-gradient(135deg,rgba(40,8,30,.92) 0%,rgba(22,6,28,.95) 100%);
          color:#f0dce8;
          border:1px solid rgba(255,120,180,.18);
          border-radius:999px;padding:7px 14px;font-size:12.5px;font-weight:500;
          backdrop-filter:blur(12px);user-select:none;
          box-shadow:0 2px 16px rgba(200,60,120,.18),0 0 0 1px rgba(255,255,255,.04) inset;
          transition:box-shadow .3s ease;
        }
        .orb:hover{box-shadow:0 2px 24px rgba(200,60,120,.28),0 0 0 1px rgba(255,255,255,.08) inset}

        /* Status indicator dot */
        .dot{width:9px;height:9px;border-radius:50%;background:#5a4a55;transition:background .35s ease,box-shadow .35s ease}
        .dot.ready{background:#e06090;box-shadow:0 0 6px rgba(224,96,144,.5)}
        .dot.gone{background:#a855f7;box-shadow:0 0 8px rgba(168,85,247,.5)}
        .dot.alert{background:#fb923c;box-shadow:0 0 6px rgba(251,146,60,.5)}

        #st{cursor:pointer;letter-spacing:.03em}

        /* ── Dropdown panel ── */
        .panel{
          display:none;margin-top:10px;
          background:linear-gradient(160deg,rgba(40,8,30,.95) 0%,rgba(18,4,24,.97) 100%);
          color:#f0dce8;
          border:1px solid rgba(255,120,180,.14);
          border-radius:16px;padding:12px;font-size:12.5px;gap:10px;flex-direction:column;width:224px;
          box-shadow:0 4px 24px rgba(120,30,80,.2);
        }
        .panel.open{display:flex}

        /* Buttons */
        button{
          background:linear-gradient(135deg,#3a1028 0%,#2a0a20 100%);
          color:#f0dce8;
          border:1px solid rgba(255,120,180,.16);border-radius:10px;padding:8px 12px;
          font-size:12.5px;font-weight:500;cursor:pointer;
          transition:background .2s ease,border-color .2s ease;
        }
        button:hover{background:linear-gradient(135deg,#4a1838 0%,#3a1028 100%);border-color:rgba(255,120,180,.3)}
        button:active{background:#2a0a20}

        /* Slider label */
        label{display:flex;flex-direction:column;gap:5px;color:#c9a0b8}

        /* Range slider — custom track/thumb in the coral accent */
        input[type=range]{
          -webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:2px;
          background:linear-gradient(90deg,#e06090,#a855f7);outline:none;opacity:.85;
          transition:opacity .15s;
        }
        input[type=range]:hover{opacity:1}
        input[type=range]::-webkit-slider-thumb{
          -webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;
          background:#f0dce8;border:2px solid #e06090;cursor:pointer;
          box-shadow:0 0 6px rgba(224,96,144,.4);
        }
        input[type=range]::-moz-range-thumb{
          width:14px;height:14px;border-radius:50%;
          background:#f0dce8;border:2px solid #e06090;cursor:pointer;
        }

        .hint{color:#9a7088;line-height:1.45;font-size:11.5px}
      ` });
    const range = el('input', { id: 'sens', type: 'range', min: '3', max: '14', step: '0.5' });
    const panel = el('div', { className: 'panel', id: 'panel' }, [
      el('button', { id: 'cap', textContent: '✨ capture empty room' }),
      el('button', { id: 'tg', textContent: '💨 poof / return' }),
      el('label', { textContent: 'trigger sensitivity' }, [range]),
      el('div', { className: 'hint', textContent: 'Step out of frame, press capture, wait 3 s. Then clap or snap. Cmd / Ctrl + Shift + X also works. Cmd / Ctrl + Shift + H hides this.' }),
    ]);
    const orb = el('div', { className: 'orb' }, [
      el('span', { className: 'dot', id: 'dot' }),
      el('span', { id: 'st', textContent: 'poof' }),
    ]);
    [style, orb, panel].forEach((n) => root.appendChild(n));
    const $ = (id) => root.getElementById(id);
    let open = false, countdown = 0;

    function render() {
      const panel = $('panel');
      panel.classList.toggle('open', open);
      const dot = $('dot'), st = $('st');
      let txt, cls = '';
      if (performance.now() < flashUntil) { txt = flashMsg; cls = 'alert'; }
      else if (countdown > 0) { txt = 'step out… ' + countdown; cls = 'alert'; }
      else if (countdown < 0) { txt = 'saving the room…'; cls = 'alert'; }
      else if (!shared.active) { txt = 'poof · waiting for camera'; }
      else if (!shared.bg) { txt = 'poof · capture the room'; cls = 'alert'; }
      else if (shared.mode === 'gone') { txt = '👻 vanished'; cls = 'gone'; }
      else if (shared.mode === 'live') { txt = '✨ ready'; cls = 'ready'; }
      else txt = shared.mode === 'vanishing' ? '💨 poofing…' : '🌀 returning…';
      dot.className = 'dot ' + cls;
      st.textContent = txt;
    }
    uiRefresh = render;
    shared.onFrame = (() => { let last = 0; return () => { const n = performance.now(); if (n - last > 250) { last = n; render(); } }; })();

    $('st').addEventListener('click', () => { open = !open; render(); });
    $('tg').addEventListener('click', toggle);
    $('cap').addEventListener('click', () => {
      const p = shared.active;
      if (!p) return flash('no camera yet');
      countdown = 3;
      render();
      const tick = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
          clearInterval(tick);
          countdown = -1;
          render();
          p.captureBg().then(() => { countdown = 0; open = false; flash('✨ room saved'); });
        }
        render();
      }, 1000);
    });
    const sens = $('sens');
    sens.value = P.sensitivity;
    sens.addEventListener('input', () => P.setSensitivity(parseFloat(sens.value)));

    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyX') { e.preventDefault(); toggle(); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyH') { e.preventDefault(); host.style.display = host.style.display === 'none' ? '' : 'none'; }
    }, true);

    (document.body || document.documentElement).appendChild(host);
    render();
    setInterval(render, 1000);
  }

  const safeMount = () => { try { mountUI(); } catch (e) { console.error('[poof] could not draw the control orb', e); } };
  if (document.body) safeMount();
  else document.addEventListener('DOMContentLoaded', safeMount);
})();
