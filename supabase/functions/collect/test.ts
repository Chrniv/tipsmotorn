// Run: TM_TEST=1 deno run --allow-env test.ts
import { collectOpen, collectResults, gradeRows, handle, sharpStage, teamSim, type Store } from "./index.ts";

const assert = (c: unknown, m: string) => { if (!c) { throw new Error("FAIL: " + m); } console.log("ok  " + m); };
const teams = [["Nottingham","Arsenal","Premier League"],["Leeds","Manchester United","Premier League"],["Brighton","Crystal Palace","Premier League"],["Bournemouth","Sunderland","Premier League"],["Juventus","Lazio","Serie A"],["Milan","Atalanta","Serie A"],["Fiorentina","Como","Serie A"],["Málaga","Real Sociedad","La Liga"],["Celta de Vigo","Alavés","La Liga"],["Bayer Leverkusen","Freiburg","Bundesliga"],["Paris FC","Rennes","Ligue 1"],["Malmö","Häcken","Allsvenskan"],["Örgryte","GAIS","Allsvenskan"]];
const ev = (i: number, ko: string) => ({ eventNumber: i + 1, odds: { one: "2,10", x: "3,40", two: "3,60" }, startOdds: { one: "2,05", x: "3,45", two: "3,70" }, svenskaFolket: { one: "48", x: "27", two: "25" },
  match: { matchStart: ko, league: { name: teams[i][2] }, participants: [{ type: "home", name: teams[i][0] }, { type: "away", name: teams[i][1] }] } });
let NOW = Date.parse("2026-10-18T13:30:00+02:00");
const close = "2026-10-18T14:59:00+02:00";
const euroDraw = { drawNumber: 2617, regCloseDescription: "Europatipset v 42, stänger 2026-10-18 14:59", regCloseTime: close, drawState: "Open", currentNetSale: "4567000,00", rowPrice: "1,00", drawEvents: teams.map((_, i) => ev(i, "2026-10-18T15:00:00+02:00")) };
const strykFinal = { drawNumber: 4975, regCloseTime: "2026-10-17T15:59:00+02:00", drawState: "Finalized", currentNetSale: "24100000,00", drawEvents: teams.map((_, i) => ev(i, "2026-10-17T16:00:00+02:00")) };
const row = "22111222X2112";
const strykResult = { cancelled: false, currentNetSale: "24100000,00", events: row.split("").map((o, i) => ({ eventNumber: i + 1, outcome: o, outcomeScore: { home: 1, away: 0 }, cancelled: false })),
  distribution: [{ winDiv: 0, winners: 61, amount: "102000,00", name: "13 rätt" }, { winDiv: 1, winners: 1500, amount: "1500,00", name: "12 rätt" }, { winDiv: 2, winners: 18000, amount: "104,00", name: "11 rätt" }, { winDiv: 3, winners: 120000, amount: "30,00", name: "10 rätt" }] };
const routes: Record<string, any> = {
  "draw/1/jackpots": { jackpots: [{ productName: "Europatipset", drawNumber: 2617, jackpots: [{ windiv: 0, jackpotAmount: "3500000,00" }], guaranteedJackpots: [] }] },
  "draw/1/stryktipset/draws": { draws: [] },
  "draw/1/europatipset/draws": { draws: [euroDraw] },
  "draw/1/europatipset/draws/2616/result": { result: { currentNetSale: "4872503,00", distribution: [{ winDiv: 0, winners: 0, amount: "0", name: "13 rätt" }] } },
  "draw/1/stryktipset/draws/4975": { draw: strykFinal },
  "draw/1/stryktipset/draws/4975/result": { result: strykResult },
};
let oddsCalls = 0;
const mockFetch = (async (url: string) => {
  const u = String(url);
  if (u.includes("the-odds-api.com")) {
    oddsCalls++;
    const sport = u.split("/sports/")[1].split("/")[0];
    const list = teams.filter(t => ({ "Premier League": "soccer_epl", "Serie A": "soccer_italy_serie_a", "La Liga": "soccer_spain_la_liga", "Bundesliga": "soccer_germany_bundesliga", "Ligue 1": "soccer_france_ligue_one", "Allsvenskan": "soccer_sweden_allsvenskan" } as any)[t[2]] === sport)
      .map(t => ({ home_team: t[0] === "Nottingham" ? "Nottingham Forest" : t[0] === "Leeds" ? "Leeds United" : t[0] === "Malmö" ? "Malmo FF" : t[0], away_team: t[1] === "Manchester United" ? "Manchester United" : t[1] === "Häcken" ? "BK Hacken" : t[1], commence_time: "2026-10-18T13:00:00Z",
        bookmakers: [{ key: "pinnacle", markets: [{ key: "h2h", outcomes: [{ name: t[0] === "Nottingham" ? "Nottingham Forest" : t[0] === "Leeds" ? "Leeds United" : t[0] === "Malmö" ? "Malmo FF" : t[0], price: 2.05 }, { name: "Draw", price: 3.5 }, { name: t[1] === "Häcken" ? "BK Hacken" : t[1], price: 3.8 }] }] }] }));
    return new Response(JSON.stringify(list), { status: 200 });
  }
  const key = u.replace("https://api.spela.svenskaspel.se/", "");
  if (routes[key]) return new Response(JSON.stringify(routes[key]), { status: 200 });
  return new Response("{}", { status: 500 });
}) as typeof fetch;

const db: any = { rounds: {}, matches: {}, snapshots: [], results: {}, history: {}, systems: { s1: { id: "s1", round_id: "stryktipset-4975", rows: "22111222X2112" + "11111111111111".slice(0, 13), result: null } } };
const store: Store = {
  async getRound(id) { return db.rounds[id] || null; },
  async upsertRound(r) { db.rounds[r.id] = { ...(db.rounds[r.id] || {}), ...r }; },
  async updateRound(id, p) { if (!db.rounds[id]) throw new Error('update of missing round'); Object.assign(db.rounds[id], p); },
  async updateMatch(id, n, p) { const k = id + '#' + n; if (!db.matches[k]) { db.matches[k] = { round_id: id, n }; } Object.assign(db.matches[k], p); },
  async upsertMatches(rows) { rows.forEach(r => { const k = r.round_id + "#" + r.n; db.matches[k] = { ...(db.matches[k] || {}), ...r }; }); },
  async getMatches(id) { return Object.values(db.matches).filter((m: any) => m.round_id === id); },
  async lastSnapshotAt(id) { const s = db.snapshots.filter((x: any) => x.round_id === id); return s.length ? s[s.length - 1].t : null; },
  async insertSnapshot(r) { db.snapshots.push({ ...r, t: NOW }); },
  async roundsAwaitingResults(nowIso) { const now = Date.parse(nowIso); return Object.values(db.rounds).filter((r: any) => Date.parse(r.close_at) < now - 90 * 60e3 && Date.parse(r.close_at) > now - 10 * 86400e3 && r.state !== "Finalized"); },
  async insertResult(r) { db.results[r.round_id] = r; },
  async upsertHistory(r) { db.history[r.game + r.draw] = r; },
  async systemsForRound(id) { return Object.values(db.systems).filter((s: any) => s.round_id === id && !s.result); },
  async updateSystem(id, p) { Object.assign(db.systems[id], p); },
};
const deps = { fetch: mockFetch, store, now: () => NOW, oddsKey: "test-key", log: (m: string) => console.log("  log:", m) };

// unit checks
assert(teamSim("Nottingham", "Nottingham Forest") >= 1.5, "team match Nottingham / Nottingham Forest");
assert(teamSim("Malmö", "Malmo FF") >= 1.5, "team match Malmö / Malmo FF");
assert(sharpStage(Date.parse(close), NOW) === "p", "stage 1.5h before close is pre-lineup");
assert(sharpStage(Date.parse(close), Date.parse("2026-10-17T21:00:00+02:00")) === "d", "stage evening before is day-before");
assert(sharpStage(Date.parse(close), Date.parse("2026-10-16T12:00:00+02:00")) === null, "no sharp fetch >30h before");

// open round
const o1 = await collectOpen(deps);
const r = db.rounds["europatipset-2617"];
assert(r && r.jackpot === 3500000, "jackpot read from jackpots endpoint");
assert(r.roll_sale === 4872503, "rollover detected from previous round without 13-rätt winners");
assert(Object.values(db.matches).filter((m: any) => m.round_id === "europatipset-2617").length === 13, "13 matches stored");
const m1 = db.matches["europatipset-2617#1"];
assert(m1.odds[0] === 2.1 && m1.streck[0] === 48 && m1.start_odds[2] === 3.7, "odds, streck and start odds parsed with Swedish decimals");
assert(o1[0].sharp === 13 && db.matches["europatipset-2617#12"].sharp_bk === "Pinnacle", "sharp odds matched for all 13 matches incl. Malmö/Häcken");
assert(db.rounds["europatipset-2617"].sharp_stage === "p", "sharp stage recorded so the next run skips the fetch");
assert(db.snapshots.length === 1, "snapshot stored");
const calls1 = oddsCalls;
NOW += 15 * 60e3; await collectOpen(deps);
assert(oddsCalls === calls1, "no new sharp fetch within the same time window (credits saved)");
assert(db.snapshots.length === 2, "second snapshot after 15 min");
NOW = Date.parse("2026-10-18T14:20:00+02:00"); await collectOpen(deps);
assert(oddsCalls > calls1, "sharp odds refetched after lineups window opens");

// results for a finished round with a saved system
db.rounds["stryktipset-4975"] = { id: "stryktipset-4975", game: "Stryktipset", draw: 4975, close_at: "2026-10-17T15:59:00+02:00", state: "Open" };
const res = await collectResults(deps);
assert(db.results["stryktipset-4975"].correct_row === row, "correct row built from result");
assert(db.results["stryktipset-4975"].tiers[13].a === 102000, "tier payouts parsed");
assert(db.rounds["stryktipset-4975"].state === "Finalized", "round marked finalized");
assert(db.systems.s1.result.c13 === 1 && db.systems.s1.payout === 102000, "saved system graded with payout");
assert(db.history["Stryktipset4975"].events.length === 13, "history row stored");
const again = await collectResults(deps);
assert(again.length === 0, "finalized round not processed twice");
const g = gradeRows("22111222X211" + "1", row, strykResult.distribution.reduce((a: any, t: any) => (a[parseInt(t.name)] = { a: Number(t.amount.replace(",", ".")) }, a), {}));
assert(g.result.c12 === 1 && g.payout === 1500, "12 rätt graded");

// auth
const bad = await handle(new Request("http://x", { method: "POST", body: "{}" }), deps, "s3cret");
assert(bad.status === 401, "rejects calls without the cron secret");
const good = await handle(new Request("http://x", { method: "POST", headers: { "x-cron-secret": "s3cret" }, body: "{}" }), deps, "s3cret");
assert(good.status === 200, "accepts calls with the cron secret");
console.log("ALL TESTS PASSED");
