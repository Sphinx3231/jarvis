export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE secrets (
        name TEXT PRIMARY KEY,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Short-term conversational context.
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT,
        summarized_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

      -- Long-term memory: preferences, project knowledge, decisions, procedures, facts,
      -- task history summaries and tool documentation.
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        source_ref TEXT,
        sources TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.5,
        verified INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        embedding BLOB,
        embedding_model TEXT,
        merged_count INTEGER NOT NULL DEFAULT 1,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_memories_kind ON memories(kind);
      CREATE INDEX idx_memories_hash ON memories(content_hash);
      CREATE INDEX idx_memories_source_ref ON memories(source_ref);

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content, tags, content='memories', content_rowid='rowid', tokenize='porter unicode61'
      );
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE OF content, tags ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;

      -- Task engine.
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 2,
        status TEXT NOT NULL,
        origin TEXT NOT NULL,
        agent TEXT,
        conversation_id TEXT,
        plan TEXT,
        current_step INTEGER NOT NULL DEFAULT 0,
        progress REAL NOT NULL DEFAULT 0,
        result TEXT,
        error TEXT,
        attention TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 2,
        required_permissions TEXT NOT NULL DEFAULT '[]',
        scheduled_for INTEGER,
        recurrence TEXT,
        parent_id TEXT,
        dedupe_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        heartbeat_at INTEGER
      );
      CREATE INDEX idx_tasks_status ON tasks(status, priority DESC, created_at);
      CREATE INDEX idx_tasks_dedupe ON tasks(dedupe_key);

      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX idx_task_events_task ON task_events(task_id, id);

      -- Authorization.
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        skill TEXT NOT NULL,
        input TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        reminded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        decision_note TEXT
      );
      CREATE INDEX idx_approvals_status ON approvals(status);

      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        skill TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        uses INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_grants_lookup ON grants(skill, input_hash);

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        skill TEXT NOT NULL,
        task_id TEXT,
        input TEXT NOT NULL,
        decision TEXT NOT NULL,
        approval_id TEXT,
        grant_id TEXT,
        outcome TEXT NOT NULL,
        verified INTEGER,
        duration_ms INTEGER,
        error TEXT
      );
      CREATE INDEX idx_audit_ts ON audit_log(ts);

      CREATE TABLE activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX idx_activity_ts ON activity(ts);

      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        task_id TEXT,
        dedupe_key TEXT UNIQUE,
        read INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE jobs (
        name TEXT PRIMARY KEY,
        last_run_at INTEGER,
        last_status TEXT,
        last_message TEXT,
        last_duration_ms INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- Files Jarvis wrote into the Obsidian vault, with the hash of what it wrote, so it can
      -- tell when the user edited a note (and then never overwrite it).
      CREATE TABLE obsidian_files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        written_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      -- Jarvis now keeps its own dedicated vault; track written files per vault.
      DROP TABLE obsidian_files;
      CREATE TABLE obsidian_files (
        vault TEXT NOT NULL,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        written_at INTEGER NOT NULL,
        PRIMARY KEY (vault, path)
      );
    `,
  },
  {
    version: 4,
    sql: `
      -- The user's own words that created a task: steps that are part of the request run
      -- without a second approval; anything else still asks.
      ALTER TABLE tasks ADD COLUMN request TEXT;
      -- Who approved: the user, or the user's request itself (with the reason).
      ALTER TABLE approvals ADD COLUMN decided_by TEXT;
      ALTER TABLE approvals ADD COLUMN reason TEXT;
    `,
  },
  {
    version: 5,
    sql: `
      -- The autonomous bug-bounty pipeline: HackerOne programs discovered, reports and earnings.
      -- Everything Jarvis learns about the pipeline lives here so it can be analysed over time.
      CREATE TABLE h1_programs (
        handle TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT,
        offers_bounties INTEGER NOT NULL DEFAULT 0,
        state TEXT,
        url TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        raw TEXT
      );
      CREATE TABLE h1_reports (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        program TEXT,
        severity TEXT,
        bounty REAL,
        currency TEXT,
        created_at INTEGER,
        synced_at INTEGER NOT NULL
      );
      CREATE TABLE h1_earnings (
        id TEXT PRIMARY KEY,
        amount REAL NOT NULL,
        currency TEXT,
        program TEXT,
        report_id TEXT,
        awarded_at INTEGER,
        synced_at INTEGER NOT NULL
      );
      CREATE INDEX idx_h1_programs_first_seen ON h1_programs (first_seen);
      CREATE INDEX idx_h1_earnings_awarded ON h1_earnings (awarded_at);
      CREATE INDEX idx_h1_reports_state ON h1_reports (state);
    `,
  },
  {
    version: 6,
    sql: `
      -- Structured scopes per program (what is in scope), so a report is only ever submitted
      -- against an asset the program marks eligible. The in-scope gate fails closed: no stored
      -- eligible scope means no autonomous submission.
      CREATE TABLE h1_scopes (
        program TEXT NOT NULL,
        identifier TEXT NOT NULL,
        asset_type TEXT,
        eligible INTEGER NOT NULL DEFAULT 0,
        max_severity TEXT,
        instruction TEXT,
        raw TEXT,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (program, identifier)
      );
      -- Every submission attempt, autonomous or not, with the scope decision and outcome: the audit
      -- trail the user reviews. A held (out-of-scope / unauthorized) attempt is recorded, never sent.
      CREATE TABLE h1_submissions (
        id TEXT PRIMARY KEY,
        program TEXT NOT NULL,
        title TEXT NOT NULL,
        asset TEXT,
        severity TEXT,
        scope_ok INTEGER NOT NULL,
        scope_reason TEXT,
        autonomous INTEGER NOT NULL DEFAULT 0,
        submitted INTEGER NOT NULL DEFAULT 0,
        report_id TEXT,
        report_url TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_h1_scopes_program ON h1_scopes (program);
      CREATE INDEX idx_h1_submissions_created ON h1_submissions (created_at);
    `,
  },
  {
    version: 7,
    sql: `
      -- Computer Access Mode audit trail: every observe/control/browser action Jarvis takes on this
      -- computer, with the state machine phase, the verification outcome and whether the user had to
      -- confirm it. Kept separate from the generic skill audit so the Computer Access panel can show
      -- "what did Jarvis just do on my machine" cheaply and it survives restarts.
      CREATE TABLE computer_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        target TEXT,
        detail TEXT NOT NULL,
        outcome TEXT NOT NULL,
        verified INTEGER,
        critical TEXT,
        task TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX idx_computer_actions_ts ON computer_actions (ts);
      -- Learning (observation) sessions: what is being watched, progress (last lesson + URL) so that
      -- "continue where you left off" works across restarts, and honest coverage counters.
      CREATE TABLE learning_sessions (
        id TEXT PRIMARY KEY,
        course TEXT NOT NULL,
        course_slug TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        last_lesson TEXT,
        last_lesson_number INTEGER,
        last_url TEXT,
        lessons_seen INTEGER NOT NULL DEFAULT 0,
        notes_stored INTEGER NOT NULL DEFAULT 0,
        samples INTEGER NOT NULL DEFAULT 0,
        gaps TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX idx_learning_sessions_course ON learning_sessions (course_slug, updated_at);
    `,
  },
  {
    version: 8,
    sql: `
      -- Conversation digests: after every conversation (once it goes quiet) Jarvis summarises the new
      -- part to itself — what was new, what was repeated — and files each item under a category
      -- (rule, plan, schedule, idea, decision, …). digested_until marks how far each conversation has
      -- been digested, so a restart or a crash never loses a conversation: it is digested next time.
      ALTER TABLE conversations ADD COLUMN digested_until INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE conversation_digests (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        conversation_title TEXT NOT NULL,
        from_ts INTEGER NOT NULL,
        to_ts INTEGER NOT NULL,
        messages INTEGER NOT NULL,
        summary TEXT NOT NULL,
        items TEXT NOT NULL DEFAULT '[]',
        new_count INTEGER NOT NULL DEFAULT 0,
        repeated_count INTEGER NOT NULL DEFAULT 0,
        method TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_conversation_digests_conv ON conversation_digests (conversation_id, to_ts);
      CREATE INDEX idx_conversation_digests_created ON conversation_digests (created_at);
    `,
  },
];
