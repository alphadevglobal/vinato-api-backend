-- Logs Lojas: each price refresh is ONE log entry. The price agent writes, per
-- store, what it read and the full list of prices it pulled (previous price,
-- new offers, products that left the store) into price_agent_runs.report, and
-- what started the run (schedule or by hand). Reports older than 45 days are
-- emptied by the agent; the run row stays. Mirror of vinato-web migration 0025.
ALTER TABLE price_agent_runs ADD COLUMN IF NOT EXISTS report jsonb;
ALTER TABLE price_agent_runs ADD COLUMN IF NOT EXISTS trigger text;
