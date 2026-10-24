/* Copyright (c) 2026 protwoy. Released under the MIT License (see LICENSE). */
(function (root) {
  "use strict";

  const CLASSES = [
    ["S_CHAIR", "Shovan Chair"],
    ["SHOVAN", "Shovan"],
    ["SNIGDHA", "Snigdha"],
    ["SHULOV", "Shulov"],
    ["F_SEAT", "First Seat"],
    ["F_CHAIR", "First Chair"],
    ["F_BERTH", "First Berth"],
    ["AC_S", "AC Seat"],
    ["AC_CHAIR", "AC Chair"],
    ["AC_B", "AC Berth"],
  ];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function isoToApi(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    return m ? `${m[3]}-${MON[+m[2] - 1]}-${m[1]}` : null;
  }

  function apiToIso(s) {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || "").trim());
    if (!m) return null;
    const i = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    return i < 0 ? null : `${m[3]}-${String(i + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++)
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

  function fixStation(raw, known) {
    const t = String(raw || "")
      .replace(/\b(railway station|station|junction|jn)\b\.?/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) return "";
    const low = t.toLowerCase();
    const exact = known.find((k) => k.toLowerCase() === low);
    if (exact) return exact;
    const lim = low.length > 6 ? 2 : 1;
    const near = known
      .map((k) => ({ k, d: lev(k.toLowerCase(), low) }))
      .filter((x) => x.d <= lim)
      .sort((a, b) => a.d - b.d);
    if (near.length && (near.length === 1 || near[0].d < near[1].d)) return near[0].k;
    return titleCase(t);
  }

  function trainId(trip) {
    const s = String(trip || "");
    const m = s.match(/\((\d+)\)/);
    return m ? m[1] : s.trim().toLowerCase();
  }

  function findRoutes(counts, n, fi, ti, maxGap, sortBy) {
    const out = [];
    const LIMIT = 4000;
    let budget = 400000;
    const seats = (a, b) => {
      const c = counts[a + "," + b];
      return c && c.online > 0 ? c : null;
    };

    function walk(p, segs, gaps) {
      if (budget-- <= 0 || out.length >= LIMIT) return;
      if (p >= ti) {
        if (segs.some((s) => s.ticket)) out.push({ segs, gaps });
        return;
      }
      const starts = segs.length ? [p] : Array.from({ length: p + 1 }, (_, i) => i);
      for (const a of starts) {
        for (let b = n - 1; b > p; b--) {
          const c = seats(a, b);
          if (c) walk(b, segs.concat([{ ticket: true, a, b, c }]), gaps);
        }
      }
      if (gaps < maxGap) {
        const last = segs[segs.length - 1];
        if (last && !last.ticket) {
          walk(p + 1, segs.slice(0, -1).concat([{ ticket: false, a: last.a, b: p + 1 }]), gaps + 1);
        } else {
          walk(p + 1, segs.concat([{ ticket: false, a: p, b: p + 1 }]), gaps + 1);
        }
      }
    }
    walk(fi, [], 0);

    for (const r of out) {
      const t = r.segs.filter((s) => s.ticket);
      r.tickets = t.length;
      r.minSeats = Math.min(...t.map((s) => s.c.online));
      r.fare = t.reduce((sum, s) => sum + (Number(s.c.fare) || 0), 0);
      r.extra = t.reduce((sum, s) => sum + Math.max(0, fi - s.a) + Math.max(0, s.b - ti), 0);
    }
    const byTickets = (a, b) =>
      a.gaps - b.gaps || a.tickets - b.tickets || a.extra - b.extra || b.minSeats - a.minSeats || a.fare - b.fare;
    const byFare = (a, b) =>
      a.fare - b.fare || a.gaps - b.gaps || a.tickets - b.tickets || b.minSeats - a.minSeats;
    out.sort(sortBy === "fare" ? byFare : byTickets);
    return out;
  }

  function heatLight(online) {
    const t = Math.min(1, Math.log2(online + 1) / Math.log2(41));
    return Math.round(84 - t * 54);
  }

  function parseClock(s) {
    const m = /(\d{1,2})[:.](\d{2})\s*([ap]\.?m)?/i.exec(String(s == null ? "" : s));
    if (!m) return null;
    let h = +m[1];
    const mi = +m[2];
    const ap = (m[3] || "").toLowerCase().replace(".", "");
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return h > 23 || mi > 59 ? null : h * 60 + mi;
  }
  function fmtClock(min) {
    if (min == null) return "";
    min = ((min % 1440) + 1440) % 1440;
    let h = Math.floor(min / 60);
    const m = min % 60;
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, "0")} ${ap}`;
  }

  function absoluteTimes(stops) {
    let day = 0, prev = -1;
    const lift = (v) => {
      if (v == null) return null;
      if (v + day * 1440 < prev) day++;
      prev = v + day * 1440;
      return prev;
    };
    stops.forEach((s) => {
      s.tArr = lift(parseClock(s.arr));
      s.tDep = lift(parseClock(s.dep));
    });
    return stops;
  }

  const NAME_KEYS = ["city_name", "station_name", "stoppage_name", "stop_name", "city", "station", "stoppage", "name"];
  function stopFrom(x) {
    if (!x || typeof x !== "object") return null;
    let name = "";
    for (const k of NAME_KEYS) {
      const v = x[k];
      if (typeof v === "string" && v.trim()) { name = v; break; }
      if (v && typeof v === "object") {
        const inner = NAME_KEYS.map((kk) => v[kk]).find((t) => typeof t === "string" && t.trim());
        if (inner) { name = inner; break; }
      }
    }
    name = name.replace(/\s+/g, " ").trim();
    if (!name) return null;
    const keys = Object.keys(x).filter((k) => x[k] != null && typeof x[k] !== "object");
    const arrK = keys.find((k) => /arriv|^arr/i.test(k) && parseClock(x[k]) != null);
    const depK = keys.find((k) => /depart|^dep/i.test(k) && parseClock(x[k]) != null);
    return { name, arr: arrK ? String(x[arrK]) : "", dep: depK ? String(x[depK]) : "" };
  }
  function parseRoute(json) {
    let best = null;
    (function walk(o, d) {
      if (!o || d > 5) return;
      if (Array.isArray(o)) {
        const objs = o.filter((x) => x && typeof x === "object" && !Array.isArray(x));
        if (objs.length >= 3 && objs.length === o.length) {
          const rows = objs.map(stopFrom);
          if (rows.every(Boolean) && (!best || rows.length > best.length)) best = rows;
        }
        o.forEach((x) => walk(x, d + 1));
      } else if (typeof o === "object") {
        Object.values(o).forEach((x) => walk(x, d + 1));
      }
    })(json, 0);
    return best;
  }

  const api = { CLASSES, isoToApi, apiToIso, todayIso, lev, fixStation, trainId, findRoutes, heatLight, parseClock, fmtClock, absoluteTimes, parseRoute };
  root.TSF_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
