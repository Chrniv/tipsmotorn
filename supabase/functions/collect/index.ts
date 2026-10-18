// Tipsmotorn collector (Supabase Edge Function "collect").
// Runs every 15 minutes via pg_cron. Fetches open Stryktipset/Europatipset rounds from Svenska Spel,
// jackpots and rollovers, streck snapshots, sharp odds (throttled), and results for finished rounds.
// Secrets (Edge Functions -> Secrets): CRON_SECRET (required), ODDS_API_KEY (optional).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by Supabase.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SS = "https://api.spela.svenskaspel.se/draw/1/";
const GAMES: Record<string, string> = { stryktipset: "Stryktipset", europatipset: "Europatipset" };
const UA = { "accept": "application/json", "user-agent": "Tipsmotorn/1.0 (personal use)" };
const LEAGUE_KEYS: Record<string, string> = {"premier league":"soccer_epl","championship":"soccer_efl_champ","league one":"soccer_england_league1","league two":"soccer_england_league2","allsvenskan":"soccer_sweden_allsvenskan","superettan":"soccer_sweden_superettan","la liga":"soccer_spain_la_liga","laliga":"soccer_spain_la_liga","serie a":"soccer_italy_serie_a","serie b":"soccer_italy_serie_b","bundesliga":"soccer_germany_bundesliga","2. bundesliga":"soccer_germany_bundesliga2","ligue 1":"soccer_france_ligue_one","ligue 2":"soccer_france_ligue_two","eredivisie":"soccer_netherlands_eredivisie","eliteserien":"soccer_norway_eliteserien","champions league":"soccer_uefa_champs_league","europa league":"soccer_uefa_europa_league","conference league":"soccer_uefa_europa_conference_league","premiership":"soccer_spl","primeira liga":"soccer_portugal_primeira_liga","superligaen":"soccer_denmark_superliga","superliga":"soccer_denmark_superliga","fa cup":"soccer_fa_cup","efl cup":"soccer_england_efl_cup","super lig":"soccer_turkey_super_league","pro league":"soccer_belgium_first_div","segunda division":"soccer_spain_segunda_division","mls":"soccer_usa_mls"};

type Fetch = typeof fetch;
export interface Store {
  getRound(id: string): Promise<any | null>;
  upsertRound(row: any): Promise<void>;
  updateRound(id: string, patch: any): Promise<void>;
  upsertMatches(rows: any[]): Promise<void>;
  updateMatch(roundId: string, n: number, patch: any): Promise<void>;
  getMatches(roundId: string): Promise<any[]>;
  lastSnapshotAt(roundId: string): Promise<number | null>;
  insertSnapshot(row: any): Promise<void>;
  roundsAwaitingResults(nowIso: string): Promise<any[]>;
  insertResult(row: any): Promise<void>;
  upsertHistory(row: any): Promise<void>;
  systemsForRound(roundId: string): Promise<any[]>;
  updateSystem(id: string, patch: any): Promise<void>;
}
export interface Deps { fetch: Fetch; store: Store; now: () => number; oddsKey?: string; log?: (m: string) => void; }

export const num = (v: unknown): number | null => { if (v == null || v === "") return null; const n = Number(String(v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const triple = (o: any): number[] | null => (o && o.one != null) ? [num(o.one), num(o.x), num(o.two)] as number[] : null;
async function getJSON(f: Fetch, url: string): Promise<any> { const r = await f(url, { headers: UA }); if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}`); return await r.json(); }

// ---------- team matching (same rules as the app) ----------
const compact = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\b(fc|afc|cf|sc|ac|if|bk|ff|fk|sk)\b/g, "").replace(/[^a-z0-9]/g, "");
export function teamSim(a: string, b: string): number {
  a = compact(a); b = compact(b); if (!a || !b) return 0; if (a === b) return 2;
  const n = Math.min(a.length, b.length, 8);
  if (n >= 4 && (a.startsWith(b.slice(0, n)) || b.startsWith(a.slice(0, n)))) return 1.5;
  if (a.length >= 5 && b.length >= 5 && (a.includes(b.slice(0, 5)) || b.includes(a.slice(0, 5)))) return 1;
  return 0;
}
export function sportKey(league: string): string | null {
  const l = String(league || "").toLowerCase().trim(); if (!l) return null;
  if (LEAGUE_KEYS[l]) return LEAGUE_KEYS[l];
  const hit = Object.keys(LEAGUE_KEYS).find((x) => l.includes(x)); return hit ? LEAGUE_KEYS[hit] : null;
}
// Fetch sharp odds at most once per time window before the close: day before, same day, pre-lineup, after lineups.
export function sharpStage(closeMs: number, nowMs: number): string | null {
  const h = (closeMs - nowMs) / 3600e3;
  if (h <= 0 || h > 30) return null;
  if (h > 8) return "d"; if (h > 2) return "h"; if (h > 0.95) return "p"; return "f";
}

// ---------- open rounds ----------
export async function collectOpen(d: Deps) {
  const out: any[] = [];
  let jackpots: any[] = [];
  try { jackpots = (await getJSON(d.fetch, SS + "jackpots")).jackpots || []; } catch (e) { d.log?.("jackpots: " + e); }
  for (const g of Object.keys(GAMES)) {
    let draws: any[] = [];
    try { draws = (await getJSON(d.fetch, SS + g + "/draws")).draws || []; } catch (e) { d.log?.(`${g} draws: ${e}`); continue; }
    for (const dr of draws) {
      const id = `${g}-${dr.drawNumber}`;
      const existing = await d.store.getRound(id);
      let roll = existing ? Number(existing.roll_sale || 0) : 0;
      if (!existing) {
        try {
          const p = (await getJSON(d.fetch, `${SS}${g}/draws/${dr.drawNumber - 1}/result`)).result;
          const t = (p?.distribution || []).find((z: any) => z.winDiv === 0);
          if (p && (!t || !t.winners)) roll = num(p.currentNetSale) || 0;
        } catch (_) { /* previous round unknown: no rollover */ }
      }
      const jp = jackpots.find((z: any) => String(z.productName).toLowerCase() === g && z.drawNumber === dr.drawNumber);
      const jackpot = num((jp?.jackpots || []).find((z: any) => z.windiv === 0)?.jackpotAmount) || 0;
      const guarantee = num((jp?.guaranteedJackpots || []).find((z: any) => z.windiv === 0)?.jackpotAmount) || 0;
      const round = { id, game: GAMES[g], draw: dr.drawNumber, name: dr.regCloseDescription || null, close_at: dr.regCloseTime, state: dr.drawState,
        sale: num(dr.currentNetSale), row_price: num(dr.rowPrice) || 1, jackpot, guarantee, roll_sale: roll, updated_at: new Date(d.now()).toISOString() };
      await d.store.upsertRound(round);
      const matches = (dr.drawEvents || []).map((e: any) => {
        const ps = e.match?.participants || [];
        const home = (ps.find((p: any) => p.type === "home") || ps[0])?.name || "";
        const away = (ps.find((p: any) => p.type === "away") || ps[1])?.name || "";
        return { round_id: id, n: e.eventNumber, home, away, league: e.match?.league?.name || null, kickoff: e.match?.matchStart || null,
          odds: triple(e.odds), start_odds: triple(e.startOdds), streck: triple(e.svenskaFolket) };
      });
      if (matches.length) await d.store.upsertMatches(matches);
      // Streck/odds snapshot for drift analysis: within 5 days of the close, at most every 14 minutes.
      const closeMs = Date.parse(dr.regCloseTime), nowMs = d.now();
      let snap = false;
      if (closeMs - nowMs < 5 * 86400e3 && closeMs > nowMs && matches.length) {
        const last = await d.store.lastSnapshotAt(id);
        if (!last || nowMs - last > 14 * 60e3) { await d.store.insertSnapshot({ round_id: id, sale: round.sale, odds: matches.map((m: any) => m.odds), streck: matches.map((m: any) => m.streck) }); snap = true; }
      }
      // Sharp odds, throttled to one fetch per time window.
      let sharp = 0;
      const stage = sharpStage(closeMs, nowMs);
      if (d.oddsKey && stage && existing?.sharp_stage !== stage) {
        try { sharp = await fetchSharp(d, id, matches); await d.store.updateRound(id, { sharp_stage: stage }); }
        catch (e) { d.log?.(`sharp ${id}: ${e}`); }
      }
      out.push({ id, state: dr.drawState, matches: matches.length, jackpot, guarantee, roll, snap, sharp, stage });
    }
  }
  return out;
}

export async function fetchSharp(d: Deps, roundId: string, matches: any[]): Promise<number> {
  const keys = [...new Set(matches.map((m) => sportKey(m.league)).filter(Boolean))] as string[];
  const events: any[] = [];
  for (const k of keys) {
    const url = `https://api.the-odds-api.com/v4/sports/${k}/odds/?apiKey=${d.oddsKey}&bookmakers=pinnacle,betfair_ex_eu,betfair_ex_uk&markets=h2h&oddsFormat=decimal`;
    try { const j = await getJSON(d.fetch, url); if (Array.isArray(j)) events.push(...j); } catch (e) { d.log?.(`odds ${k}: ${e}`); }
  }
  const cands = events.map((ev) => {
    const bk = ["pinnacle", "betfair_ex_eu", "betfair_ex_uk"].map((k) => (ev.bookmakers || []).find((b: any) => b.key === k)).find(Boolean);
    const mk = bk && (bk.markets || []).find((m: any) => m.key === "h2h");
    if (!mk) return null;
    const pr = (n: string) => num(mk.outcomes.find((x: any) => x.name === n)?.price);
    const o = [pr(ev.home_team), pr("Draw"), pr(ev.away_team)];
    return o.every((x) => x != null && x > 1) ? { home: ev.home_team, away: ev.away_team, t: ev.commence_time, bk: bk.key, o } : null;
  }).filter(Boolean) as any[];
  const now = new Date(d.now()).toISOString();
  const upd: any[] = [];
  for (const m of matches) {
    let best: any = null, bs = 0;
    for (const c of cands) {
      const kt = Date.parse(m.kickoff), ct = Date.parse(c.t);
      let sc = teamSim(m.home, c.home) + teamSim(m.away, c.away);
      if (Number.isFinite(kt) && Number.isFinite(ct)) { const dt = Math.abs(kt - ct); if (dt > 3 * 3600e3) continue; if (dt <= 20 * 60e3) sc += 1; }
      if (sc > bs) { bs = sc; best = c; }
    }
    if (best && bs >= 2.5) upd.push({ round_id: roundId, n: m.n, sharp: best.o, sharp_bk: best.bk === "pinnacle" ? "Pinnacle" : "Betfair Exchange", sharp_at: now });
  }
  for (const u of upd) { const { round_id, n, ...patch } = u; await d.store.updateMatch(round_id, n, patch); }
  return upd.length;
}

// ---------- finished rounds ----------
export function gradeRows(rowsConcat: string, correct: string, tiers: any) {
  const res: any = { row: correct, best: 0, c13: 0, c12: 0, c11: 0, c10: 0 }; let payout = 0;
  for (let i = 0; i + 13 <= rowsConcat.length; i += 13) {
    const r = rowsConcat.slice(i, i + 13); let k = 0;
    for (let j = 0; j < 13; j++) if (correct[j] === "C" || r[j] === correct[j]) k++;
    if (k > res.best) res.best = k;
    if (k >= 10) { res["c" + k]++; payout += tiers?.[k]?.a || 0; }
  }
  return { result: res, payout };
}
export async function collectResults(d: Deps) {
  const out: any[] = [];
  const pending = await d.store.roundsAwaitingResults(new Date(d.now()).toISOString());
  for (const rd of pending) {
    const g = String(rd.game).toLowerCase();
    try {
      const dr = (await getJSON(d.fetch, `${SS}${g}/draws/${rd.draw}`)).draw;
      if (!dr || dr.drawState !== "Finalized") { await d.store.updateRound(rd.id, { state: dr?.drawState || rd.state }); out.push({ id: rd.id, state: dr?.drawState }); continue; }
      const r = (await getJSON(d.fetch, `${SS}${g}/draws/${rd.draw}/result`)).result;
      const byN: Record<number, any> = {}; (r.events || []).forEach((e: any) => byN[e.eventNumber] = e);
      const evs = (dr.drawEvents || []).slice().sort((a: any, b: any) => a.eventNumber - b.eventNumber);
      const correct = evs.map((e: any) => { const x = byN[e.eventNumber]; return x?.cancelled ? "C" : (x?.outcome || "?"); }).join("");
      const tiers: any = {}; (r.distribution || []).forEach((t: any) => { const k = parseInt(t.name); if (k) tiers[k] = { w: t.winners, a: num(t.amount) || 0 }; });
      const sale = num(r.currentNetSale);
      await d.store.insertResult({ round_id: rd.id, correct_row: correct, tiers, sale });
      for (const e of evs) { const x = byN[e.eventNumber]; await d.store.updateMatch(rd.id, e.eventNumber, stripUndef({ outcome: x?.cancelled ? "C" : x?.outcome || null, score: x?.outcomeScore ? `${x.outcomeScore.home}-${x.outcomeScore.away}` : null, streck: triple(e.svenskaFolket) || undefined })); }
      await d.store.updateRound(rd.id, { state: "Finalized", sale });
      await d.store.upsertHistory({ game: rd.game, draw: rd.draw, close_at: rd.close_at, sale, tiers, events: evs.map((e: any) => ({ r: byN[e.eventNumber]?.outcome || null, so: triple(e.startOdds), s: triple(e.svenskaFolket), lg: e.match?.league?.name || null, ko: e.match?.matchStart || null })) });
      let graded = 0;
      for (const s of await d.store.systemsForRound(rd.id)) { const { result, payout } = gradeRows(s.rows || "", correct, tiers); await d.store.updateSystem(s.id, { result, payout }); graded++; }
      out.push({ id: rd.id, correct, graded });
    } catch (e) { d.log?.(`result ${rd.id}: ${e}`); out.push({ id: rd.id, error: String(e) }); }
  }
  return out;
}
const stripUndef = (o: any) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ---------- history backfill (one-off, ~40 rounds per call) ----------
export async function backfill(d: Deps, game: string, from: number, to: number) {
  const g = game.toLowerCase(); let n = 0; const errors: string[] = [];
  for (let k = to; k >= from && n < 40; k--, n++) {
    try {
      const [dj, rj] = await Promise.all([getJSON(d.fetch, `${SS}${g}/draws/${k}`), getJSON(d.fetch, `${SS}${g}/draws/${k}/result`)]);
      const dr = dj.draw, r = rj.result; if (!dr || !r || r.cancelled) continue;
      const byN: Record<number, any> = {}; (r.events || []).forEach((e: any) => byN[e.eventNumber] = e);
      const tiers: any = {}; (r.distribution || []).forEach((t: any) => { const kk = parseInt(t.name); if (kk) tiers[kk] = { w: t.winners, a: num(t.amount) || 0 }; });
      await d.store.upsertHistory({ game: GAMES[g], draw: k, close_at: dr.regCloseTime, sale: num(dr.currentNetSale), tiers,
        events: (dr.drawEvents || []).map((e: any) => ({ r: byN[e.eventNumber]?.cancelled ? "C" : byN[e.eventNumber]?.outcome || null, so: triple(e.startOdds), s: triple(e.svenskaFolket), lg: e.match?.league?.name || null, ko: e.match?.matchStart || null })) });
    } catch (e) { errors.push(`${k}: ${e}`); }
  }
  return { done: n, next: to - n, errors: errors.slice(0, 5) };
}

// ---------- Supabase-backed store ----------
export function supabaseStore(url: string, key: string): Store {
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const chk = (r: any) => { if (r.error) throw new Error(r.error.message); return r.data; };
  return {
    async getRound(id) { return chk(await sb.from("rounds").select("*").eq("id", id).maybeSingle()); },
    async upsertRound(row) { chk(await sb.from("rounds").upsert(row)); },
    async updateRound(id, patch) { chk(await sb.from("rounds").update(patch).eq("id", id)); },
    async upsertMatches(rows) { chk(await sb.from("matches").upsert(rows)); },
    async updateMatch(roundId, n, patch) { chk(await sb.from("matches").update(patch).eq("round_id", roundId).eq("n", n)); },
    async getMatches(roundId) { return chk(await sb.from("matches").select("*").eq("round_id", roundId).order("n")); },
    async lastSnapshotAt(roundId) { const r = chk(await sb.from("snapshots").select("taken_at").eq("round_id", roundId).order("taken_at", { ascending: false }).limit(1)); return r?.[0] ? Date.parse(r[0].taken_at) : null; },
    async insertSnapshot(row) { chk(await sb.from("snapshots").insert(row)); },
    async roundsAwaitingResults(nowIso) {
      const since = new Date(Date.parse(nowIso) - 10 * 86400e3).toISOString(), until = new Date(Date.parse(nowIso) - 90 * 60e3).toISOString();
      const rounds = chk(await sb.from("rounds").select("*").lt("close_at", until).gt("close_at", since).or("state.is.null,state.neq.Finalized"));
      return rounds || [];
    },
    async insertResult(row) { chk(await sb.from("results").upsert(row)); },
    async upsertHistory(row) { chk(await sb.from("history").upsert(row)); },
    async systemsForRound(roundId) { return chk(await sb.from("systems").select("id,rows").eq("round_id", roundId).is("result", null)) || []; },
    async updateSystem(id, patch) { chk(await sb.from("systems").update(patch).eq("id", id)); },
  };
}

// ---------- HTTP entry ----------
export async function handle(req: Request, d: Deps, secret: string | undefined): Promise<Response> {
  const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "unauthorized" }, 401);
  let body: any = {}; try { body = await req.json(); } catch (_) { /* empty body */ }
  const logs: string[] = []; d.log = (m) => logs.push(m);
  if (body.backfill) { const b = body.backfill; return json({ backfill: await backfill(d, b.game, +b.from, +b.to), logs }); }
  const open = await collectOpen(d);
  const results = await collectResults(d);
  return json({ ok: true, open, results, logs });
}

if (!Deno.env.get("TM_TEST")) {
  Deno.serve((req) => handle(req, {
    fetch, now: () => Date.now(), oddsKey: Deno.env.get("ODDS_API_KEY") || undefined,
    store: supabaseStore(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
  }, Deno.env.get("CRON_SECRET")));
}
