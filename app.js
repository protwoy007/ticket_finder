/* Copyright (c) 2026 protwoy. Released under the MIT License (see LICENSE). */
(function () {
  "use strict";
  if (window.__TICKET_FINDER__) return;
  window.__TICKET_FINDER__ = true;

  const C = window.TSF_CORE;
  const S = window.TSF_STATIONS;
  const BASE = "https://railspaapi.shohoz.com/v1.0/web";
  const API = BASE + "/bookings";
  const MIN_GAP_MS = 1500;
  const JITTER_MS = 400;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  (function cleanup() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith("tsf2_p|")) localStorage.removeItem(k);
      }
    } catch (e) {}
  })();

  const auth = {};
  const KEEP = ["authorization", "x-device-id", "x-device-key"];
  const remember = (k, v) => { const key = String(k).toLowerCase(); if (KEEP.includes(key)) auth[key] = v; };
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (!this._tsfOwn) remember(k, v); } catch (e) {}
    return origSet.apply(this, arguments);
  };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const h = (init && init.headers) || (input && input.headers);
      if (h) {
        if (typeof Headers !== "undefined" && h instanceof Headers) h.forEach((v, k) => remember(k, v));
        else if (Array.isArray(h)) h.forEach(([k, v]) => remember(k, v));
        else Object.keys(h).forEach((k) => remember(k, h[k]));
      }
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  const learned = new Set(store.get("tsf2_known") || []);
  function learn(names) {
    let changed = false;
    names.forEach((n) => {
      n = String(n || "").trim();
      if (n && n.length < 40 && !learned.has(n)) { learned.add(n); changed = true; }
    });
    if (changed) store.set("tsf2_known", [...learned].slice(-500));
  }
  const siteRoutes = [];
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) {
    try {
      const u = String(url);
      if (!this._tsfOwn && /railspaapi|shohoz|railway\.gov\.bd/i.test(u)) {
        this.addEventListener("load", () => {
          try {
            const j = JSON.parse(this.responseText);
            if (/search-trips/i.test(u)) {
              const tr = (j && j.data && j.data.trains) || [];
              learn(tr.flatMap((t) => [t.parent_route && t.parent_route.origin_city_name, t.parent_route && t.parent_route.destination_city_name]));
            } else if (/route/i.test(u)) {
              const stops = C.parseRoute(j);
              if (stops) { siteRoutes.push({ url: u, stops }); if (siteRoutes.length > 12) siteRoutes.shift(); }
            } else if (/station|cit(y|ies)/i.test(u)) {
              const arr = (function find(o, d) {
                if (Array.isArray(o)) return o;
                if (o && typeof o === "object" && d < 3) for (const k in o) { const r = find(o[k], d + 1); if (r) return r; }
                return null;
              })(j, 0);
              if (arr && arr.length >= 20) learn(arr.map((x) => (typeof x === "string" ? x : x && (x.name || x.city_name || x.station_name || x.title))));
            }
          } catch (e) {}
        });
      }
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  let lastReq = 0, gapSum = 0, gapN = 0, reqCount = 0;
  const resetTiming = () => { gapSum = 0; gapN = 0; };
  const avgMs = () => (gapN >= 3 ? gapSum / gapN : MIN_GAP_MS + JITTER_MS / 2 + 300);
  async function gate() {
    const wait = lastReq + MIN_GAP_MS + Math.random() * JITTER_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const now = Date.now();
    if (lastReq && now - lastReq < 60000) { gapSum += now - lastReq; gapN++; }
    lastReq = now;
    reqCount++;
  }
  function xhrGet(url) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x._tsfOwn = true;
      x.open("GET", url);
      x.setRequestHeader("Accept", "application/json");
      x.setRequestHeader("Content-Type", "application/json");
      x.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      if (auth.authorization) x.setRequestHeader("Authorization", auth.authorization);
      if (auth["x-device-id"]) x.setRequestHeader("X-Device-Id", auth["x-device-id"]);
      if (auth["x-device-key"]) x.setRequestHeader("X-Device-Key", auth["x-device-key"]);
      x.onload = () => resolve({ status: x.status, text: x.responseText });
      x.onerror = () => reject(new Error("Network error"));
      x.send();
    });
  }
  const fail = (code) => Object.assign(new Error(code), { fatal: true });
  async function getJSON(url, tries = 3) {
    let last = new Error("Request failed");
    for (let t = 1; t <= tries; t++) {
      await gate();
      try {
        const r = await xhrGet(url);
        if (r.status === 200) return JSON.parse(r.text);
        if (r.status === 401 || r.status === 403) throw fail("AUTH");
        if (r.status === 422) throw fail("BAD_INPUT");
        if (r.status === 429) { last = new Error("Too many requests"); await sleep(15000 * t); continue; }
        if (r.status >= 400 && r.status < 500) throw fail("HTTP " + r.status);
        last = new Error("HTTP " + r.status);
      } catch (e) {
        if (e.fatal) throw e;
        last = e;
      }
      await sleep(3000 * t);
    }
    throw last;
  }
  async function fetchTrains(from, to, date, cls) {
    const url =
      `${API}/search-trips-v2?from_city=${encodeURIComponent(from)}&to_city=${encodeURIComponent(to)}` +
      `&date_of_journey=${encodeURIComponent(date)}&seat_class=${encodeURIComponent(cls)}`;
    const j = await getJSON(url);
    return (j && j.data && j.data.trains) || [];
  }

  function analyse(trains, id, cls) {
    const train = trains.find((t) => C.trainId(t.trip_number) === id);
    if (!train) return false;
    const st = (train.seat_types || []).find((s) => s.type === cls);
    if (!st) return false;
    const sc = st.seat_counts || {};
    return { online: Number(sc.online) || 0, offline: Number(sc.offline) || 0, fare: Number(st.fare) || 0, oseq: st.origin_city_seq, dseq: st.destination_city_seq };
  }
  const memoKey = (ctx, a, b) => `${ctx.date}|${ctx.cls}|${ctx.id}|${a}|${b}`;
  function peek(ctx, a, b) {
    const mk = memoKey(ctx, a, b);
    if (ctx.memo.has(mk)) return { v: ctx.memo.get(mk) };
    return null;
  }
  async function fetchPair(ctx, a, b) {
    const hit = peek(ctx, a, b);
    if (hit) return hit.v;
    const v = analyse(await fetchTrains(a, b, ctx.date, ctx.cls), ctx.id, ctx.cls);
    ctx.memo.set(memoKey(ctx, a, b), v);
    return v;
  }

  const near = (a, b) => S.sameStation(a, b) || C.lev(String(a).toLowerCase(), String(b).toLowerCase()) <= 2;
  function trimTo(stops, start, end) {
    const i = stops.findIndex((s) => near(s.name, start));
    const j = stops.findIndex((s, k) => k > i && near(s.name, end));
    return i >= 0 && j > i ? stops.slice(i, j + 1) : null;
  }
  function idsOf(train) {
    const out = [], seen = new Set();
    const add = (t, r) => { const k = t + "|" + r; if ((t || r) && !seen.has(k)) { seen.add(k); out.push({ t, r }); } };
    add(train.trip_id, train.trip_route_id);
    (train.seat_types || []).forEach((s) => add(s.trip_id, s.trip_route_id));
    return out.slice(0, 2);
  }
  async function routeFromSite(ctx, train) {
    for (const { t, r } of idsOf(train)) {
      const qs = new URLSearchParams();
      if (t) qs.set("trip_id", t);
      if (r) qs.set("trip_route_id", r);
      try {
        const stops = C.parseRoute(await getJSON(`${BASE}/trips/routes?${qs}`, 1));
        const cut = stops && trimTo(stops, ctx.start, ctx.end);
        if (cut) return cut;
      } catch (e) { if (e.message === "AUTH") throw e; }
    }

    const mine = idsOf(train).flatMap(({ t, r }) => [t, r]).filter(Boolean).map(String);
    for (let k = siteRoutes.length - 1; k >= 0; k--) {
      if (!mine.some((id) => new RegExp("[=/]" + id.replace(/[^\w-]/g, "") + "(?:[&/?]|$)").test(siteRoutes[k].url))) continue;
      const cut = trimTo(siteRoutes[k].stops, ctx.start, ctx.end);
      if (cut) return cut;
    }
    return null;
  }

  async function routeByProbing(ctx, f, say, progress, stopped) {
    const { start, end, base } = ctx;
    let pool = S.candidates(start, end);
    [f.from, f.to].forEach((n) => { if (n && !S.sameStation(n, start) && !S.sameStation(n, end) && !pool.some((x) => S.sameStation(x, n))) pool.unshift(n); });
    pool = pool.slice(0, 50);

    const need = new Set();
    if (base && base.dseq > base.oseq) for (let q = base.oseq + 1; q < base.dseq; q++) need.add(q);
    const nEst = base && base.dseq > base.oseq ? base.dseq - base.oseq + 1 : 0;
    const extra = Math.max(0, (nEst * (nEst - 1)) / 2 - (nEst - 1));
    const ok = [], dropped = [];
    for (let i = 0; i < pool.length; i++) {
      if (stopped()) return null;
      if (need.size === 0 && base && base.dseq - base.oseq > 1 && ok.length) { dropped.push(...pool.slice(i)); break; }
      say(`Checking stop ${i + 1} of ${pool.length}: ${pool[i]}`);
      progress(i, pool.length, pool.length - i + extra);
      let found = null;
      for (const v of S.variants(pool[i])) {
        try {
          const r = await fetchPair(ctx, start, v);
          if (r && base && r.dseq > base.oseq && r.dseq < base.dseq) found = { name: v, dseq: r.dseq };
          break;
        } catch (e) {
          if (e.message === "AUTH") throw e;
          if (e.message !== "BAD_INPUT") break;
        }
      }
      if (found) { ok.push(found); need.delete(found.dseq); } else dropped.push(pool[i]);
    }
    ok.sort((a, b) => a.dseq - b.dseq);
    const uniq = ok.filter((x, k) => k === 0 || x.dseq !== ok[k - 1].dseq);
    learn(uniq.map((x) => x.name));
    return { stops: [{ name: start }, ...uniq.map((x) => ({ name: x.name })), { name: end }], dropped };
  }

  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.root{color-scheme:light;--bg:#f2f6f4;--card:#ffffff;--ink:#10261d;--muted:#5b7065;--line:#dbe5df;--soft:#edf3ef;--brand:#0f5a3c;--g9:#0a3d28;--g7:#0f5a3c;--g6:#1b8058;--g5:#2a9d6f;--g3:#7bc8a0;--g1:#e4f3ea;
  --gold:#f2b84b;--gold-d:#9a6a0a;--hatch:#b9cdc2;--empty:#f1f5f3;--amber-bg:#fbefc9;--amber-ink:#85580a;--focus:#1a73e8;--red:#b3261e;
  font:13px/1.5 Inter,"Segoe UI",system-ui,-apple-system,Roboto,sans-serif;color:var(--ink);position:fixed;right:20px;bottom:20px;z-index:2147483000;-webkit-font-smoothing:antialiased}
button,input,select,textarea{font:inherit;color:inherit}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,.row:focus-visible,.crow:focus-visible,.arrow:focus-visible{outline:2px solid var(--focus);outline-offset:2px}

.launch{display:flex;align-items:center;gap:10px;margin-left:auto;height:46px;padding:0 18px 0 8px;border:0;border-radius:14px;background:linear-gradient(135deg,#0a3d28,#16805a);color:#fff;font-weight:650;font-size:13.5px;cursor:pointer;box-shadow:0 2px 4px rgba(10,61,40,.25),0 12px 28px -8px rgba(10,61,40,.55);transition:transform .15s,box-shadow .15s}
.launch:hover{transform:translateY(-1px);box-shadow:0 3px 6px rgba(10,61,40,.3),0 16px 32px -8px rgba(10,61,40,.6)}
.launch img,.launch .lf{width:32px;height:32px;border-radius:9px;flex:0 0 auto}
.launch .lf{display:grid;place-items:center;background:rgba(255,255,255,.18)}
.launch svg{width:17px;height:17px}

.panel{position:fixed;right:20px;bottom:76px;width:min(1040px,96vw);height:min(820px,88vh);min-width:460px;min-height:360px;max-width:99vw;max-height:96vh;display:flex;flex-direction:column;
  background:var(--bg);border:1px solid #cfdcd4;border-radius:16px;overflow:hidden;resize:both;box-shadow:0 2px 4px rgba(10,40,28,.08),0 30px 60px -16px rgba(10,40,28,.38)}
.panel[hidden]{display:none}
.bar{position:relative;display:flex;align-items:center;gap:14px;padding:16px 20px 19px;color:#fff;cursor:move;user-select:none;touch-action:none;
  background:radial-gradient(circle at 92% -40%,rgba(242,184,75,.35),transparent 46%),linear-gradient(120deg,#0a3d28 0%,#0f5a3c 55%,#1b8058 100%)}
.bar::after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:repeating-linear-gradient(90deg,rgba(255,255,255,.34) 0 12px,transparent 12px 22px)}
.logo{width:44px;height:44px;border-radius:12px;flex:0 0 auto;box-shadow:0 0 0 2px rgba(255,255,255,.35),0 6px 14px -4px rgba(0,0,0,.4);background:#fff}
.logo.lf{display:grid;place-items:center;color:var(--brand)}
.logo svg{width:22px;height:22px}
.ttl{min-width:0}
.bar h1{margin:0;font-size:18px;line-height:1.2;font-weight:700;letter-spacing:-.2px}
.sub{margin:3px 0 0;color:rgba(255,255,255,.78);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.close{margin-left:auto;width:32px;height:32px;border-radius:9px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:19px;line-height:1;transition:background .12s}
.close:hover{background:rgba(255,255,255,.22)}
.coffee{margin-left:auto;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,255,255,.25);background:#ffdd00;color:#1a1a1a;font-size:12.5px;font-weight:650;text-decoration:none;white-space:nowrap;cursor:pointer;transition:filter .12s}
.coffee:hover{filter:brightness(.94)}
.coffee + .close{margin-left:0}
.body{flex:1;overflow:auto;padding:2px 20px 24px}

.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-top:16px;box-shadow:0 1px 2px rgba(16,38,29,.04),0 6px 16px -10px rgba(16,38,29,.12)}
.card h2{display:flex;align-items:center;margin:0 0 14px;font-size:14px;font-weight:700;letter-spacing:.1px}
.card h2::before{content:"";flex:0 0 4px;height:15px;border-radius:3px;margin-right:9px;background:linear-gradient(180deg,var(--g5),var(--g7))}
.card h2 small{margin-left:10px;color:var(--muted);font-weight:500;font-size:12px}
.sect{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.sic{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:var(--g1);color:var(--g7);flex:0 0 auto}
.sic svg{width:19px;height:19px}
.sect h2{margin:0}
.sect h2::before{display:none}
.sect p{margin:1px 0 0;color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px 14px}
label{display:block;color:#35503f;font-size:12px;font-weight:650;margin-bottom:5px}
input,select,textarea{width:100%;height:38px;padding:0 11px;border:1px solid #c9d8cf;border-radius:10px;background:#fbfdfc;transition:border-color .12s,box-shadow .12s,background .12s}
input:hover,select:hover,textarea:hover{border-color:#a6bbad}
input:focus,select:focus,textarea:focus{outline:none;background:#fff;border-color:var(--g6);box-shadow:0 0 0 3px rgba(27,128,88,.2)}
select:disabled{background:var(--soft);color:var(--muted)}
textarea{height:auto;padding:9px 11px;margin-top:8px;resize:vertical}
.check{display:flex;gap:8px;align-items:center;margin:14px 0 0;color:var(--muted);font-weight:500}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.grow{flex:1}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:38px;padding:0 16px;border-radius:10px;border:1px solid #c9d8cf;background:#fff;color:var(--ink);font-weight:650;cursor:pointer;transition:background .12s,border-color .12s,transform .12s,box-shadow .12s}
.btn:hover{background:var(--soft);border-color:#a6bbad}
.btn:active{transform:translateY(1px)}
.btn.main{border-color:#0a3d28;color:#fff;background:linear-gradient(180deg,#1b8058,#0f5a3c);box-shadow:0 1px 2px rgba(10,61,40,.4),inset 0 1px 0 rgba(255,255,255,.2)}
.btn.main:hover{background:linear-gradient(180deg,#20906a,#0c4a31);box-shadow:0 4px 12px -4px rgba(10,61,40,.6),inset 0 1px 0 rgba(255,255,255,.2)}
.btn svg{width:16px;height:16px}
.btn[disabled]{opacity:.45;cursor:default;box-shadow:none}
.btn[disabled]:hover{background:#fff;border-color:#c9d8cf}
.btn.main[disabled]:hover{background:linear-gradient(180deg,#1b8058,#0f5a3c)}
.btn.sm{height:30px;padding:0 12px;font-size:12px;border-radius:8px}
details{margin-top:14px}
summary{cursor:pointer;color:var(--muted);font-weight:650;font-size:12px}
.hint{color:var(--muted);font-size:12px;margin-top:6px}

.status{display:flex;align-items:center;gap:10px;margin-top:16px;padding:11px 14px;min-height:42px;background:#fff;border:1px solid var(--line);border-left:4px solid #aebfb5;border-radius:10px;color:var(--ink);box-shadow:0 1px 2px rgba(16,38,29,.04)}
.status::before{content:"";flex:0 0 9px;height:9px;border-radius:50%;background:#aebfb5}
.status.busy{border-left-color:var(--g5)}
.status.busy::before{background:var(--g5);animation:pulse 1.2s ease-in-out infinite}
.status.ok{border-left-color:var(--g6)}
.status.ok::before{background:var(--g6)}
.status.err{color:var(--red);font-weight:650;background:#fdf4f3;border-color:#efc9c5;border-left-color:var(--red)}
.status.err::before{background:var(--red)}
@keyframes pulse{50%{opacity:.25}}
@keyframes slide{to{background-position:28px 0}}
@media (prefers-reduced-motion:reduce){.status.busy::before,.prog i{animation:none}}
.prog{height:8px;border-radius:99px;background:#dfe9e3;overflow:hidden;margin-top:12px}
.prog i{display:block;height:100%;width:0;border-radius:99px;transition:width .25s;background:linear-gradient(90deg,var(--g6),var(--g5));background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.28) 0 7px,transparent 7px 14px),linear-gradient(90deg,var(--g6),var(--g5));background-size:28px 100%,100% 100%;animation:slide .8s linear infinite}
.notes{color:var(--muted);font-size:12px;margin:8px 2px 0}
.eta{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 16px;margin:9px 2px 0;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.eta[hidden]{display:none}
.eta strong{color:var(--ink);font-weight:700}
.eta #etaLeft{color:var(--g7);font-weight:650}
.foot{flex:0 0 auto;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 18px;border-top:1px solid var(--line);background:#fff;color:var(--muted);font-size:11.5px;letter-spacing:.03em}
.foot::before,.foot::after{content:"";width:28px;height:2px;border-radius:2px;background:var(--line)}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,320px));gap:14px;margin-top:16px}
.stat{position:relative;display:flex;align-items:center;gap:14px;border-radius:14px;padding:16px 18px;background:var(--card);border:1px solid var(--line);box-shadow:0 1px 2px rgba(16,38,29,.04),0 6px 16px -10px rgba(16,38,29,.12)}
.stat .ic{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;flex:0 0 auto}
.stat .ic svg{width:22px;height:22px}
.stat.s1 .ic{background:#e1f3e8;color:#0f5a3c}
.stat.s2 .ic{background:#dff1f2;color:#0c6b73}
.stat.s3 .ic{background:#fcefcf;color:#8a5a06}
.stat.s4 .ic{background:#e6e9fb;color:#3a45a8}
.stat .sx{min-width:0}
.stat .k{font-size:11.5px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;padding-right:26px}
.stat .v{font-size:27px;line-height:1.15;font-weight:700;margin:3px 0 4px;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.stat .b{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)}
.stat .b em{font-style:normal;font-weight:650;color:var(--ink);padding:0 7px;border-radius:6px;background:var(--soft);font-size:11.5px}
.arrow{position:absolute;top:10px;right:10px;width:26px;height:26px;border-radius:8px;border:1px solid var(--line);background:#fff;cursor:pointer;display:grid;place-items:center;color:var(--muted)}
.arrow:hover{color:var(--brand);border-color:var(--g3);background:var(--g1)}
.arrow svg{width:13px;height:13px}

.pills{display:flex;gap:10px;overflow-x:auto;padding:32px 40px 6px}
.pcol{flex:0 0 44px;text-align:center}
.ptrack{height:120px;display:flex;align-items:flex-end;justify-content:center;position:relative;border-bottom:1px solid var(--line)}
.pill{width:30px;border-radius:7px 7px 2px 2px}
.pill.hz{background:repeating-linear-gradient(135deg,var(--hatch) 0 2px,transparent 2px 7px),var(--empty);border:1px solid var(--line)}
.pill.a{background:linear-gradient(180deg,#14583c,var(--g9))}.pill.b{background:linear-gradient(180deg,var(--g5),var(--g6))}.pill.c{background:var(--g3)}.pill.d{background:var(--amber-bg);border:1px solid var(--amber-ink)}
.ptag{position:absolute;top:-28px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;border-radius:6px;font-size:11px;font-weight:650;padding:2px 8px;white-space:nowrap}
.plab{display:block;margin-top:8px;font-size:11px;color:var(--muted);max-width:46px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.mwrap{overflow:auto;max-height:46vh;border-radius:10px;border:1px solid var(--line)}
table{border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums}
th,td{padding:0;text-align:center;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
td{width:36px;min-width:36px;height:30px;font-size:12px}
thead th{position:sticky;top:0;z-index:2;background:#eef5f1;height:112px;vertical-align:bottom;font-weight:650;font-size:12px}
thead th div{writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;padding:6px 0;margin:0 auto}
thead th small,tbody th small{color:var(--muted);font-weight:500;font-size:11px}
tbody th{position:sticky;left:0;z-index:1;background:#fff;text-align:left;white-space:nowrap;padding:0 12px;font-weight:650;font-size:12px}
thead th:first-child{left:0;z-index:3}
th.me{color:var(--g6)}
td.void{background:var(--empty)}
td.h{font-weight:700;color:#fff}
td.h.lt{color:#0f1f18}
td.few{background:var(--amber-bg);color:var(--amber-ink);font-weight:700}
td.zero{background:repeating-linear-gradient(135deg,var(--hatch) 0 2px,transparent 2px 7px),var(--empty);color:var(--muted)}
td.na{color:var(--muted)}
td.err{color:var(--red);font-weight:700}
td.cover{box-shadow:inset 0 0 0 2px var(--focus)}
td.pick{box-shadow:inset 0 0 0 3px var(--ink)}
.legend{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;margin-top:14px;color:var(--muted);font-size:12px}
.ramp{display:inline-block;width:100px;height:8px;border-radius:99px;vertical-align:middle;margin:0 6px;background:linear-gradient(90deg,hsl(152 45% 84%),hsl(152 45% 30%))}
.sw{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:middle;margin-right:6px}

.head{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.head h2{margin:0 0 14px}
.row{display:flex;gap:14px;align-items:flex-start;padding:16px;margin-top:12px;border:1px solid var(--line);border-radius:14px;background:#fff;cursor:pointer;transition:border-color .12s,box-shadow .12s,background .12s}
.row:first-of-type{margin-top:0}
.row:hover{border-color:#a6bbad;box-shadow:0 6px 16px -10px rgba(16,38,29,.3)}
.row.on{border-color:var(--g6);background:linear-gradient(180deg,#f4fbf7,#fff);box-shadow:0 0 0 1px var(--g6),0 8px 20px -12px rgba(15,90,60,.5)}
.num{flex:0 0 32px;height:32px;border-radius:10px;background:var(--g1);color:var(--g7);display:grid;place-items:center;font-weight:700;font-size:13px}
.row.on .num{background:linear-gradient(180deg,var(--g6),var(--g7));color:#fff}
.mid{flex:1;min-width:0}
.mid>b{display:block;font-size:14px;font-weight:700;margin-bottom:10px}

.viz{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 0;padding:12px 14px;border-radius:12px;background:#f5faf7;border:1px solid #e1ece5}
.node{display:inline-flex;flex-direction:column;align-items:center;gap:6px;min-width:0}
.node i{width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid var(--g6);box-shadow:0 0 0 3px rgba(27,128,88,.12)}
.node.end i{background:var(--g7);border-color:var(--g7);box-shadow:0 0 0 3px rgba(15,90,60,.18)}
.node span{font-weight:650;font-size:12.5px;white-space:nowrap;max-width:110px;overflow:hidden;text-overflow:ellipsis}
.leg{display:inline-flex;flex-direction:column;align-items:center;gap:5px;margin:0 8px 6px;min-width:64px}
.leg em{font-style:normal;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--g6);white-space:nowrap}
.leg s{display:block;width:100%;height:4px;border-radius:4px;background:linear-gradient(90deg,var(--g5),var(--g7));position:relative}
.leg s::after{content:"";position:absolute;right:-2px;top:-3px;border-left:7px solid var(--g7);border-top:5px solid transparent;border-bottom:5px solid transparent}
.leg.g em{color:var(--amber-ink)}
.leg.g s{background:repeating-linear-gradient(90deg,#d9a21b 0 6px,transparent 6px 11px)}
.leg.g s::after{border-left-color:#d9a21b}
.viz.sm{padding:8px 10px;margin-top:8px}
.viz.sm .node span{font-size:12px;max-width:96px}
.viz.sm .leg{min-width:52px}

.tix{display:grid;gap:8px;margin-top:12px}
.seg{display:flex;align-items:center;gap:12px;padding:9px 12px;border:1px solid var(--line);border-left:4px solid var(--g6);border-radius:10px;background:#fbfdfc;font-size:12.5px}
.seg.g{border-left-color:#d9a21b;background:#fffaf0}
.seg .tg{flex:0 0 68px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--g6)}
.seg.g .tg{color:var(--amber-ink)}
.seg .sr{flex:1;min-width:0;font-weight:600}
.seg .sr small{color:var(--muted);font-weight:500}
.seg .mt{color:var(--muted);white-space:nowrap;font-size:12px;font-weight:600}
.tot{margin-top:12px;padding-top:10px;border-top:1px dashed var(--line);color:var(--muted);font-size:12px}
.tot strong{color:var(--ink);font-weight:700;font-size:13.5px}
.chip{flex:0 0 auto;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;background:var(--g1);color:var(--g7);border:1px solid #bfdccb;white-space:nowrap}
.chip.warn{background:var(--amber-bg);color:var(--amber-ink);border-color:#e6cf8f}
.chip.gold{background:linear-gradient(180deg,#ffd987,var(--gold));color:#5b3d00;border-color:#e0a62f}
.chip.direct{background:#e1f3e8;color:#0f5a3c}
.more{margin-top:14px}
.empty{color:var(--muted);padding:6px 0}

.presets{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin-bottom:16px;padding:10px 12px;border-radius:12px;background:var(--soft);border:1px dashed #c4d4ca}
.plabel{font-size:12px;font-weight:700;color:#35503f}
.plist{display:flex;flex-wrap:wrap;gap:6px;flex:1;min-width:0;align-items:center}
.pchip{display:inline-flex;align-items:stretch;border:1px solid #c9d8cf;border-radius:9px;background:#fff;overflow:hidden}
.pbtn{border:0;background:none;padding:5px 11px;cursor:pointer;font-weight:650;font-size:12.5px}
.pbtn small{margin-left:6px;color:var(--muted);font-weight:500;font-size:11.5px}
.pbtn:hover{background:var(--g1)}
.px{border:0;border-left:1px solid var(--line);background:#fff;padding:0 9px;cursor:pointer;color:var(--muted);font-size:15px}
.px:hover{color:var(--red);background:#fdf4f3}
.pnone{color:var(--muted);font-size:12px}

.cwrap{overflow-x:auto}
.crow{display:flex;flex-wrap:wrap;align-items:center;gap:14px 18px;padding:16px;margin-top:12px;border:1px solid var(--line);border-radius:14px;background:#fff;transition:border-color .12s,box-shadow .12s}
.crow:first-child{margin-top:0}
.crow[data-id]{cursor:pointer}
.crow[data-id]:hover{border-color:#a6bbad;box-shadow:0 6px 16px -10px rgba(16,38,29,.3)}
.crow.top{border-color:var(--g6);background:linear-gradient(180deg,#f4fbf7,#fff);box-shadow:0 0 0 1px var(--g6),0 10px 24px -14px rgba(15,90,60,.55)}
.crow.dim{background:var(--soft);border-style:dashed}
.crow.busy{border-color:var(--g3)}
.cn{flex:0 0 34px;height:34px;border-radius:11px;background:var(--g1);color:var(--g7);display:grid;place-items:center;font-weight:700;font-size:13px}
.crow.top .cn{background:linear-gradient(180deg,#ffd987,var(--gold));color:#5b3d00}
.cm{flex:1 1 340px;min-width:0}
.ctop{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.nm{font-weight:700;font-size:14px}
.cmet{display:flex;gap:8px;margin-left:auto}
.cmet div{min-width:74px;padding:7px 11px;border-radius:10px;background:var(--soft);text-align:center}
.cmet small{display:block;color:var(--muted);font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.05em}
.cmet b{display:block;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:1px}
.cmet .fare b{color:var(--g7)}
.cmsg{color:var(--muted);flex:1;min-width:140px}

.bar{background:radial-gradient(circle at 92% -40%,rgba(42,157,111,.5),transparent 50%),linear-gradient(120deg,#12154a 0%,#212780 62%,#2c3496 100%)}
.launch{background:linear-gradient(135deg,#12154a,#2c3496)}
.fld{position:relative}
.fld .fi{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:17px;height:17px;color:var(--g6);pointer-events:none;display:grid;place-items:center}
.fld .fi svg{width:17px;height:17px}
.fld input,.fld select{padding-left:37px}
.btn.ic{width:38px;padding:0}
.btn.ic svg{width:17px;height:17px}
.notes{display:flex;align-items:center;gap:6px;min-height:0}
.notes:empty{display:none}
.notes.loud{color:var(--red);font-weight:600}
.info{display:inline-grid;place-items:center;width:20px;height:20px;color:var(--g6);cursor:help;vertical-align:middle}
.info svg{width:17px;height:17px}
.info[hidden]{display:none}
.mchip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:99px;background:var(--soft);color:var(--ink);font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;margin-left:8px}
.mchip svg{width:14px;height:14px;color:var(--g6)}
.mchip.ok{background:var(--g1);color:var(--g7)}
.mchip.bad{background:#fde9e7;color:var(--red)}
.mchip.bad svg{color:var(--red)}
.head h2{margin-bottom:0}
.head{margin-bottom:14px}
.lgd{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:11.5px;color:var(--muted);font-weight:600}
.lg{display:inline-flex;align-items:center;gap:6px}
.lg svg{width:14px;height:14px;color:var(--g7)}
.lb{display:inline-block;width:22px;height:5px;border-radius:5px}
.lb.g{background:linear-gradient(90deg,var(--g5),var(--g7))}
.lb.r{background:linear-gradient(90deg,#e5484d,#c4262b)}
.jr{display:flex;align-items:flex-start;padding:14px 16px 10px;border-radius:12px;background:#f6faf8;border:1px solid #e1ece5;overflow-x:auto}
.jn,.jl{display:flex;flex-direction:column;align-items:center}
.jn{flex:0 0 auto;min-width:46px;max-width:104px}
.jl{flex:1 1 60px;min-width:60px}
.jt{height:22px;display:flex;align-items:center;justify-content:center}
.jm{height:24px;width:100%;display:flex;align-items:center;justify-content:center}
.jb{margin-top:5px;font-size:12px;font-weight:650;text-align:center;line-height:1.25;max-width:100%;overflow-wrap:anywhere}
.jl .jb{color:var(--muted);font-weight:600;font-size:11.5px}
.jn .jm i{display:grid;place-items:center;width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid var(--g6);box-shadow:0 0 0 3px rgba(27,128,88,.12)}
.jn.end .jm i{background:var(--g7);border-color:var(--g7);box-shadow:0 0 0 3px rgba(15,90,60,.18)}
.jn.chg .jm i{width:24px;height:24px;border:2px solid #f2b84b;background:#fff8e6;color:#8a5a06;box-shadow:none}
.jn.chg .jm i svg{width:13px;height:13px}
.jl .jm s{display:block;width:100%;height:6px;border-radius:6px;background:linear-gradient(90deg,var(--g5),var(--g7));position:relative}
.jl .jm s::after{content:"";position:absolute;right:-1px;top:-3px;border-left:8px solid var(--g7);border-top:6px solid transparent;border-bottom:6px solid transparent}
.jl.bad .jm s{background:linear-gradient(90deg,#e5484d,#c4262b)}
.jl.bad .jm s::after{border-left-color:#c4262b}
.jl.u .jm s{background:repeating-linear-gradient(90deg,#aebfb5 0 6px,transparent 6px 10px)}
.jl.u .jm s::after{border-left-color:#aebfb5}
.tb{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:700;color:var(--g7);background:var(--g1);border-radius:99px;padding:1px 8px;font-variant-numeric:tabular-nums}
.tb svg{width:13px;height:13px}
.jl.bad .tb{color:#b3261e;background:#fde9e7}
.jl.u .tb{color:var(--muted);background:var(--soft)}
.jr.sm{padding:10px 12px 6px;margin-top:10px}
.rt{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.rt .chip{display:inline-flex;align-items:center;gap:5px}
.rt .chip svg{width:14px;height:14px}
.nores{margin-top:2px}
.spin{display:inline-flex;animation:rot 1s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.cmet div{display:flex;flex-direction:column;align-items:center;gap:2px}
.cmet div svg{width:16px;height:16px;color:var(--g6)}
.seg .tg{display:inline-flex;align-items:center;gap:4px;flex:0 0 46px;font-size:12px;letter-spacing:0;text-transform:none}
.seg .tg svg{width:15px;height:15px}
.seg .mt{display:inline-flex;align-items:center;gap:5px}
.seg .mt svg{width:14px;height:14px;color:var(--g6)}
.more{display:inline-flex;align-items:center;gap:6px}
.more[hidden]{display:none}
.chip{display:inline-flex;align-items:center;gap:5px}
.chip svg{width:14px;height:14px}
.plabel svg{width:17px;height:17px;color:#d9a21b;display:block}
.btn.sm.ic{width:32px}
.more svg{width:16px;height:16px}
`;

  const LOGO = "data:image/png;base64,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";
  const ICON = {
    train: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M9 21l2-4M15 21l-2-4"/><circle cx="9" cy="14" r=".6" fill="currentColor"/><circle cx="15" cy="14" r=".6" fill="currentColor"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>',
    scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>',
    route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/></svg>',
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12V4h8l9 9-8 8-9-9z"/><circle cx="7.5" cy="8.5" r="1.3"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
    flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>',
    seat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h6a3 3 0 0 1 3 3v6H7z"/><path d="M5 13h14v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M8 18v3M16 18v3"/></svg>',
    ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 11v2M13 17v2"/></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3l4 4-4 4"/><path d="M21 7H8"/><path d="M7 21l-4-4 4-4"/><path d="M3 17h13"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  };

  function buildUI() {
    const host = document.createElement("div");
    host.id = "ticket-finder";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
<style>${CSS}</style>
<div class="root">
  <section class="panel" id="panel" hidden role="dialog" aria-label="Ticket Finder">
    <div class="bar" id="bar"><img class="logo" src="${LOGO}" alt=""><div class="ttl"><h1>Ticket Finder</h1><p class="sub">Bangladesh Railway</p></div><a class="coffee" href="https://www.supportkori.com/protwoy" target="_blank" rel="noopener noreferrer">&#9749; Buy me a coffee</a><button class="close" id="close" aria-label="Close panel">&times;</button></div>
    <div class="body" id="scroller">
      <div class="card" style="margin-top:16px">
        <div class="presets"><span class="plabel">${ICON.star}</span><div class="plist" id="plist"></div><button class="btn sm ic" id="psave" type="button" title="Save this route" aria-label="Save this route">${ICON.star}</button></div>
        <div class="grid">
          <div class="fld"><span class="fi">${ICON.pin}</span><input id="from" list="stl" autocomplete="off" placeholder="From" aria-label="From" title="From"></div>
          <div class="fld"><span class="fi">${ICON.flag}</span><input id="to" list="stl" autocomplete="off" placeholder="To" aria-label="To" title="To"></div>
          <div class="fld"><span class="fi">${ICON.cal}</span><input id="date" type="date" aria-label="Date" title="Date"></div>
          <div class="fld"><span class="fi">${ICON.seat}</span><select id="cls" aria-label="Class" title="Class"></select></div>
        </div>
        <datalist id="stl"></datalist>
        <div class="actions">
          <button class="btn main" id="scan">${ICON.scan}<span id="scanLabel">Scan all trains</span></button>
          <span class="grow"></span>
          <button class="btn ic" id="stop" disabled title="Stop" aria-label="Stop">${ICON.stop}</button>
          <button class="btn ic" id="copy" disabled title="Copy best routes" aria-label="Copy best routes">${ICON.copy}</button>
        </div>
      </div>
      <div class="status" id="status" aria-live="polite">Log in and search once on the site, then press Scan all trains.</div>
      <div class="prog" id="progwrap" hidden><i id="prog"></i></div>
      <div class="eta" id="eta" hidden><span id="etaCount"></span><span id="etaAt"></span><span id="etaLeft"></span></div>
      <div class="notes" id="notes"></div>
      <div class="card" id="ccompare" hidden><div class="head"><h2>Best per train<span id="cmpSub"></span><span class="info" id="cmpInfo" hidden tabindex="0">${ICON.info}</span></h2><div class="lgd"><span class="lg"><i class="lb g"></i>Seats</span><span class="lg"><i class="lb r"></i>Sold out</span><span class="lg">${ICON.swap}Change seat</span></div></div><div class="cwrap"><div class="cmp" id="cmp"></div></div></div>
      <div id="out" hidden>
        <div class="stats" id="stats"></div>
        <div class="card" id="cseats"><h2>Seats along the line</h2><div class="pills" id="pills"></div></div>
        <div class="card" id="cmatrix"><h2>All station pairs</h2>
          <div class="mwrap" id="mwrap"></div>
          <div class="legend">
            <span>Few<i class="ramp"></i>Many</span>
            <span><i class="sw" style="background:var(--amber-bg);border:1px solid var(--amber-ink)"></i>≤ 3</span>
            <span><i class="sw" style="background:repeating-linear-gradient(135deg,var(--hatch) 0 2px,transparent 2px 5px);border:1px solid var(--line)"></i>Sold out</span>
            <span><i class="sw" style="box-shadow:inset 0 0 0 2px var(--focus)"></i>Direct</span>
          </div></div>
        <div class="card" id="croutes"><div class="head"><h2><span id="rtitle">Ways to travel</span></h2><div class="lgd"><span class="lg"><i class="lb g"></i>Seats</span><span class="lg"><i class="lb r"></i>Sold out</span><span class="lg">${ICON.swap}Change seat</span></div></div><div id="routes"></div><button class="btn more" id="more" hidden title="Show more" aria-label="Show more"></button></div>
      </div>
    </div>
    <footer class="foot">Khaled 2026</footer>
  </section>
  <button class="launch" id="launch" aria-expanded="false"><img src="${LOGO}" alt="">Ticket Finder</button>
</div>`;
    document.documentElement.appendChild(host);
    return root;
  }

  function init() {
    const root = buildUI();
    const $ = (id) => root.getElementById(id);
    const panel = $("panel");
    root.querySelectorAll("img").forEach((img) => img.addEventListener("error", () => {
      const f = document.createElement("span");
      f.className = img.className ? img.className + " lf" : "lf";
      f.innerHTML = ICON.train;
      img.replaceWith(f);
    }));
    $("cls").innerHTML = C.CLASSES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
    const knownNames = () => [...new Set([...S.all(), ...learned])];
    const refreshList = () => { $("stl").innerHTML = knownNames().sort().map((n) => `<option value="${esc(n)}">`).join(""); };
    refreshList();
    $("date").min = C.todayIso();
    const say = (t, kind) => { $("status").textContent = t; $("status").className = "status" + (kind === true ? " err" : kind === "ok" ? " ok" : running ? " busy" : ""); };
    const sayMain = say;
    const note = (t, loud) => {
      const el = $("notes");
      el.className = "notes" + (loud ? " loud" : "");
      if (!t) { el.textContent = ""; return; }
      if (loud) { el.textContent = t; return; }
      el.innerHTML = `<span class="info" tabindex="0" title="${esc(t)}">${ICON.info}</span>`;
    };

    function prefill() {
      const saved = store.get("tsf2_form") || {};
      const q = new URLSearchParams(location.search);
      const set = (id, v) => { if (v && !$(id).value) $(id).value = v; };
      set("from", q.get("fromcity") || saved.from);
      set("to", q.get("tocity") || saved.to);
      set("date", C.apiToIso(q.get("doj")) || (saved.date && saved.date >= C.todayIso() ? saved.date : ""));
      const qc = q.get("class");
      if (qc && C.CLASSES.some(([v]) => v === qc)) $("cls").value = qc; else if (saved.cls) $("cls").value = saved.cls;
      $("ccompare").hidden = !results.size;
      renderPresets();
    }
    const saveForm = () => store.set("tsf2_form", { from: $("from").value, to: $("to").value, date: $("date").value, cls: $("cls").value });
    function readForm() {
      const known = knownNames();
      const from = C.fixStation($("from").value, known), to = C.fixStation($("to").value, known);
      $("from").value = from; $("to").value = to;
      saveForm();
      return { from, to, date: C.isoToApi($("date").value), iso: $("date").value, cls: $("cls").value, sort: SORT, id: "" };
    }
    const needAuth = () => { if (auth.authorization) return false; say("Not ready yet. Log in, search for a train on the site once, then try again.", true); return true; };
    const explain = (e) =>
      e.message === "AUTH" ? "Session problem. Refresh the page, search once on the site, and try again."
      : e.message === "BAD_INPUT" ? "The railway site did not accept that request. Check the station names and date."
      : "Error: " + e.message;

    const SORT = "tickets";
    let eta = null, running = false, stopFlag = false, trainsMeta = {};
    let view = { stops: [], stations: [], counts: {}, fi: 0, ti: 0, routes: [], pick: -1, sort: "tickets", shown: 8, updated: 0, iso: "" };
    const setRunning = (on) => { running = on; if (on) resetTiming(); else { eta = null; $("eta").hidden = true; } $("status").classList.toggle("busy", on && !$("status").classList.contains("err")); $("stop").disabled = !on; ["scan", "psave"].forEach((id) => ($(id).disabled = on)); };
    const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const span = (sec) => (sec < 60 ? sec + " s" : Math.floor(sec / 60) + " min " + String(sec % 60).padStart(2, "0") + " s");
    function showEta() {
      if (!eta) return;
      const left = Math.max(0, Math.round((eta.finishAt - Date.now()) / 1000));
      $("eta").hidden = false;
      $("etaCount").textContent = eta.label || `${eta.done} of ${eta.total} checked`;
      $("etaAt").innerHTML = `Finishes at <strong>${esc(clock(eta.finishAt))}</strong>`;
      $("etaLeft").textContent = left > 0 ? span(left) + " left" : "Almost done";
    }
    function progress(done, total, remaining, label) {
      $("progwrap").hidden = total === 0;
      $("prog").style.width = total ? Math.round((done / total) * 100) + "%" : "0";
      if (total) { eta = { done, total, label, finishAt: Date.now() + remaining * avgMs() }; showEta(); }
    }
    function hideProg() { eta = null; $("progwrap").hidden = true; $("eta").hidden = true; }
    setInterval(() => { if (running && eta) showEta(); }, 1000);

    const fillTrains = (trains) => {
      trainsMeta = {};
      trains.forEach((t) => { trainsMeta[C.trainId(t.trip_number)] = t; });
    };

    async function prepare(f) {
      if (!f.from || !f.to) { say("Enter From and To.", true); return null; }
      if (!f.date) { say("Pick a date.", true); return null; }
      if (needAuth()) return null;
      if (!f.id || !trainsMeta[f.id]) { say("Train not found. Press Scan all trains again.", true); return null; }
      const train = trainsMeta[f.id];
      if (!(train.seat_types || []).some((s) => s.type === f.cls)) {
        say(`${train.trip_number} has no ${f.cls.replace(/_/g, " ")} on this route. Pick another class.`, true);
        return null;
      }
      const ctx = { date: f.date, cls: f.cls, id: f.id, name: train.trip_number, memo: new Map(), train };
      ctx.memo.set(memoKey(ctx, f.from, f.to), analyse([train], f.id, f.cls));
      const pr = train.parent_route || {};
      ctx.start = String(pr.origin_city_name || "").trim();
      ctx.end = String(pr.destination_city_name || "").trim();
      ctx.base = null;
      if (ctx.start && ctx.end) {
        say(`${ctx.name} runs ${ctx.start} → ${ctx.end}. Reading the whole line…`);
        try { ctx.base = await fetchPair(ctx, ctx.start, ctx.end); } catch (e) { if (e.message === "AUTH") throw e; }
      }
      if (!ctx.base) { ctx.start = f.from; ctx.end = f.to; ctx.base = analyse([train], f.id, f.cls); note("Could not read the whole line, so only your own trip is scanned."); }
      return ctx;
    }

    async function getStops(ctx, f, prog, sayFn) {
      const say = sayFn || sayMain;
      const key = `tsf3_route|${ctx.id}|${ctx.start}|${ctx.end}`;
      { const c = store.get(key); if (Array.isArray(c) && c.length >= 2) return { stops: c, how: "saved" }; }
      say("Reading every stop of the train from the railway site…");
      let stops = await routeFromSite(ctx, ctx.train);
      let how = "site";
      if (stops) {
        try { if (stops.length > 1) await fetchPair(ctx, stops[0].name, stops[1].name); }
        catch (e) { if (e.message === "AUTH") throw e; if (e.message === "BAD_INPUT") stops = null; }
      }
      let dropped = [];
      if (!stops) {
        how = "probe";
        const r = await routeByProbing(ctx, f, say, prog || progress, () => stopFlag);
        if (!r) return null;
        stops = r.stops; dropped = r.dropped;
      }
      if (stops.length >= 2) store.set(key, stops);
      return { stops, how, dropped };
    }

    const T = (s) => (s && (s.tDep != null ? s.tDep : s.tArr));
    const fmtT = (t) => (t == null ? "" : C.fmtClock(t) + (t >= 1440 ? " +1" : ""));
    const timeOf = (s, arriving) => fmtT(arriving ? (s.tArr != null ? s.tArr : s.tDep) : (s.tDep != null ? s.tDep : s.tArr));
    const short = (n) => String(n).length > 7 ? String(n).slice(0, 6) + "…" : n;

    function renderStats() {
      const { stops, routes, fi, iso } = view;
      const best = routes[0];
      const dep = T(stops[fi]);
      let depMs = null;
      if (dep != null && iso) { const [y, m, d] = iso.split("-").map(Number); depMs = new Date(y, m - 1, d).getTime() + dep * 60000; }
      const arrow = (target, label) => `<button class="arrow" data-jump="${target}" aria-label="${label}">${ICON.up}</button>`;
      const card = (cls, icon, k, v, b, extra) => `<div class="stat ${cls}">${extra || ""}<span class="ic">${icon}</span><div class="sx"><div class="k">${k}</div><div class="v">${v}</div><div class="b">${b}</div></div></div>`;
      const cards = [
        card("s2", ICON.route, "Ways", routes.length, best ? `<em>${best.tickets}</em>${ICON.ticket.replace("<svg", "<svg width=\"14\" height=\"14\"")}` : "–", arrow("croutes", "Jump to routes")),
      ];
      if (depMs != null) cards.push(card("s4", ICON.clock, `Leaves in`, `<span id="count" data-ms="${depMs}">–</span>`, `<em>${esc(fmtT(dep))}</em>${esc(iso)}`));
      $("stats").innerHTML = cards.join("");
      root.querySelectorAll("[data-jump]").forEach((b) => (b.onclick = () => $(b.dataset.jump).scrollIntoView({ behavior: "smooth", block: "start" })));
      tick();
    }
    function tick() {
      const el = $("count");
      if (!el) return;
      const ms = +el.dataset.ms - Date.now();
      if (ms <= 0) { el.textContent = "Departed"; return; }
      const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
      el.textContent = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m ${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}s`;
    }
    setInterval(tick, 1000);

    function renderPills() {
      const { stations, counts } = view;
      const seg = stations.slice(0, -1).map((_, i) => counts[i + "," + (i + 1)]);
      const max = Math.max(1, ...seg.map((c) => (c && c.online > 0 ? c.online : 0)));
      const live = seg.filter((c) => c && c.online > 0);
      const low = live.length ? Math.min(...live.map((c) => c.online)) : null;
      let tagged = false;
      $("pills").innerHTML = seg.map((c, i) => {
        const tip = `${stations[i]} → ${stations[i + 1]}`;
        let cls, h, tag = "";
        if (!c || c.online <= 0) { cls = "hz"; h = 46; }
        else {
          const r = c.online / max;
          cls = c.online <= 3 ? "d" : r >= 0.66 ? "a" : r >= 0.33 ? "b" : "c";
          h = 30 + Math.round(r * 70);
          if (c.online === low && !tagged && live.length > 1) { tagged = true; tag = `<span class="ptag">fewest: ${c.online}</span>`; }
        }
        return `<div class="pcol" title="${esc(tip)}${c && c.online > 0 ? ": " + c.online + " seats" : c === undefined ? "" : ": none"}"><div class="ptrack">${tag}<div class="pill ${cls}" style="height:${h}%"></div></div><span class="plab">${esc(short(stations[i + 1]))}</span></div>`;
      }).join("");
    }

    function renderMatrix() {
      const { stops, stations, counts, fi, ti } = view;
      const picked = new Set();
      const r = view.routes[view.pick];
      if (r) r.segs.forEach((s) => s.ticket && picked.add(s.a + "," + s.b));
      let h = "<table><thead><tr><th><div style='writing-mode:horizontal-tb;transform:none;padding:6px 12px;text-align:left'>From ↓  To →</div></th>";
      stations.forEach((s, j) => { const tm = timeOf(stops[j], true); h += `<th class="${j === ti ? "me" : ""}"><div>${esc(s)}${tm ? ` <small>${esc(tm)}</small>` : ""}</div></th>`; });
      h += "</tr></thead><tbody>";
      stations.forEach((s, i) => {
        const tm = timeOf(stops[i], false);
        h += `<tr><th class="${i === fi ? "me" : ""}">${esc(s)}${tm ? ` <small>${esc(tm)}</small>` : ""}</th>`;
        stations.forEach((t, j) => {
          if (j <= i) { h += `<td class="void"></td>`; return; }
          const k = i + "," + j, c = counts[k];
          const ex = (i <= fi && j >= ti ? " cover" : "") + (picked.has(k) ? " pick" : "");
          const tip = esc(`${s} → ${t}`);
          if (c === undefined) h += `<td class="${ex}" title="${tip}"></td>`;
          else if (c === null) h += `<td class="err${ex}" title="${tip}: lookup failed, press Scan again">!</td>`;
          else if (c === false) h += `<td class="na${ex}" title="${tip}: this train does not run this pair">–</td>`;
          else if (c.online <= 0) h += `<td class="zero${ex}" title="${tip}: sold out online (${c.offline} at counter)">0</td>`;
          else if (c.online <= 3) h += `<td class="few${ex}" title="${tip}: ${c.online} online, ${c.offline} at counter, ৳${c.fare}">${c.online}</td>`;
          else { const l = C.heatLight(c.online); h += `<td class="h${l > 56 ? " lt" : ""}${ex}" style="background:hsl(152 45% ${l}%)" title="${tip}: ${c.online} online, ${c.offline} at counter, ৳${c.fare}">${c.online}</td>`; }
        });
        h += "</tr>";
      });
      $("mwrap").innerHTML = h + "</tbody></table>";
    }

    const segHtml = (s, n) => {
      const { stops, stations } = view;
      const a = timeOf(stops[s.a], false), b = timeOf(stops[s.b], true);
      return `<div class="seg"><span class="tg">${ICON.ticket}${n}</span><span class="sr">${esc(stations[s.a])}${a ? ` <small>${esc(a)}</small>` : ""} → ${esc(stations[s.b])}${b ? ` <small>${esc(b)}</small>` : ""}</span><span class="mt">৳${s.c.fare}<span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px">${ICON.seat}${s.c.online}</span></span></div>`;
    };
    const segLine = (s) => {
      const { stops, stations } = view;
      const a = timeOf(stops[s.a], false), b = timeOf(stops[s.b], true);
      return `${stations[s.a]}${a ? " " + a : ""} → ${stations[s.b]}${b ? " " + b : ""}  (৳${s.c.fare}, ${s.c.online} seats)`;
    };
    function renderRoutes() {
      const { routes } = view;
      const box = $("routes");
      $("rtitle").innerHTML = `Ways to travel<span class="mchip ${routes.length ? "ok" : "bad"}">${routes.length ? ICON.check : ICON.x}${routes.length}</span>`;
      if (!routes.length) {
        box.innerHTML = `<div class="nores">${lineHtml(view)}</div>`;
        $("more").hidden = true; $("copy").disabled = true;
        return;
      }
      $("copy").disabled = false;
      const shown = Math.min(view.shown, routes.length);
      box.innerHTML = routes.slice(0, shown).map((r, i) => {
        const extra = r.extra ? `<span class="chip warn" title="Pays for ${r.extra} extra stop${r.extra > 1 ? "s" : ""}">+${r.extra} ${ICON.pin}</span>` : "";
        let n = 0;
        return `<div class="row ${i === view.pick ? "on" : ""}" data-i="${i}" tabindex="0" role="button" aria-pressed="${i === view.pick}">
          <div class="num">${i + 1}</div>
          <div class="mid"><div class="rt"><span class="chip" title="Tickets">${ICON.ticket}${r.tickets}</span><span class="chip" title="Total fare">৳${r.fare}</span><span class="chip" title="Fewest seats left">${ICON.seat}${r.minSeats}</span>${extra}</div>${vizHtml(view.stations, r.segs)}<div class="tix">${r.segs.map((g) => segHtml(g, ++n)).join("")}</div></div></div>`;
      }).join("");
      $("more").hidden = shown >= routes.length;
      $("more").innerHTML = `${ICON.down}${Math.min(8, routes.length - shown)}`;
      root.querySelectorAll(".row[data-i]").forEach((el) => {
        const pick = () => { view.pick = +el.dataset.i; renderMatrix(); renderRoutes(); };
        el.onclick = pick;
        el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
      });
    }
    function recompute() {
      view.routes = C.findRoutes(view.counts, view.stations.length, view.fi, view.ti, 0, view.sort);
      view.pick = view.routes.length ? 0 : -1;
      view.shown = 8;
      renderStats(); renderPills(); renderMatrix(); renderRoutes();
    }
    $("more").onclick = () => { view.shown += 8; renderRoutes(); };

    async function scanOne(f, o) {
      const say2 = (t, k) => say(o.tag ? o.tag + " · " + t : t, k);
      const prog = o.prog || progress;
      const live = !!o.live;
      const fail = (m) => { if (live) { say(m, true); hideProg(); } return { err: m }; };
      const ctx = await prepare(f);
      if (!ctx) return { err: "Could not prepare this train." };
      if (live) note("");
      const got = await getStops(ctx, f, prog, say2);
      if (!got) { if (live) { say("Stopped."); hideProg(); } return { stopped: true }; }
      const all = got.stops;
      const stopsAll = C.absoluteTimes(all.map((x) => ({ ...x })));
      const namesAll = stopsAll.map((x) => x.name);
      const fi0 = namesAll.findIndex((x) => near(x, f.from)), ti0 = namesAll.findIndex((x) => near(x, f.to));
      if (fi0 < 0 || ti0 < 0) return fail(`${fi0 < 0 ? f.from : f.to} is not in the stop list of this train.`);
      if (fi0 >= ti0) return fail("This train runs the other way: your From comes after your To on its line.");
      const off = o.whole ? 0 : fi0;
      let stops = o.whole ? stopsAll : stopsAll.slice(fi0, ti0 + 1);
      let stations = stops.map((x) => x.name);
      if (stations.length > 40) return fail("More than 40 stops. This train has too many stops to scan.");

      const first = new Map();
      let removed = [];
      {
        const dead = new Set();
        const n0 = stations.length;
        for (let j = 1; j < n0; j++) {
          if (stopFlag) break;
          say2(`Verifying stop ${j} of ${n0 - 1}: ${stations[j]}`);
          prog(j - 1, n0 - 1, n0 - j + Math.max(0, (n0 * (n0 - 1)) / 2 - (n0 - 1)));
          let c;
          try { c = await fetchPair(ctx, stations[0], stations[j]); }
          catch (e) { if (e.message === "AUTH") throw e; c = null; }
          first.set(stations[j], c);
          if (c === false) dead.add(j);
        }
        if (stopFlag) { if (live) { say("Stopped."); hideProg(); } return { stopped: true }; }
        if (dead.has(fi0 - off) || dead.has(ti0 - off)) return fail(`${dead.has(fi0 - off) ? f.from : f.to} is not a stop of ${ctx.name}.`);
        if (dead.size) {
          removed = [...dead].map((j) => stations[j]);
          stops = stops.filter((_, j) => !dead.has(j));
          stations = stops.map((x) => x.name);
          store.set(`tsf3_route|${ctx.id}|${ctx.start}|${ctx.end}`, all.filter((_, k) => !dead.has(k - off)));
        }
      }
      const fi = stations.findIndex((x) => near(x, f.from)), ti = stations.findIndex((x) => near(x, f.to));
      if (live) refreshList();
      const how = { site: "Read all stops from the railway site", saved: "Used the saved stop list for this train", probe: "Stops found by checking known stations" }[got.how];
      const dr = (got.dropped || []).length;
      const skipped = (dr ? ` · ${dr} known station${dr > 1 ? "s" : ""} not on this train` : "") + (removed.length ? ` · removed ${removed.length} non-stop${removed.length > 1 ? "s" : ""} (${removed.join(", ")})` : "");
      const noteText = `${how}: ${stations.length} stops${stops.some((x) => T(x) != null) ? ", with times" : ", no times available"}${skipped}`;
      if (live) note(noteText);

      const V = { stops, stations, counts: {}, fi, ti, routes: [], pick: -1, sort: f.sort, shown: 8, updated: Date.now(), iso: f.iso };
      stations.forEach((n, j) => { if (j > 0 && first.has(n)) V.counts["0," + j] = first.get(n); });
      if (live) { view = V; $("out").hidden = false; }
      const pairs = [];
      for (let i = 0; i < stations.length - 1; i++) for (let j = i + 1; j < stations.length; j++) pairs.push([i, j]);
      const have = (i, j) => V.counts[i + "," + j] !== undefined;
      let todo = pairs.filter(([i, j]) => !have(i, j) && !peek(ctx, stations[i], stations[j])).length;
      let done = pairs.filter(([i, j]) => have(i, j)).length, failed = 0, lastErr = "";
      if (live) { renderStats(); renderPills(); renderMatrix(); $("routes").innerHTML = ""; $("more").hidden = true; }
      for (const [i, j] of pairs) {
        if (stopFlag) break;
        if (have(i, j)) continue;
        const had = !!peek(ctx, stations[i], stations[j]);
        say2(`Checking ${stations[i]} → ${stations[j]}`);
        try { V.counts[i + "," + j] = await fetchPair(ctx, stations[i], stations[j]); }
        catch (e) { if (e.message === "AUTH") throw e; V.counts[i + "," + j] = null; failed++; lastErr = e.message; }
        done++; if (!had) todo--;
        prog(done, pairs.length, todo);
        if (live && (done % 3 === 0 || done === pairs.length)) { V.updated = Date.now(); renderMatrix(); renderPills(); }
      }
      V.updated = Date.now();
      if (live) {
        recompute();
        hideProg();
        failed ? note(`${failed} lookup(s) failed (${lastErr}). Press Scan again to retry only those.`, true) : note(noteText);
        stopFlag ? say("Stopped. Showing what was checked so far.") : say("Done. Pick a route to see its tickets on the chart.", "ok");
      } else {
        V.routes = C.findRoutes(V.counts, V.stations.length, V.fi, V.ti, 0, V.sort);
        V.pick = V.routes.length ? 0 : -1;
      }
      return { view: V, note: noteText, failed, stopped: stopFlag };
    }

    let results = new Map(), order = [];
    const clsName = (c) => (C.CLASSES.find(([v]) => v === c) || [c, c])[1];
    const depOfTrain = (t) => {
      const raw = t && (t.departure_date_time || t.departure_time || t.departure || "");
      const m = /(\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m)?)/i.exec(String(raw));
      const v = m ? C.parseClock(m[1]) : null;
      return v == null ? "" : C.fmtClock(v);
    };
    const keyOf = (b, sort) => (sort === "fare" ? [b.fare, b.gaps, b.tickets] : [b.gaps, b.tickets, b.fare]);
    const cmpKeys = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
    const bestText = (e) => {
      if (e.state === "direct") return "One ticket, direct";
      const v = e.view;
      return e.best.segs.map((g) => `${v.stations[g.a]} → ${v.stations[g.b]}`).join("  +  ");
    };
    const depOf = (e) => (e.view ? timeOf(e.view.stops[e.view.fi], false) : "") || e.dep || "";

    const jn = (name, kind) => `<div class="jn ${kind || ""}"><span class="jt"></span><span class="jm"><i>${kind === "chg" ? ICON.swap : ""}</i></span><span class="jb">${esc(name)}</span></div>`;
    const jl = (hops, top, bottom, cls) => `<div class="jl ${cls || ""}" style="flex-grow:${Math.max(1, hops)}"><span class="jt">${top}</span><span class="jm"><s></s></span><span class="jb">${bottom || ""}</span></div>`;
    function vizHtml(stations, segs, small) {
      let out = "", k = 0;
      segs.forEach((g, idx) => {
        if (idx === 0) out += jn(stations[g.a], "end");
        k++;
        out += jl(g.b - g.a, `<b class="tb">${ICON.ticket}${k}</b>`, g.c ? "৳" + g.c.fare : "");
        out += jn(stations[g.b], idx === segs.length - 1 ? "end" : "chg");
      });
      return `<div class="jr${small ? " sm" : ""}">${out}</div>`;
    }
    function lineHtml(v, small) {
      let out = jn(v.stations[v.fi], "end");
      for (let i = v.fi; i < v.ti; i++) {
        const c = v.counts[i + "," + (i + 1)];
        const ok = c && c.online > 0, unknown = c === null || c === undefined;
        out += jl(1, ok ? `<b class="tb">${ICON.seat}${c.online}</b>` : unknown ? `<b class="tb">?</b>` : `<b class="tb">${ICON.x}</b>`, "", ok ? "" : unknown ? "u" : "bad");
        out += jn(v.stations[i + 1], i + 1 === v.ti ? "end" : "");
      }
      return `<div class="jr${small ? " sm" : ""}">${out}</div>`;
    }
    const vizFor = (e) => (e.state === "direct"
      ? `<div class="jr sm">${jn(e.from, "end")}${jl(1, `<b class="tb">${ICON.ticket}1</b>`, "৳" + e.best.fare)}${jn(e.to, "end")}</div>`
      : vizHtml(e.view.stations, e.best.segs, true));

    function renderCompare() {
      const sort = SORT;
      const settled = order.every((e) => e.state !== "wait" && e.state !== "busy");
      const rankOf = (e) => (e.best ? 0 : e.state === "none" || e.state === "failed" ? 2 : 1);
      const list = settled ? [...order].sort((a, b) => rankOf(a) - rankOf(b) || (a.best && b.best ? cmpKeys(keyOf(a.best, sort), keyOf(b.best, sort)) : 0)) : order;
      const ready = list.filter((e) => e.best).length;
      $("cmpSub").innerHTML = `<span class="mchip" title="Trains">${ICON.train}${order.length}</span><span class="mchip ok" title="With a way to travel">${ICON.check}${ready}</span>`;
      $("cmp").innerHTML = list.map((e, i) => {
        const top = settled && i === 0 && e.best;
        const chips = (top ? `<span class="chip gold" title="Best option">${ICON.star}</span>` : "") + (e.state === "direct" ? `<span class="chip direct" title="A seat is free for your whole trip">${ICON.ticket}</span>` : "");
        const lead = `<span class="cn">${i + 1}</span>`;
        if (e.best) {
          const met = `<div class="cmet"><div title="Leaves">${ICON.clock}<b>${esc(depOf(e)) || "–"}</b></div><div title="Tickets">${ICON.ticket}<b>${e.best.tickets}</b></div><div class="fare" title="Total fare">${ICON.tag}<b>৳${e.best.fare}</b></div><div title="Seats left">${ICON.seat}<b>${e.best.minSeats}</b></div></div>`;
          return `<div class="crow ${top ? "top" : ""}" data-id="${esc(e.id)}" tabindex="0" role="button">${lead}<div class="cm"><div class="ctop"><span class="nm">${esc(e.name)}</span>${chips}</div>${vizFor(e)}</div>${met}</div>`;
        }
        if (e.state === "none" && e.view) return `<div class="crow dim" data-id="${esc(e.id)}" tabindex="0" role="button">${lead}<div class="cm"><div class="ctop"><span class="nm">${esc(e.name)}</span><span class="mchip bad" title="No way to travel">${ICON.x}</span></div>${lineHtml(e.view, true)}</div></div>`;
        const icon = e.state === "busy" ? `<span class="spin" title="Scanning">${ICON.refresh}</span>` : e.state === "wait" ? `<span title="Waiting">${ICON.clock}</span>` : `<span title="${esc(e.reason || "Could not scan")}">${ICON.x}</span>`;
        return `<div class="crow ${e.state === "busy" ? "busy" : "dim"}">${lead}<div class="cm"><div class="ctop"><span class="nm">${esc(e.name)}</span><span class="mchip ${e.state === "failed" ? "bad" : ""}" style="margin-left:0">${icon}</span>${e.state === "failed" ? `<small style="color:var(--muted)">${esc(e.reason || "")}</small>` : ""}</div></div></div>`;
      }).join("");
      root.querySelectorAll(".crow[data-id]").forEach((el) => {
        const go = () => { if (!running) openTrain(el.dataset.id); };
        el.onclick = go;
        el.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } };
      });
    }
    function showView(v, text) {
      view = v;
      $("out").hidden = false;
      note(text || "");
      renderStats(); renderPills(); renderMatrix(); renderRoutes();
      $("out").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    async function openTrain(id) {
      const e = results.get(id);
      if (!e || running) return;
      if (e.view) { say(`Showing ${e.name}.`, "ok"); showView(e.view, e.note); return; }
      setRunning(true); stopFlag = false;
      try {
        const f = readForm(); f.id = id;
        const r = await scanOne(f, { whole: true, live: true });
        if (r.view) { e.view = r.view; e.note = r.note; $("out").scrollIntoView({ behavior: "smooth", block: "start" }); }
      } catch (err) { say(explain(err), true); hideProg(); }
      setRunning(false);
    }

    async function runAll(f) {
      if (!f.from || !f.to) return say("Enter From and To.", true);
      if (!f.date) return say("Pick a date.", true);
      if (needAuth()) return;
      note("");
      say(`Looking for trains ${f.from} → ${f.to} on ${f.date}…`);
      const trains = await fetchTrains(f.from, f.to, f.date, f.cls);
      fillTrains(trains);
      if (!trains.length) return say("No trains found for that class and date. Try another class or date.", true);
      const usable = trains.filter((t) => (t.seat_types || []).some((x) => x.type === f.cls));
      if (!usable.length) return say(`None of the ${trains.length} trains has ${clsName(f.cls)} on this route. Pick another class.`, true);
      results = new Map(); order = [];
      $("cmpInfo").hidden = true;
      usable.forEach((t) => {
        const id = C.trainId(t.trip_number);
        const d = analyse([t], id, f.cls);
        const e = { id, name: t.trip_number, state: "wait", dep: depOfTrain(t), from: f.from, to: f.to };
        if (d && d.online > 0) { e.state = "direct"; e.best = { tickets: 1, gaps: 0, fare: d.fare, minSeats: d.online, extra: 0, segs: [] }; }
        order.push(e); results.set(id, e);
      });
      $("out").hidden = true;
      $("ccompare").hidden = false;
      renderCompare();
      const todo = order.filter((e) => e.state === "wait");
      const direct = order.length - todo.length;
      let avgReq = 25, used = 0, doneN = 0;
      for (const e of todo) {
        if (stopFlag) break;
        e.state = "busy"; renderCompare();
        const startReq = reqCount;
        const label = `Train ${doneN + 1} of ${todo.length}`;
        const prog = (d, t, rem) => progress(doneN + (t ? d / t : 0), todo.length, rem + (todo.length - doneN - 1) * avgReq, label);
        let r;
        try { r = await scanOne({ ...f, id: e.id }, { whole: false, live: false, tag: `${label}: ${e.name}`, prog }); }
        catch (err) { if (err.message === "AUTH") throw err; r = { err: err.message }; }
        if (r.stopped || stopFlag) { e.state = "wait"; break; }
        if (r.err) { e.state = "failed"; e.reason = r.err; }
        else { e.view = r.view; e.note = r.note; e.best = r.view.routes[0] || null; e.state = e.best ? "ok" : "none"; }
        doneN++; used += reqCount - startReq; avgReq = Math.max(5, used / doneN);
        renderCompare();
      }
      hideProg();
      renderCompare();
      const extra = (direct ? ` ${direct} train${direct > 1 ? "s have" : " has"} a direct seat and ${direct > 1 ? "were" : "was"} not scanned.` : "") + (usable.length < trains.length ? ` ${trains.length - usable.length} train${trains.length - usable.length > 1 ? "s" : ""} without ${clsName(f.cls)} left out.` : "");
      const tip = `Only the stops between ${f.from} and ${f.to} are scanned in this mode.${extra}`;
      $("cmpInfo").title = tip; $("cmpInfo").hidden = false;
      note("");
      $("copy").disabled = !order.some((e) => e.best);
      stopFlag ? say("Stopped. Showing what was compared so far.") : say("Done. Click a train to see its seats and tickets.", "ok");
      $("ccompare").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function runScan() {
      if (running) return;
      setRunning(true); stopFlag = false;
      try {
        const f = readForm();
        await runAll(f);
      } catch (e) { say(explain(e), true); hideProg(); }
      setRunning(false);
    }

    const presets = () => { const p = store.get("tsf2_presets"); return Array.isArray(p) ? p : []; };
    function renderPresets() {
      const list = presets();
      $("plist").innerHTML = list.length
        ? list.map((p, i) => `<span class="pchip"><button class="pbtn" type="button" data-use="${i}">${esc(p.from)} → ${esc(p.to)}<small>${esc(clsName(p.cls))}</small></button><button class="px" type="button" data-del="${i}" aria-label="Remove saved route ${esc(p.from)} to ${esc(p.to)}">&times;</button></span>`).join("")
        : `<span class="pnone">None yet. Fill in From and To, then press Save route.</span>`;
      root.querySelectorAll("[data-use]").forEach((b) => (b.onclick = () => {
        const p = presets()[+b.dataset.use];
        if (!p || running) return;
        $("from").value = p.from; $("to").value = p.to; if (p.cls) $("cls").value = p.cls;
        trainsMeta = {};
        saveForm();
        say(`${p.from} → ${p.to} loaded. Pick a date and press Scan all trains.`);
      }));
      root.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => {
        const list2 = presets(); list2.splice(+b.dataset.del, 1);
        store.set("tsf2_presets", list2); renderPresets();
      }));
    }
    $("psave").onclick = () => {
      const f = readForm();
      if (!f.from || !f.to) return say("Enter From and To first.", true);
      const list = presets().filter((p) => !(p.from === f.from && p.to === f.to && p.cls === f.cls));
      list.unshift({ from: f.from, to: f.to, cls: f.cls });
      store.set("tsf2_presets", list.slice(0, 12));
      renderPresets();
      say(`Saved ${f.from} → ${f.to} (${clsName(f.cls)}).`, "ok");
    };

    $("scan").onclick = runScan;
    $("stop").onclick = () => { stopFlag = true; say("Stopping…"); };
    $("copy").onclick = async () => {
      const onCompare = !$("ccompare").hidden && $("out").hidden;
      const sortNow = SORT;
      const ranked = order.filter((e) => e.best).sort((a, b) => cmpKeys(keyOf(a.best, sortNow), keyOf(b.best, sortNow)));
      const text = onCompare ? ranked.slice(0, 3).map((e, i) => `${i + 1}. ${e.name}: ${bestText(e)}\n${e.best.tickets} ticket${e.best.tickets > 1 ? "s" : ""}, total about ৳${e.best.fare}`).join("\n\n") : view.routes.slice(0, 3).map((r, i) => `Option ${i + 1}\n` + r.segs.map(segLine).join("\n") + `\nTotal about ৳${r.fare}`).join("\n\n");
      try { await navigator.clipboard.writeText(text); say("Copied the best routes."); } catch (e) { say("Could not copy. Select the text and copy it by hand.", true); }
    };
    const toggle = (open) => { panel.hidden = !open; $("launch").setAttribute("aria-expanded", String(open)); if (open) prefill(); };
    $("launch").onclick = () => toggle(panel.hidden);
    $("close").onclick = () => toggle(false);
    root.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) toggle(false); });
    $("bar").addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, a")) return;
      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + "px"; panel.style.top = r.top + "px"; panel.style.right = "auto"; panel.style.bottom = "auto";
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => { panel.style.left = Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx)) + "px"; panel.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + "px"; };
      const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
