-- Run AFTER the collect function is deployed. Replace the two values marked <<...>> first.
-- Supabase: Database -> Extensions: enable pg_cron and pg_net (or let these lines do it).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store the function URL and the shared secret in Vault (encrypted), so they are not in the cron job text.
select vault.create_secret('https://<<PROJECT-REF>>.supabase.co/functions/v1/collect', 'tm_collect_url');
select vault.create_secret('<<THE SAME CRON_SECRET YOU SET ON THE FUNCTION>>', 'tm_cron_secret');

-- Every 15 minutes: refresh open rounds, snapshots, sharp odds (throttled inside), results.
select cron.schedule('tipsmotorn-collect', '*/15 * * * *', $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'tm_collect_url'),
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'tm_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$job$);

-- Keep the database small: drop snapshots older than 120 days, every night.
select cron.schedule('tipsmotorn-prune', '17 3 * * *', $job$
  delete from public.snapshots where taken_at < now() - interval '120 days';
$job$);

-- Check that it runs (after 15 min):  select * from cron.job_run_details order by start_time desc limit 5;
-- Stop it:                            select cron.unschedule('tipsmotorn-collect');
