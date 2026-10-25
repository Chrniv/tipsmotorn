// Tipsmotorn collector (Supabase Edge Function "collect").
// Runs every 15 minutes via pg_cron. Fetches open Stryktipset, Europatipset and Topptipset rounds from Svenska Spel,
// jackpots and rollovers, streck snapshots, sharp odds (throttled), and results for finished rounds.
// Secrets (Edge Functions -> Secrets): CRON_SECRET (required), ODDS_API_KEY (optional),
// ANTHROPIC_API_KEY (optional: team news via Claude with web search), NEWS_GAMES (optional, default "stryktipset,europatipset"),
// NEWS_MODEL (optional, default "claude-sonnet-5-5").
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by Supabase.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SS = "https://api.spela.svenskaspel.se/draw/1/";
// Products. Topptipset (8 matches) is listed through one "family" endpoint that covers Topptipset, Topptipset Stryk and
// Topptipset Extra; each product has its own draw numbers, so ids use the product slug, e.g. "topptipsetstryk-986".
const GAMES: Record<string, string> = { stryktipset: "Stryktipset", europatipset: "Europatipset", topptipset: "Topptipset" };
const LIST_PATH: Record<string, string> = { stryktipset: "stryktipset", europatipset: "europatipset", topptipset: "topptipsetfamily" };
export const slugOf = (productName: string) => String(productName || "").toLowerCase().replace(/[^a-z]/g, "");
export const productOfId = (id: string) => String(id).split("-")[0];
const familyOf = (slug: string) => slug.startsWith("topptipset") ? "topptipset" : slug;
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
  roundsForNews?(nowIso: string, hours?: number): Promise<any[]>;
  getNews?(roundId: string): Promise<any | null>;
  upsertNews?(roundId: string, data: any): Promise<void>;
}
export interface Deps { fetch: Fetch; store: Store; now: () => number; oddsKey?: string; log?: (m: string) => void;
  anthropicKey?: string; newsModel?: string; newsGames?: string[]; }

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
// Fetch sharp odds at most once per time window before the close: day before, same day, pre-lineup, after lineups,
// and a last one in the final 15 minutes (the collector runs every 15 minutes, so it lands 0-15 minutes before the close),
// when the odds have absorbed the starting XIs and are closest to the closing line.
export function sharpStage(closeMs: number, nowMs: number): string | null {
  const h = (closeMs - nowMs) / 3600e3;
  if (h <= 0 || h > 30) return null;
  if (h > 8) return "d"; if (h > 2) return "h"; if (h > 0.95) return "p"; if (h > 0.25) return "f"; return "z";
}

// ---------- open rounds ----------
export async function collectOpen(d: Deps) {
  const out: any[] = [];
  let jackpots: any[] = [];
  try { jackpots = (await getJSON(d.fetch, SS + "jackpots")).jackpots || []; } catch (e) { d.log?.("jackpots: " + e); }
  const oddsCache = new Map<string, any[]>(); // one Odds API call per league per run, shared by all rounds
  for (const g of Object.keys(GAMES)) {
    let draws: any[] = [];
    try { draws = (await getJSON(d.fetch, SS + LIST_PATH[g] + "/draws")).draws || []; } catch (e) { d.log?.(`${g} draws: ${e}`); continue; }
    for (const dr of draws) {
      const slug = dr.productName ? slugOf(dr.productName) : g;
      if (familyOf(slug) !== g) continue;
      const id = `${slug}-${dr.drawNumber}`;
      const existing = await d.store.getRound(id);
      // Rollover. Topptipset reports it on the draw (fund.rolloverIn + extraMoney, in kr added to the pot).
      // Stryktipset/Europatipset: if the previous draw had no top-tier winner, store its turnover; the app scales it.
      // null = not known yet (previous draw not finished), retried on the next run.
      const fund = dr.fund ? (num(dr.fund.rolloverIn) || 0) + (num(dr.fund.extraMoney) || 0) : null;
      let roll: number | null = existing && existing.roll_sale != null ? Number(existing.roll_sale) : null;
      if (fund == null && roll == null) {
        try {
          const p = (await getJSON(d.fetch, `${SS}${slug}/draws/${dr.drawNumber - 1}/result`)).result;
          const t = (p?.distribution || []).find((z: any) => z.winDiv === 0);
          roll = p ? ((!t || !t.winners) ? (num(p.currentNetSale) || 0) : 0) : null;
        } catch (_) { roll = null; }
      }
      const jp = jackpots.find((z: any) => slugOf(z.productName) === slug && z.drawNumber === dr.drawNumber);
      const jackpot = num((jp?.jackpots || []).find((z: any) => z.windiv === 0)?.jackpotAmount) || 0;
      const guarantee = num((jp?.guaranteedJackpots || []).find((z: any) => z.windiv === 0)?.jackpotAmount) || 0;
      const round = { id, game: GAMES[g], product: dr.productName || GAMES[g], draw: dr.drawNumber, name: dr.regCloseDescription || null, close_at: dr.regCloseTime, state: dr.drawState,
        sale: num(dr.currentNetSale), row_price: num(dr.rowPrice) || 1, jackpot, guarantee, roll_sale: fund == null ? roll : 0, extra: fund || 0, updated_at: new Date(d.now()).toISOString() };
      await d.store.upsertRound(round);
      const matches = (dr.drawEvents || []).map((e: any) => {
        const ps = e.match?.participants || [];
        const home = (ps.find((p: any) => p.type === "home") || ps[0])?.name || "";
        const away = (ps.find((p: any) => p.type === "away") || ps[1])?.name || "";
        return { round_id: id, n: e.eventNumber, home, away, league: e.match?.league?.name || null, kickoff: e.match?.matchStart || null,
          odds: triple(e.odds), start_odds: triple(e.startOdds), streck: triple(e.svenskaFolket) };
      });
      if (matches.length) await d.store.upsertMatches(matches);
      // Streck/odds snapshot for drift analysis: within 5 days of the close; every 14 minutes in the last day, hourly before that.
      const closeMs = Date.parse(dr.regCloseTime), nowMs = d.now();
      let snap = false;
      if (closeMs - nowMs < 5 * 86400e3 && closeMs > nowMs && matches.length) {
        const last = await d.store.lastSnapshotAt(id);
        const every = closeMs - nowMs < 86400e3 ? 14 * 60e3 : 59 * 60e3;
        if (!last || nowMs - last > every) { await d.store.insertSnapshot({ round_id: id, sale: round.sale, odds: matches.map((m: any) => m.odds), streck: matches.map((m: any) => m.streck) }); snap = true; }
      }
      // Sharp odds, throttled to one fetch per time window. Topptipset only in the pre-lineup window, to stay within the free credits.
      let sharp = 0;
      let stage = sharpStage(closeMs, nowMs);
      if (g === "topptipset" && stage !== "p") stage = null;
      if (d.oddsKey && stage && existing?.sharp_stage !== stage) {
        try { sharp = await fetchSharp(d, id, matches, oddsCache); await d.store.updateRound(id, { sharp_stage: stage }); }
        catch (e) { d.log?.(`sharp ${id}: ${e}`); }
      }
      out.push({ id, state: dr.drawState, matches: matches.length, jackpot, guarantee, roll, extra: fund || 0, snap, sharp, stage });
    }
  }
  return out;
}

export async function fetchSharp(d: Deps, roundId: string, matches: any[], cache: Map<string, any[]> = new Map()): Promise<number> {
  const keys = [...new Set(matches.map((m) => sportKey(m.league)).filter(Boolean))] as string[];
  const events: any[] = [];
  for (const k of keys) {
    if (!cache.has(k)) {
      const url = `https://api.the-odds-api.com/v4/sports/${k}/odds/?apiKey=${d.oddsKey}&bookmakers=pinnacle,betfair_ex_eu,betfair_ex_uk&markets=h2h&oddsFormat=decimal`;
      try {
        const r = await d.fetch(url, { headers: UA });
        if (!r.ok) throw new Error(`${r.status}`);
        const left = r.headers.get("x-requests-remaining"); if (left != null) d.log?.(`odds credits left: ${left}`);
        const j = await r.json(); cache.set(k, Array.isArray(j) ? j : []);
      } catch (e) { d.log?.(`odds ${k}: ${e}`); cache.set(k, []); }
    }
    events.push(...(cache.get(k) || []));
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
// Rows are stored concatenated; the row length is the number of matches (13, or 8 on Topptipset).
// Paying tiers come from the result itself, so 13/12/11/10 and Topptipset's single 8-rätt tier both work.
export function gradeRows(rowsConcat: string, correct: string, tiers: any) {
  const M = correct.length;
  const paying = Object.keys(tiers || {}).map(Number).filter((k) => k > 0);
  const low = paying.length ? Math.min(...paying) : M;
  const res: any = { row: correct, best: 0, n: M }; for (let k = low; k <= M; k++) res["c" + k] = 0;
  let payout = 0;
  if (!M) return { result: res, payout };
  for (let i = 0; i + M <= rowsConcat.length; i += M) {
    const r = rowsConcat.slice(i, i + M); let k = 0;
    for (let j = 0; j < M; j++) if (correct[j] === "C" || r[j] === correct[j]) k++;
    if (k > res.best) res.best = k;
    if (k >= low) { res["c" + k]++; payout += tiers?.[k]?.a || 0; }
  }
  return { result: res, payout };
}
export async function collectResults(d: Deps) {
  const out: any[] = [];
  const pending = await d.store.roundsAwaitingResults(new Date(d.now()).toISOString());
  for (const rd of pending) {
    const g = productOfId(rd.id);
    try {
      const dr = (await getJSON(d.fetch, `${SS}${g}/draws/${rd.draw}`)).draw;
      if (!dr || dr.drawState !== "Finalized") { await d.store.updateRound(rd.id, { state: dr?.drawState || rd.state }); out.push({ id: rd.id, state: dr?.drawState }); continue; }
      const r = (await getJSON(d.fetch, `${SS}${g}/draws/${rd.draw}/result`)).result;
      const byN: Record<number, any> = {}; (r.events || []).forEach((e: any) => byN[e.eventNumber] = e);
      const evs = (dr.drawEvents || []).slice().sort((a: any, b: any) => a.eventNumber - b.eventNumber);
      // A cancelled match is decided by lot ("Matchen lottad till en 1:a"); the drawn sign is in outcome. "C" only if it is missing.
      const correct = evs.map((e: any) => { const x = byN[e.eventNumber]; return x?.outcome || (x?.cancelled ? "C" : "?"); }).join("");
      const tiers: any = {}; (r.distribution || []).forEach((t: any) => { const k = parseInt(t.name); if (k) tiers[k] = { w: t.winners, a: num(t.amount) || 0 }; });
      const sale = num(r.currentNetSale);
      await d.store.insertResult({ round_id: rd.id, correct_row: correct, tiers, sale });
      for (const e of evs) { const x = byN[e.eventNumber]; await d.store.updateMatch(rd.id, e.eventNumber, stripUndef({ outcome: x?.outcome || (x?.cancelled ? "C" : null), score: x?.cancelled ? "lottad" : x?.outcomeScore ? `${x.outcomeScore.home}-${x.outcomeScore.away}` : null, streck: triple(e.svenskaFolket) || undefined })); }
      await d.store.updateRound(rd.id, { state: "Finalized", sale });
      await d.store.upsertHistory({ game: rd.product || rd.game, draw: rd.draw, close_at: rd.close_at, sale, tiers, events: evs.map((e: any) => ({ r: byN[e.eventNumber]?.outcome || null, c: byN[e.eventNumber]?.cancelled ? 1 : undefined, so: triple(e.startOdds), s: triple(e.svenskaFolket), lg: e.match?.league?.name || null, ko: e.match?.matchStart || null })) });
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
  const g = slugOf(game); let n = 0; const errors: string[] = [];
  for (let k = to; k >= from && n < 40; k--, n++) {
    try {
      const [dj, rj] = await Promise.all([getJSON(d.fetch, `${SS}${g}/draws/${k}`), getJSON(d.fetch, `${SS}${g}/draws/${k}/result`)]);
      const dr = dj.draw, r = rj.result; if (!dr || !r || r.cancelled) continue;
      const byN: Record<number, any> = {}; (r.events || []).forEach((e: any) => byN[e.eventNumber] = e);
      const tiers: any = {}; (r.distribution || []).forEach((t: any) => { const kk = parseInt(t.name); if (kk) tiers[kk] = { w: t.winners, a: num(t.amount) || 0 }; });
      await d.store.upsertHistory({ game: dr.productName || GAMES[g] || g, draw: k, close_at: dr.regCloseTime, sale: num(dr.currentNetSale), tiers,
        events: (dr.drawEvents || []).map((e: any) => ({ r: byN[e.eventNumber]?.outcome || null, c: byN[e.eventNumber]?.cancelled ? 1 : undefined, so: triple(e.startOdds), s: triple(e.svenskaFolket), lg: e.match?.league?.name || null, ko: e.match?.matchStart || null })) });
    } catch (e) { errors.push(`${k}: ${e}`); }
  }
  return { done: n, next: to - n, errors: errors.slice(0, 5) };
}


// ---------- team news (Claude API with web search) ----------
// Two passes per round: "d" within 26 h of the close (injuries, suspensions, form, other news) and "l" in the last
// 54 minutes (confirmed starting XIs, which English 16.00 kick-offs publish around 15.00). Each call researches at
// most NEWS_BATCH matches so it stays well within the Edge Function time limit; the 5-minute schedule picks up the rest.
export const NEWS_BATCH = 4;
export function newsStage(closeMs: number, nowMs: number): string | null {
  const h = (closeMs - nowMs) / 3600e3;
  if (h <= 0 || h > 26) return null;
  return h <= 0.9 ? "l" : "d";
}
const pct = (o: number[] | null) => { if (!o || !o.every((x) => x > 1)) return null; const v = o.map((x) => 1 / x), t = v[0] + v[1] + v[2]; return v.map((x) => Math.round(x / t * 100)); };
export function cleanSuggest(sg: any): number[] {
  if (!Array.isArray(sg) || sg.length !== 3) return [0, 0, 0];
  const a = sg.map((x) => Math.max(-5, Math.min(5, Math.round(Number(x) || 0))));
  a[1] = Math.max(-5, Math.min(5, -(a[0] + a[2]))); // keep the sum at zero
  if (a[0] + a[1] + a[2] !== 0) return [0, 0, 0];
  return a;
}
export function extractJSON(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  return JSON.parse(body);
}
function newsPrompt(rd: any, todo: any[], stage: string, prev: Record<number, any>, todayIso: string): string {
  const lines = todo.map((m) => {
    const p = pct(m.odds), s = m.streck;
    const was = prev[m.n] ? `\n   Tidigare noteringar: ${JSON.stringify({ notes: prev[m.n].notes, take: prev[m.n].take, suggest: prev[m.n].suggest })}` : "";
    return `${m.n}. ${m.home} – ${m.away} (${m.league || "okänd liga"}, avspark ${m.kickoff || "okänd"}). Oddsens sannolikhet 1/X/2: ${p ? p.join("/") + " %" : "saknas"}. Folkets streck: ${s ? s.join("/") + " %" : "saknas"}.${was}`;
  }).join("\n");
  const task = stage === "l"
    ? `Det är strax före spelstopp. Sök efter BEKRÄFTADE STARTELVOR och sena ändringar (spelare som oväntat saknas eller är tillbaka, målvaktsbyten, kraftig rotation). Behåll de tidigare noteringarna som är relevanta och lägg startelvan i fältet "lineup". Är elvan inte publicerad än, skriv det.`
    : `Sök efter allt som kan påverka utgången: skador, avstängningar, tveksamma spelare, väntad startelva och rotation (t.ex. efter europaspel eller inför cupmatch), form och tabelläge, tränarbyten, motivation, och annat relevant (resor, väder, interna problem).`;
  return `Idag är ${todayIso}. Du hjälper ett verktyg för poolspel (${rd.name || rd.id}, spelstopp ${rd.close_at}).

${task}

Matcher:
${lines}

Regler:
- Använd bara källor publicerade de senaste 7 dagarna som gäller just den här matchen. Ignorera gamla artiklar om tidigare möten.
- Oddsen speglar redan allt som varit känt några dagar. Föreslå bara en justering ("suggest", procentenheter för 1/X/2, heltal -5..5, summa 0) när en nyhet är färsk eller sannolikt inte prissatt, t.ex. en bekräftad startelva utan en nyckelspelare. Annars [0,0,0].
- Jämför gärna folkets streck med oddsen och säg om ett tecken redan är över- eller understreckat.
- Skriv på svenska, kort och sakligt, spelarnamn som i källan. "impact" är none, low, medium eller high.
- Hitta inte på. Hittar du inget, skriv det.

Svara med ENDAST ett JSON-block, en post per match:
\`\`\`json
[{"n": 1, "impact": "medium", "notes": ["Hemmalag: ...", "Bortalag: ...", "Form/tabell: ..."], "lineup": "bekräftad elva eller tom sträng", "take": "en eller två meningar om vad det betyder för tipset", "suggest": [0,0,0], "sources": [{"title": "Källa, datum", "url": "https://..."}]}]
\`\`\``;
}
export async function askClaude(d: Deps, prompt: string, maxUses: number): Promise<{ items: any[]; urls: Set<string>; searches: number }> {
  const messages: any[] = [{ role: "user", content: prompt }];
  const urls = new Set<string>(); let searches = 0; let text = "";
  for (let turn = 0; turn < 6; turn++) {
    const r = await d.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": d.anthropicKey!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: d.newsModel || "claude-sonnet-5-5", max_tokens: 6000, messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }] }),
    });
    if (!r.ok) throw new Error(`claude ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    for (const b of j.content || []) {
      if (b.type === "server_tool_use") searches++;
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach((x: any) => x.url && urls.add(x.url));
      if (b.type === "text") { text += b.text; (b.citations || []).forEach((c: any) => c.url && urls.add(c.url)); }
    }
    if (j.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: j.content });
  }
  const items = extractJSON(text);
  if (!Array.isArray(items)) throw new Error("claude answer was not a list");
  return { items, urls, searches };
}
export async function collectNews(d: Deps) {
  if (!d.anthropicKey) return { skipped: "no ANTHROPIC_API_KEY" };
  const st = d.store; if (!st.roundsForNews || !st.getNews || !st.upsertNews) return { skipped: "store" };
  const games = d.newsGames && d.newsGames.length ? d.newsGames : ["stryktipset", "europatipset"];
  const now = d.now();
  const rounds = (await st.roundsForNews(new Date(now).toISOString())).filter((r: any) => games.includes(productOfId(r.id)))
    .sort((a: any, b: any) => Date.parse(a.close_at) - Date.parse(b.close_at));
  for (const rd of rounds) {
    const stage = newsStage(Date.parse(rd.close_at), now); if (!stage) continue;
    const cur = (await st.getNews(rd.id))?.data || {};
    const done: number[] = (cur.done && cur.done[stage]) || [];
    const ms = (await st.getMatches(rd.id)).slice().sort((a: any, b: any) => a.n - b.n);
    const todo = ms.filter((m: any) => !done.includes(m.n)).slice(0, NEWS_BATCH);
    if (!todo.length) continue;
    const prev: Record<number, any> = {}; (cur.matches || []).forEach((m: any) => prev[m.n] = m);
    const { items, urls, searches } = await askClaude(d, newsPrompt(rd, todo, stage, prev, new Date(now).toISOString().slice(0, 10)), todo.length * 2 + 1);
    const at = new Date(now).toISOString();
    for (const m of todo) {
      const it = items.find((x: any) => Number(x.n) === m.n) || {};
      // Keep only sources that came back from the searches, so no invented links reach the app.
      const sources = (Array.isArray(it.sources) ? it.sources : []).filter((x: any) => x && typeof x.url === "string" && urls.has(x.url)).slice(0, 4)
        .map((x: any) => ({ title: String(x.title || "Källa").slice(0, 80), url: x.url }));
      prev[m.n] = { n: m.n, home: m.home, away: m.away,
        impact: ["none", "low", "medium", "high"].includes(it.impact) ? it.impact : "none",
        notes: (Array.isArray(it.notes) ? it.notes : []).map((x: any) => String(x).slice(0, 400)).slice(0, 6),
        lineup: it.lineup ? String(it.lineup).slice(0, 600) : (prev[m.n]?.lineup || ""),
        take: String(it.take || "").slice(0, 500), suggest: cleanSuggest(it.suggest), sources, stage, checkedAt: at };
    }
    const data = { ...cur, game: rd.game, draw: rd.draw, round: rd.name, author: "Claude (automatiskt)", updatedAt: now,
      matches: Object.values(prev).sort((a: any, b: any) => a.n - b.n),
      done: { ...(cur.done || {}), [stage]: [...done, ...todo.map((m: any) => m.n)] },
      checkedAt: { ...(cur.checkedAt || {}), [stage]: at } };
    await st.upsertNews(rd.id, data);
    return { round: rd.id, stage, matches: todo.map((m: any) => m.n), searches, remaining: ms.length - data.done[stage].length };
  }
  return { idle: true };
}

// ---------- team news from the repository (free path) ----------
// Scheduled Claude tasks research the news and commit news/<round id>.json to the "data" branch of the public repo.
// Each collector run imports a file when it is newer than what the app already has.
export const NEWS_RAW = "https://raw.githubusercontent.com/Chrniv/tipsmotorn/data/news/";
export async function importNews(d: Deps) {
  const st = d.store; if (!st.roundsForNews || !st.getNews || !st.upsertNews) return [];
  const now = d.now(), out: any[] = [];
  const rounds = (await st.roundsForNews(new Date(now - 3 * 3600e3).toISOString(), 60))
    .filter((r: any) => ["stryktipset", "europatipset"].includes(productOfId(r.id)));
  for (const rd of rounds) {
    try {
      const r = await d.fetch(`${NEWS_RAW}${rd.id}.json?t=${Math.floor(now / 60e3)}`, { headers: { accept: "application/json" } });
      if (r.status === 404) continue;
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      if (!data || !Array.isArray(data.matches)) throw new Error("no matches");
      const cur = (await st.getNews(rd.id))?.data;
      if (cur && Number(cur.updatedAt || 0) >= Number(data.updatedAt || 0)) continue;
      data.matches = data.matches.filter((m: any) => m && Number.isFinite(Number(m.n))).map((m: any) => ({ ...m, n: Number(m.n), suggest: cleanSuggest(m.suggest) }));
      await st.upsertNews(rd.id, data);
      out.push({ id: rd.id, matches: data.matches.length });
    } catch (e) { d.log?.(`news ${rd.id}: ${e}`); }
  }
  return out;
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
    async roundsForNews(nowIso, hours = 26) {
      const until = new Date(Date.parse(nowIso) + hours * 3600e3).toISOString();
      return chk(await sb.from("rounds").select("id,game,draw,name,close_at").gt("close_at", nowIso).lt("close_at", until)) || [];
    },
    async getNews(roundId) { return chk(await sb.from("news").select("data,updated_at").eq("round_id", roundId).maybeSingle()); },
    async upsertNews(roundId, data) { chk(await sb.from("news").upsert({ round_id: roundId, data, updated_at: new Date().toISOString() })); },
  };
}

// ---------- HTTP entry ----------
export async function handle(req: Request, d: Deps, secret: string | undefined): Promise<Response> {
  const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "unauthorized" }, 401);
  let body: any = {}; try { body = await req.json(); } catch (_) { /* empty body */ }
  const logs: string[] = []; d.log = (m) => logs.push(m);
  if (body.backfill) { const b = body.backfill; return json({ backfill: await backfill(d, b.game, +b.from, +b.to), logs }); }
  if (body.news) { try { return json({ news: await collectNews(d), logs }); } catch (e) { return json({ news: { error: String(e) }, logs }); } }
  const open = await collectOpen(d);
  const results = await collectResults(d);
  const news = await importNews(d);
  return json({ ok: true, open, results, news, logs });
}

if (!Deno.env.get("TM_TEST")) {
  Deno.serve((req) => handle(req, {
    fetch, now: () => Date.now(), oddsKey: Deno.env.get("ODDS_API_KEY") || undefined,
    anthropicKey: Deno.env.get("ANTHROPIC_API_KEY") || undefined, newsModel: Deno.env.get("NEWS_MODEL") || undefined,
    newsGames: (Deno.env.get("NEWS_GAMES") || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
    store: supabaseStore(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
  }, Deno.env.get("CRON_SECRET")));
}
