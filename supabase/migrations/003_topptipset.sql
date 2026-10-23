-- Topptipset support. Run once in Supabase: SQL Editor -> New query -> Run.
-- product: Svenska Spel product name ('Stryktipset', 'Topptipset Stryk', ...). game stays the family ('Topptipset').
-- extra:   kr added to the top-tier pot this round (Topptipset rollover + extra money), 0 if none.
-- roll_sale may now be null, meaning "previous round not finished yet, check again".
alter table public.rounds add column if not exists product text;
alter table public.rounds add column if not exists extra numeric default 0;
alter table public.rounds alter column roll_sale drop default;
create index if not exists rounds_game_close_idx on public.rounds (game, close_at);
