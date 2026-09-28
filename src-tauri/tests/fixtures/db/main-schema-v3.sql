-- Schema version 3 exactly as main (c97199b) created it, with representative user rows.
-- Used by database::tests::a_database_from_the_released_schema_keeps_its_data.
CREATE TABLE IF NOT EXISTS print_history (
    id TEXT PRIMARY KEY,
    model_name TEXT NOT NULL,
    gcode_file TEXT,
    started_at TEXT,
    completed_at TEXT NOT NULL,
    duration_seconds INTEGER,
    status TEXT NOT NULL,
    fail_reason TEXT,
    filament_grams REAL,
    filament_meters REAL,
    thumbnail_path TEXT,
    quality_profile TEXT
);
CREATE TABLE IF NOT EXISTS library_models (
    id TEXT PRIMARY KEY,
    model_name TEXT NOT NULL,
    author TEXT,
    source_url TEXT,
    imported_at TEXT NOT NULL,
    thumbnail_url TEXT,
    file_path TEXT,
    folder_path TEXT NOT NULL UNIQUE,
    rating REAL,
    download_count INTEGER,
    file_count INTEGER
);
CREATE TABLE IF NOT EXISTS printer_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    serial TEXT NOT NULL,
    access_code_keychain_id TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
INSERT INTO print_history VALUES ('h1', 'Cable Clip', '/prints/cable-clip.gcode', '2026-09-01T10:00:00Z', '2026-09-01T11:05:00Z', 3900, 'finished', NULL, 12.5, 4.2, NULL, '0.20mm Standard');
INSERT INTO print_history VALUES ('h2', 'Phone Stand', NULL, NULL, '2026-09-02T09:00:00Z', NULL, 'failed', 'filament runout', NULL, NULL, NULL, NULL);
INSERT INTO library_models VALUES ('m1', 'Headphone Hook', 'someone', 'https://makerworld.com/en/models/1', '2026-09-03T08:00:00Z', NULL, '/lib/hook/hook.3mf', '/lib/hook', 4.8, 1200, 2);
INSERT INTO printer_configs VALUES ('p1', 'Shop P2S', '192.0.2.10', 'SERIAL-TEST-0001', 'printer:p1:access_code', 1, '2026-09-04T08:00:00Z', '2026-09-04T08:00:00Z');
INSERT INTO settings VALUES ('onboarding.completed', 'true', '2026-09-04T08:00:00Z');
INSERT INTO settings VALUES ('default.quality', '0.16', '2026-09-04T08:00:00Z');
INSERT INTO settings VALUES ('agent.model', 'anthropic:claude-sonnet-4-6', '2026-09-04T08:00:00Z');
PRAGMA user_version = 3;
