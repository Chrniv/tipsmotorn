# Tipsmotorn

Personal Stryktipset and Europatipset engine. A Supabase backend collects rounds, streck, jackpots, sharp odds and results every 15 minutes; the phone app (an installable web app) reads them and builds value-based systems.

```
supabase/migrations/001_init.sql     tables and access rules
supabase/migrations/002_schedule.sql runs the collector every 15 minutes
supabase/functions/collect/index.ts  the collector (Edge Function)
supabase/functions/collect/test.ts   tests (TM_TEST=1 deno run --allow-env test.ts)
web/                                 the app (static files, hosted on Netlify)
```

## Setup (about 20 minutes)

### 1. Database
Supabase → **SQL Editor** → New query → paste all of `supabase/migrations/001_init.sql` → **Run**.

### 2. The collector function
1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `collect`. Replace the example code with all of `supabase/functions/collect/index.ts`. Deploy.
3. Open the function → **Settings** (or Details) → turn **off** "Verify JWT" / "Enforce JWT verification" → save. The function is protected by its own secret instead.
4. Edge Functions → **Secrets** → add:
   - `CRON_SECRET` = a long random string (generate one in your password manager, 30+ characters). Keep it; you need it in step 3.
   - `ODDS_API_KEY` = your key from the-odds-api.com (optional; without it the app uses Svenska Spel's odds).

### 3. Schedule
Open `supabase/migrations/002_schedule.sql`, replace `<<PROJECT-REF>>` (the part before `.supabase.co` in your Project URL) and `<<THE SAME CRON_SECRET...>>`, then run it in the SQL Editor.

Run the collector once right away instead of waiting 15 minutes:
```sql
select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'tm_collect_url'),
  headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name = 'tm_cron_secret')),
  body := '{}'::jsonb, timeout_milliseconds := 60000);
```
After ~20 seconds: `select id, name, close_at, jackpot from rounds;` should list this week's rounds.
If it is empty: `select status_code, content from net._http_response order by created desc limit 3;` shows what the function answered.

### 4. History (optional, for backtests inside the app later)
Each call stores up to 40 finished rounds. Run a few times, moving `to` down each time (the answer tells you `next`):
```sql
select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'tm_collect_url'),
  headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name = 'tm_cron_secret')),
  body := '{"backfill":{"game":"stryktipset","from":4855,"to":4974}}'::jsonb, timeout_milliseconds := 150000);
```
Europatipset: `"game":"europatipset","from":2400,"to":2616`.

### 5. The app
1. `web/config.js`: Project URL and anon/publishable key (already filled in if Claude did it).
2. Netlify → **Add new site** → **Import an existing project** → GitHub → pick this repo.
   - Base directory: `web` · Build command: empty · Publish directory: `web` → Deploy.
   - Site configuration → change the site name, e.g. `tipsmotorn-chris` → `https://tipsmotorn-chris.netlify.app`.
3. Supabase → **Authentication** → **URL Configuration**: set **Site URL** to the Netlify address and add it under **Redirect URLs**.
4. Phone: open the Netlify address.
   - iPhone: Safari → Share → **Add to Home Screen**.
   - Android: Chrome → ⋮ → **Install app**.
5. In the app: **Sparade** → log in with your email (magic link, no password). Saved systems are graded automatically after each round.

## How it runs
- Every 15 min: open rounds, odds, streck, jackpot/guarantee/rollover, a streck snapshot (for drift), results of finished rounds, and automatic grading of saved systems.
- Sharp odds are fetched at most four times per round (day before, same day, before lineups, after lineups) to stay within the free 500 credits/month.
- Snapshots older than 120 days are deleted nightly.

## Notes
- The Svenska Spel API is undocumented. Polling every 15 minutes for personal use is light; ask Svenska Spel for an official API key before releasing this to others.
- Never put the `service_role` key, database password or `CRON_SECRET` in `web/` — everything there is public.
