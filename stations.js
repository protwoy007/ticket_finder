/* Copyright (c) 2026 protwoy. Released under the MIT License (see LICENSE). */
(function (root) {
  "use strict";

  const aliases = [
    ["Chattogram", "Chittagong"],
    ["Cumilla", "Comilla"],
    ["Sreemangal", "Srimangal"],
    ["Bogura", "Bogra"],
    ["Biman Bandar", "Airport"],
    ["Joydebpur", "Joydebpur Junction"],
    ["Jashore", "Jessore"],
  ];

  const pools = [

    ["Dhaka", "Biman Bandar", "Tongi", "Narsingdi", "Bhairab Bazar", "Ashuganj", "Brahmanbaria", "Akhaura",
     "Kasba", "Cumilla", "Laksam", "Feni", "Mirsharai", "Sitakunda", "Chattogram"],
    ["Dhaka", "Biman Bandar", "Tongi", "Bhairab Bazar", "Ashuganj", "Brahmanbaria", "Akhaura",
     "Shaistaganj", "Sreemangal", "Kulaura", "Maulvibazar", "Sylhet"],

    ["Dhaka", "Biman Bandar", "Tongi", "Joydebpur", "Tangail", "Ullapara", "Bonarpara", "Bogura", "Santahar",
     "Joypurhat", "Hili", "Parbatipur", "Dinajpur", "Phulbari", "Birampur", "Saidpur", "Chilahati",
     "Natore", "Abdulpur", "Ishwardi", "Rajshahi", "Madhnagar", "Lalmonirhat", "Kurigram", "Panchagarh",
     "Dewanganj Bazar", "Sirajganj Bazar", "Gaibandha", "Rangpur", "Nilphamari", "Domar"],

    ["Dhaka", "Biman Bandar", "Tongi", "Joydebpur", "Mymensingh", "Jamalpur", "Dewanganj Bazar", "Tarakandi",
     "Netrokona", "Kishoreganj", "Bhairab Bazar"],

    ["Dhaka", "Gendaria", "Padma Bridge", "Faridpur", "Bhanga", "Rajbari", "Pangsha", "Kushtia", "Poradah",
     "Ishwardi", "Jessore", "Benapole", "Khulna", "Mongla", "Kaliganj", "Narail", "Noapara"],

    ["Chattogram", "Sitakunda", "Mirsharai", "Feni", "Laksam", "Cumilla", "Dohazari", "Cox's Bazar", "Chakaria"],
  ];

  const norm = (s) => String(s || "").trim().toLowerCase();
  const groupOf = (name) => aliases.find((g) => g.some((x) => norm(x) === norm(name)));
  const sameStation = (a, b) => {
    if (norm(a) === norm(b)) return true;
    const g = groupOf(a);
    if (g && g.some((x) => norm(x) === norm(b))) return true;

    const A = norm(a), B = norm(b), C = root.TSF_CORE;
    return !!C && A.length >= 6 && B.length >= 6 && C.lev(A, B) <= 1;
  };
  const variants = (name) => {
    const g = groupOf(name);
    return g ? [name, ...g.filter((x) => norm(x) !== norm(name))] : [name];
  };

  function candidates(start, end) {
    const hit = pools.filter((p) => p.some((x) => sameStation(x, start)) && p.some((x) => sameStation(x, end)));
    const inside = [], outside = [];
    const add = (list, s) => { if (!inside.some((x) => sameStation(x, s)) && !outside.some((x) => sameStation(x, s))) list.push(s); };
    for (const p of hit) {
      const a = p.findIndex((x) => sameStation(x, start)), b = p.findIndex((x) => sameStation(x, end));
      const lo = Math.min(a, b), hi = Math.max(a, b);
      p.forEach((s, k) => { if (k > lo && k < hi) add(inside, s); });
    }
    for (const p of hit) p.forEach((s) => add(outside, s));
    return [...inside, ...outside].filter((s) => !sameStation(s, start) && !sameStation(s, end));
  }
  const all = () => {
    const seen = [];
    for (const p of pools) for (const s of p) if (!seen.some((x) => sameStation(x, s))) seen.push(s);
    return seen;
  };

  root.TSF_STATIONS = { aliases, pools, sameStation, variants, candidates, all };
})(window);
