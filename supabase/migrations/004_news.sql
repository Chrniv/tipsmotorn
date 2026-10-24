-- Team news via Claude with web search. Run once in the SQL Editor after deploying the collector with news support.
-- Needs the function secret ANTHROPIC_API_KEY. Without it every call returns {"skipped": "no ANTHROPIC_API_KEY"} at no cost.
-- Every 5 minutes; a call with nothing to do returns in well under a second. Each call researches at most 4 matches.
select cron.schedule('tipsmotorn-news', '*/5 * * * *', $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'tm_collect_url'),
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'tm_cron_secret')),
    body    := '{"news":true}'::jsonb,
    timeout_milliseconds := 150000
  );
$job$);
-- Stop it: select cron.unschedule('tipsmotorn-news');
