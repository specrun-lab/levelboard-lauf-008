package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "modernc.org/sqlite"
)

// Schema exakt wie spec/05-datenmodell.md („Datenbank“).
var schemaStatements = []string{
	`CREATE TABLE levels (
  level        INTEGER PRIMARY KEY CHECK (level BETWEEN 1 AND 10),
  status       TEXT    NOT NULL CHECK (status IN ('offen','bestanden','fehlgeschlagen','gesperrt')),
  checked_at   TEXT,
  duration_ms  INTEGER,
  checks       TEXT    NOT NULL DEFAULT '[]',
  metrics      TEXT    NOT NULL DEFAULT '{}'
)`,
	`CREATE TABLE reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  level        INTEGER NOT NULL REFERENCES levels(level),
  status       TEXT    NOT NULL CHECK (status IN ('bestanden','fehlgeschlagen')),
  checked_at   TEXT    NOT NULL,
  duration_ms  INTEGER NOT NULL,
  checks       TEXT    NOT NULL,
  metrics      TEXT    NOT NULL
)`,
	`CREATE INDEX reports_level ON reports(level, id)`,
	`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`,
}

// sqlStore speichert in einer SQLite-Datei. Genau eine Verbindung, alle Zugriffe unter einem Mutex.
type sqlStore struct {
	mu sync.Mutex
	db *sql.DB
}

func openSQLStore(path string) (*sqlStore, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	dsn := "file:" + abs + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &sqlStore{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("Migration: %w", err)
	}
	return s, nil
}

func (s *sqlStore) Close() error {
	return s.db.Close()
}

// migrate legt bei user_version 0 das Schema in einer Transaktion an. Bei 1 ändert es nichts.
func (s *sqlStore) migrate() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 1 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stmt := range schemaStatements {
		if _, err := tx.Exec(stmt); err != nil {
			return err
		}
	}
	for n := 1; n <= 10; n++ {
		if _, err := tx.Exec(`INSERT INTO levels (level, status) VALUES (?, 'offen')`, n); err != nil {
			return err
		}
	}
	if _, err := tx.Exec("PRAGMA user_version = 1"); err != nil {
		return err
	}
	return tx.Commit()
}

// querier passt auf *sql.DB und *sql.Tx.
type querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

func (s *sqlStore) State() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return readState(s.db)
}

func readState(q querier) (State, error) {
	rows, err := q.Query(`SELECT level, status, checked_at, duration_ms, checks, metrics FROM levels ORDER BY level`)
	if err != nil {
		return State{}, err
	}
	defer rows.Close()

	var levels []Level
	for rows.Next() {
		var (
			n           int
			status      string
			checkedAt   sql.NullString
			durationMs  sql.NullInt64
			checksJSON  string
			metricsJSON string
		)
		if err := rows.Scan(&n, &status, &checkedAt, &durationMs, &checksJSON, &metricsJSON); err != nil {
			return State{}, err
		}
		l := Level{Level: n, Title: titles[n-1], Status: status}
		if checkedAt.Valid {
			c := checkedAt.String
			l.CheckedAt = &c
		}
		if durationMs.Valid {
			d := durationMs.Int64
			l.DurationMs = &d
		}
		if err := json.Unmarshal([]byte(checksJSON), &l.Checks); err != nil {
			return State{}, fmt.Errorf("checks von Level %d: %w", n, err)
		}
		if err := json.Unmarshal([]byte(metricsJSON), &l.Metrics); err != nil {
			return State{}, fmt.Errorf("metrics von Level %d: %w", n, err)
		}
		if l.Checks == nil {
			l.Checks = []Check{}
		}
		if l.Metrics == nil {
			l.Metrics = map[string]any{}
		}
		levels = append(levels, l)
	}
	if err := rows.Err(); err != nil {
		return State{}, err
	}

	var updated sql.NullString
	err = q.QueryRow(`SELECT value FROM meta WHERE key = 'updated_at'`).Scan(&updated)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return State{}, err
	}
	st := State{Levels: levels}
	if updated.Valid {
		u := updated.String
		st.UpdatedAt = &u
	}
	return st, nil
}

// Report ist eine Transaktion: Prüfung der Reihenfolge, Eintrag in reports, Änderung von levels und meta.
// Bei 409 wird nichts geschrieben.
func (s *sqlStore) Report(n int, rep Report, at string) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return State{}, err
	}
	defer tx.Rollback()

	cur, err := readState(tx)
	if err != nil {
		return State{}, err
	}
	next, err := applyReport(cur.Levels, n, rep, at)
	if err != nil {
		return State{}, err
	}

	for _, l := range next {
		checks, err := json.Marshal(l.Checks)
		if err != nil {
			return State{}, err
		}
		metrics, err := json.Marshal(l.Metrics)
		if err != nil {
			return State{}, err
		}
		if _, err := tx.Exec(
			`UPDATE levels SET status = ?, checked_at = ?, duration_ms = ?, checks = ?, metrics = ? WHERE level = ?`,
			l.Status, nullableString(l.CheckedAt), nullableInt(l.DurationMs), string(checks), string(metrics), l.Level,
		); err != nil {
			return State{}, err
		}
	}

	reported := next[n-1]
	checks, err := json.Marshal(rep.Checks)
	if err != nil {
		return State{}, err
	}
	metrics, err := json.Marshal(rep.Metrics)
	if err != nil {
		return State{}, err
	}
	if _, err := tx.Exec(
		`INSERT INTO reports (level, status, checked_at, duration_ms, checks, metrics) VALUES (?, ?, ?, ?, ?, ?)`,
		n, reported.Status, *reported.CheckedAt, *reported.DurationMs, string(checks), string(metrics),
	); err != nil {
		return State{}, err
	}
	if _, err := tx.Exec(
		`INSERT INTO meta (key, value) VALUES ('updated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		at,
	); err != nil {
		return State{}, err
	}
	if err := tx.Commit(); err != nil {
		return State{}, err
	}
	return State{Levels: next, UpdatedAt: &at}, nil
}

func (s *sqlStore) History(n, limit int) (History, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rows, err := s.db.Query(
		`SELECT id, status, checked_at, duration_ms, checks, metrics FROM reports WHERE level = ? ORDER BY id DESC LIMIT ?`,
		n, limit,
	)
	if err != nil {
		return History{}, err
	}
	defer rows.Close()

	entries := []HistoryEntry{}
	for rows.Next() {
		var (
			e           HistoryEntry
			checksJSON  string
			metricsJSON string
		)
		if err := rows.Scan(&e.ID, &e.Status, &e.CheckedAt, &e.DurationMs, &checksJSON, &metricsJSON); err != nil {
			return History{}, err
		}
		if err := json.Unmarshal([]byte(checksJSON), &e.Checks); err != nil {
			return History{}, err
		}
		if err := json.Unmarshal([]byte(metricsJSON), &e.Metrics); err != nil {
			return History{}, err
		}
		if e.Checks == nil {
			e.Checks = []Check{}
		}
		if e.Metrics == nil {
			e.Metrics = map[string]any{}
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return History{}, err
	}
	return History{Level: n, Entries: entries}, nil
}

func nullableString(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func nullableInt(i *int64) any {
	if i == nil {
		return nil
	}
	return *i
}
