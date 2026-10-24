// Writes data/fixtures.json: open Stryktipset and Europatipset rounds with their matches, straight from Svenska Spel.
// Run by .github/workflows/fixtures.yml on a schedule; the scheduled news tasks read this file.
import { writeFileSync, mkdirSync } from "node:fs";
const SS = "https://api.spela.svenskaspel.se/draw/1/";
const num = (v) => (v == null || v === "") ? null : Number(String(v).replace(/\s/g, "").replace(",", "."));
const triple = (o) => o && o.one != null ? [num(o.one), num(o.x), num(o.two)] : null;
const rounds = [];
for (const g of ["stryktipset", "europatipset"]) {
  const r = await fetch(SS + g + "/draws", { headers: { accept: "application/json", "user-agent": "Tipsmotorn/1.0 (personal use)" } });
  if (!r.ok) { console.error(g, r.status); process.exitCode = 1; continue; }
  for (const d of (await r.json()).draws || []) {
    rounds.push({ id: `${g}-${d.drawNumber}`, game: d.productName, draw: d.drawNumber, name: d.regCloseDescription, close: d.regCloseTime,
      matches: (d.drawEvents || []).map((e) => { const ps = e.match?.participants || [];
        return { n: e.eventNumber, home: (ps.find((p) => p.type === "home") || ps[0])?.name, away: (ps.find((p) => p.type === "away") || ps[1])?.name,
          league: e.match?.league?.name || null, kickoff: e.match?.matchStart || null, odds: triple(e.odds), streck: triple(e.svenskaFolket) }; }) });
  }
}
rounds.sort((a, b) => Date.parse(a.close) - Date.parse(b.close));
mkdirSync("out", { recursive: true });
writeFileSync("out/fixtures.json", JSON.stringify({ rounds }, null, 1) + "\n");
console.log(rounds.map((r) => `${r.id} ${r.close} ${r.matches.length}`).join("\n"));
