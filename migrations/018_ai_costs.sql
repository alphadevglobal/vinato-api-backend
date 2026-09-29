-- Admin "Financeiro": what OpenRouter billed for each Sommelier answer (usage.cost,
-- in US$). The scanner keeps its cost per attempt in scan_audit_logs.models_tried.
ALTER TABLE sommelier_messages ADD COLUMN IF NOT EXISTS cost_usd numeric;
