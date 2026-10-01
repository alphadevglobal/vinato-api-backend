-- Tempo de guarda: how long the wine keeps, as the producer states on the label
-- ("Guardar até 2032", "8 a 10 anos"). Read by the scanner, curated in the admin and
-- shown to Premium members below the sensory profile. Mirror of vinato-web migration 0023.
ALTER TABLE catalog_wines ADD COLUMN IF NOT EXISTS aging_potential text;
