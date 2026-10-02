-- Schema version 5 as main (f7aee8f) created it: the schema-3 tables, migration 004's
-- sign_revisions, and migration 005's agent tables, with representative sign rows.
-- Used by database::tests::a_schema_5_database_with_signs_moves_to_builds_and_revisions.
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
CREATE TABLE IF NOT EXISTS sign_revisions (
    id TEXT PRIMARY KEY,
    lineage_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    parent_id TEXT REFERENCES sign_revisions(id),
    title TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    spec_sha256 TEXT NOT NULL,
    build_key TEXT NOT NULL,
    requested_by TEXT NOT NULL CHECK (requested_by IN ('human', 'agent', 'external_mcp')),
    build_status TEXT NOT NULL CHECK (build_status IN ('building', 'verified', 'failed')),
    failure_reason TEXT,
    artifacts_json TEXT,
    approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'void')),
    approved_sha256 TEXT,
    approval_at TEXT,
    void_reason TEXT,
    print_status TEXT NOT NULL DEFAULT 'not_tested' CHECK (print_status IN ('not_tested', 'passed', 'failed')),
    print_note TEXT,
    print_recorded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (lineage_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS sign_revisions_live_build_key
    ON sign_revisions (lineage_id, build_key) WHERE build_status != 'failed' AND approval_status != 'void';
CREATE INDEX IF NOT EXISTS sign_revisions_created ON sign_revisions (created_at);
CREATE TABLE IF NOT EXISTS agent_conversations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    rig_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_messages_conversation ON agent_messages (conversation_id, created_at);
CREATE TABLE IF NOT EXISTS agent_tool_calls (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'cancelled', 'interrupted')),
    output_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_tool_calls_conversation ON agent_tool_calls (conversation_id, started_at);
CREATE INDEX IF NOT EXISTS agent_tool_calls_status ON agent_tool_calls (status);
INSERT INTO sign_revisions VALUES ('a1000000-0000-4000-8000-000000000001', '1b0c7a52-5f1e-4c3a-9d2b-0a1e2f3a4b5c', 1, NULL, 'Back shortly', '{"schema_version":1,"title":"Back shortly","width_mm":150,"height_mm":210,"base":{"name":"white","hex":"#FFFFFF"},"inks":[{"name":"navy","hex":"#1F3A5F"}],"elements":[]}', 'ee2f977994f37dbaf5415a6f608abbee53861e2ab80335ca429138f32ec235c1', 'b87815233e8d922f531caf7086ac0fa104e5d40e931d945a973b095dea4cb2cc', 'agent', 'verified', NULL, '{"revision_dir":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000001","package_path":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000001/sign.3mf","package_sha256":"b5010d1225373d4bab364946db2f10c7bf94428e7c90f56801e68890e0cfac26","preview_path":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000001/preview.png","slice_dir":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000001/slice","gcode_sha256":"965453a340349cffde62d868dbd6c1afaa7770c58b293af8cd37200ba3bd2354","slicer":{"name":"Bambu Studio","version":"02.08.02.61","profile_version":"02.08.00.05"},"effective_settings":{"printer_settings_id":"Bambu Lab P2S 0.4 nozzle"},"checks":[{"id":"geometry.closed_manifold.white","passed":true,"detail":"0 open edges"},{"id":"slice.placement_preserved","passed":true,"detail":"max deviation 0.01 mm"}]}', 'approved', 'b5010d1225373d4bab364946db2f10c7bf94428e7c90f56801e68890e0cfac26', '2026-09-28T10:05:00+00:00', NULL, 'passed', 'reads well', '2026-09-29T08:00:00+00:00', '2026-09-28T10:00:00+00:00', '2026-09-29T08:00:00+00:00');
INSERT INTO sign_revisions VALUES ('a1000000-0000-4000-8000-000000000002', '1b0c7a52-5f1e-4c3a-9d2b-0a1e2f3a4b5c', 2, 'a1000000-0000-4000-8000-000000000001', 'Back shortly', '{"schema_version":1,"title":"Back shortly","width_mm":160,"height_mm":210,"base":{"name":"white","hex":"#FFFFFF"},"inks":[{"name":"navy","hex":"#1F3A5F"}],"elements":[]}', '534c138fa79271e54a560a495821854faba0f4763d28e435bcac15399a73c77e', 'f41123460d7a9ef8ffd14a33d3027c568987eaf98145a97780e08f6448da592f', 'human', 'failed', 'checks failed: slice.placement_preserved', '{"revision_dir":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000002","package_path":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000002/sign.3mf","package_sha256":"f2cce6b5db09a70b36ece73b4a019b16ce717519f4ee312afd72933110c37dc5","preview_path":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000002/preview.png","slice_dir":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000002/slice","gcode_sha256":"19096463bac949bafe7bf1437373fce26a7651e9416b91602448c8d4caae9a48","slicer":{"name":"Bambu Studio","version":"02.08.02.61","profile_version":"02.08.00.05"},"effective_settings":{"printer_settings_id":"Bambu Lab P2S 0.4 nozzle"},"checks":[{"id":"geometry.closed_manifold.white","passed":true,"detail":"0 open edges"},{"id":"slice.placement_preserved","passed":false,"detail":"max deviation 3.2 mm"}]}', 'pending', NULL, NULL, NULL, 'not_tested', NULL, NULL, '2026-09-28T11:00:00+00:00', '2026-09-28T11:01:00+00:00');
INSERT INTO sign_revisions VALUES ('a1000000-0000-4000-8000-000000000003', '1b0c7a52-5f1e-4c3a-9d2b-0a1e2f3a4b5c', 3, 'a1000000-0000-4000-8000-000000000002', 'Back shortly', '{"schema_version":1,"title":"Back shortly","width_mm":170,"height_mm":210,"base":{"name":"white","hex":"#FFFFFF"},"inks":[{"name":"navy","hex":"#1F3A5F"}],"elements":[]}', '6d21775c70c798aa554380b63fa4068388f94d22f61e6fefb41f3c1c6dca969b', 'df0d3336e1bab35b2ae1bd83aa471953bb5752edf56386e81f11e9d9c560d5a7', 'external_mcp', 'verified', NULL, '{"revision_dir":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000003","package_path":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000003/sign.3mf","package_sha256":"14d8d5ab1e1c04756b8f9c6f13aeaf620bc180c069b4ea148dfad90ad0889e8a","preview_path":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000003/preview.png","slice_dir":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/a1000000-0000-4000-8000-000000000003/slice","gcode_sha256":"af44877cd9705f2f135a1d893e3fdfd5e971bafa1248765a41f336046f465ad2","slicer":{"name":"Bambu Studio","version":"02.08.02.61","profile_version":"02.08.00.05"},"effective_settings":{"printer_settings_id":"Bambu Lab P2S 0.4 nozzle"},"checks":[{"id":"geometry.closed_manifold.white","passed":true,"detail":"0 open edges"},{"id":"slice.placement_preserved","passed":true,"detail":"max deviation 0.01 mm"}]}', 'pending', NULL, NULL, NULL, 'not_tested', NULL, NULL, '2026-09-28T12:00:00+00:00', '2026-09-28T12:01:00+00:00');
INSERT INTO sign_revisions VALUES ('b2000000-0000-4000-8000-000000000001', '2c1d8b63-6a2f-4d4b-8e3c-1b2f3a4b5c6d', 1, NULL, 'Back shortly copy', '{"schema_version":1,"title":"Back shortly","width_mm":150,"height_mm":210,"base":{"name":"white","hex":"#FFFFFF"},"inks":[{"name":"navy","hex":"#1F3A5F"}],"elements":[]}', 'ee2f977994f37dbaf5415a6f608abbee53861e2ab80335ca429138f32ec235c1', 'b87815233e8d922f531caf7086ac0fa104e5d40e931d945a973b095dea4cb2cc', 'agent', 'verified', NULL, '{"revision_dir":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/b2000000-0000-4000-8000-000000000001","package_path":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/b2000000-0000-4000-8000-000000000001/sign.3mf","package_sha256":"50785f520d1a07bcc9eddd6928c663044cf86c32c230b9917e355c462e13149f","preview_path":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/b2000000-0000-4000-8000-000000000001/preview.png","slice_dir":"/Users/ossie/Library/Application Support/com.aojdevstudio.materialize3d/signs/b2000000-0000-4000-8000-000000000001/slice","gcode_sha256":"2e4a029ce80282603dd791455e56226e9befddb4d65c3fa0df4360cb6deda074","slicer":{"name":"Bambu Studio","version":"02.08.02.61","profile_version":"02.08.00.05"},"effective_settings":{"printer_settings_id":"Bambu Lab P2S 0.4 nozzle"},"checks":[{"id":"geometry.closed_manifold.white","passed":true,"detail":"0 open edges"},{"id":"slice.placement_preserved","passed":true,"detail":"max deviation 0.01 mm"}]}', 'void', NULL, '2026-09-27T09:30:00+00:00', 'package changed on disk after approval (now d121be3103007b41edf96f8262925f8c7d61894afe9a041843b631f69445bc57)', 'not_tested', NULL, NULL, '2026-09-27T09:00:00+00:00', '2026-09-27T09:30:00+00:00');
INSERT INTO sign_revisions VALUES ('c3000000-0000-4000-8000-000000000001', '3d2e9c74-7b3a-4e5c-9f4d-2c3a4b5c6d7e', 1, NULL, 'Open late', '{"schema_version":1,"title":"Back shortly","width_mm":120,"height_mm":210,"base":{"name":"white","hex":"#FFFFFF"},"inks":[{"name":"navy","hex":"#1F3A5F"}],"elements":[]}', 'b9aaebb0d58bbc43751d09f73622e399be3adca2cebf130e8025bd79f383afd7', '2fff064ec4a726c962587a95f9e3c8eb21cac55f756a1314a760b0f6c150d151', 'human', 'building', NULL, NULL, 'pending', NULL, NULL, NULL, 'not_tested', NULL, NULL, '2026-09-30T07:00:00+00:00', '2026-09-30T07:00:00+00:00');
PRAGMA user_version = 5;
