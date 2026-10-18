-- Tipsmotorn database. Paste into Supabase: SQL Editor -> New query -> Run.

-- ---------- Public match data (written only by the collector) ----------
create table if not exists public.rounds (
  id            text primary key,              -- e.g. 'stryktipset-4975'
  game          text not null,                 -- 'Stryktipset' | 'Europatipset'
  draw          int  not null,
  name          text,
  close_at      timestamptz,
  state         text,                          -- Svenska Spel drawState: Open, Closed, Finalized ...
  sale          numeric,                       -- turnover so far (kr)
  row_price     numeric default 1,
  jackpot       numeric default 0,             -- announced 13-rätt jackpot (total pot), 0 if none
  guarantee     numeric default 0,             -- single-winner guarantee, 0 if none
  roll_sale     numeric default 0,             -- previous round's turnover if it had no 13-rätt winner
  sharp_stage   text,                          -- last time window sharp odds were fetched in
  updated_at    timestamptz default now()
);
create index if not exists rounds_close_idx on public.rounds (close_at);

create table if not exists public.matches (
  round_id    text references public.rounds(id) on delete cascade,
  n           int,
  home        text,
  away        text,
  league      text,
  kickoff     timestamptz,
  odds        numeric[],     -- Svenska Spel odds 1/X/2 (latest)
  start_odds  numeric[],     -- Svenska Spel opening odds
  streck      numeric[],     -- Svenska folket % 1/X/2 (latest)
  sharp       numeric[],     -- Pinnacle / Betfair Exchange 1/X/2
  sharp_bk    text,
  sharp_at    timestamptz,
  outcome     text,          -- '1' | 'X' | '2' | 'C' (cancelled) once known
  score       text,
  primary key (round_id, n)
);

create table if not exists public.snapshots (
  id        bigint generated always as identity primary key,
  round_id  text references public.rounds(id) on delete cascade,
  taken_at  timestamptz default now(),
  sale      numeric,
  odds      jsonb,           -- [[o1,ox,o2] x 13]
  streck    jsonb            -- [[s1,sx,s2] x 13]
);
create index if not exists snapshots_round_idx on public.snapshots (round_id, taken_at);

create table if not exists public.results (
  round_id     text primary key references public.rounds(id) on delete cascade,
  correct_row  text,                 -- 13 chars of 1/X/2 (C for cancelled)
  tiers        jsonb,                -- {"13":{"w":145,"a":46731}, ...}
  sale         numeric,
  finalized_at timestamptz default now()
);

create table if not exists public.news (
  round_id    text primary key references public.rounds(id) on delete cascade,
  data        jsonb not null,        -- {matches:[{n,home,away,impact,notes,lineup,take,suggest,sources}]}
  updated_at  timestamptz default now()
);

-- Every finished round, for backtests and model calibration.
create table if not exists public.history (
  game      text,
  draw      int,
  close_at  timestamptz,
  sale      numeric,
  tiers     jsonb,
  events    jsonb,                   -- [{r,so:[..],s:[..],lg,ko}] x 13
  primary key (game, draw)
);

-- ---------- Private data ----------
create table if not exists public.systems (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  round_id    text references public.rounds(id) on delete set null,
  created_at  timestamptz default now(),
  label       text,
  rows        text not null,         -- concatenated 13-char rows
  cost        int,
  ev          numeric,
  p13         numeric,
  settings    jsonb,
  result      jsonb,                 -- {row,best,c13,c12,c11,c10}
  payout      numeric
);
create index if not exists systems_user_idx on public.systems (user_id, created_at desc);

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint    text unique not null,
  sub         jsonb not null,
  created_at  timestamptz default now()
);

-- ---------- Row level security ----------
alter table public.rounds             enable row level security;
alter table public.matches            enable row level security;
alter table public.snapshots          enable row level security;
alter table public.results            enable row level security;
alter table public.news               enable row level security;
alter table public.history            enable row level security;
alter table public.systems            enable row level security;
alter table public.push_subscriptions enable row level security;

-- Match data is public Svenska Spel data: readable by anyone with the app, writable only by the collector (service role bypasses RLS).
do $$ begin
  create policy "read rounds"    on public.rounds    for select using (true);
  create policy "read matches"   on public.matches   for select using (true);
  create policy "read snapshots" on public.snapshots for select using (true);
  create policy "read results"   on public.results   for select using (true);
  create policy "read news"      on public.news      for select using (true);
  create policy "read history"   on public.history   for select using (true);
  create policy "own systems"    on public.systems            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "own push"       on public.push_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
