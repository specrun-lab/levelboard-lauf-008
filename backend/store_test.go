package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func openTestDB(t *testing.T, path string) *sqlStore {
	t.Helper()
	s, err := openSQLStore(path)
	if err != nil {
		t.Fatalf("openSQLStore: %v", err)
	}
	return s
}

func TestSchemaAndMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schema.db")
	s := openTestDB(t, path)
	defer s.Close()

	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 1 {
		t.Fatalf("user_version = %d (%v), erwartet 1", version, err)
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM levels WHERE status = 'offen'").Scan(&count); err != nil || count != 10 {
		t.Fatalf("levels mit offen = %d (%v), erwartet 10", count, err)
	}
	for _, table := range []string{"levels", "reports", "meta"} {
		if _, err := s.db.Exec("SELECT 1 FROM " + table + " LIMIT 1"); err != nil && err != sql.ErrNoRows {
			t.Fatalf("Tabelle %s fehlt: %v", table, err)
		}
	}
}

func TestMigrationIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "again.db")
	s := openTestDB(t, path)
	if _, err := s.Report(1, Report{Checks: []Check{{Name: "a", OK: true}}, DurationMs: 3, Metrics: map[string]any{}}, "2026-11-21T10:00:00.000Z"); err != nil {
		t.Fatalf("Report: %v", err)
	}
	s.Close()

	s = openTestDB(t, path)
	defer s.Close()
	st, err := s.State()
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if st.Levels[0].Status != "bestanden" {
		t.Fatalf("Migration bei user_version 1 hat Daten verändert: %+v", st.Levels[0])
	}
}

func TestPersistenceAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "persist.db")
	s := openTestDB(t, path)
	rep := Report{Checks: []Check{{Name: "a", OK: true}}, DurationMs: 42, Metrics: map[string]any{"k": "v"}}
	if _, err := s.Report(1, rep, "2026-11-21T10:00:00.000Z"); err != nil {
		t.Fatalf("Report: %v", err)
	}
	before, _ := s.State()
	s.Close()

	s = openTestDB(t, path)
	defer s.Close()
	after, err := s.State()
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(after)
	if string(a) != string(b) {
		t.Fatalf("Stand nach Neustart verändert:\n%s\n%s", a, b)
	}
}

func TestRejectedReportIsNotWritten(t *testing.T) {
	s := openTestDB(t, filepath.Join(t.TempDir(), "reject.db"))
	defer s.Close()
	ok := Report{Checks: []Check{{Name: "a", OK: true}}, DurationMs: 1, Metrics: map[string]any{}}
	if _, err := s.Report(2, ok, "2026-11-21T10:00:00.000Z"); err != ErrOutOfOrder {
		t.Fatalf("Level 2 ohne 1: err = %v, erwartet ErrOutOfOrder", err)
	}
	h, err := s.History(2, 50)
	if err != nil || len(h.Entries) != 0 {
		t.Fatalf("409 landete in der Historie: %+v (%v)", h, err)
	}
}

func TestHistoryNewestFirstAndLimit(t *testing.T) {
	srv := newTestServer(t)
	for _, d := range []string{"101", "102"} {
		rec := do(t, srv, http.MethodPost, "/api/levels/1/result", "application/json",
			`{"checks":[{"name":"a","ok":true}],"durationMs":`+d+`}`)
		if rec.Code != 200 {
			t.Fatalf("Meldung: %d", rec.Code)
		}
	}
	rec := do(t, srv, http.MethodGet, "/api/levels/1/history?limit=1", "", "")
	if rec.Code != 200 {
		t.Fatalf("history: %d", rec.Code)
	}
	var h History
	if err := json.Unmarshal(rec.Body.Bytes(), &h); err != nil {
		t.Fatal(err)
	}
	if len(h.Entries) != 1 || h.Entries[0].DurationMs != 102 {
		t.Fatalf("limit=1: %+v", h.Entries)
	}
	rec = do(t, srv, http.MethodGet, "/api/levels/1/history", "", "")
	json.Unmarshal(rec.Body.Bytes(), &h)
	if len(h.Entries) != 2 || h.Entries[0].DurationMs != 102 || h.Entries[1].DurationMs != 101 || h.Entries[0].ID <= h.Entries[1].ID {
		t.Fatalf("Reihenfolge falsch: %+v", h.Entries)
	}
	for _, q := range []string{"limit=0", "limit=501", "limit=abc", "limit=", "limit=-1", "limit=1.5"} {
		rec := do(t, srv, http.MethodGet, "/api/levels/1/history?"+q, "", "")
		if rec.Code != 400 {
			t.Errorf("%s: Status %d, erwartet 400", q, rec.Code)
		}
	}
	rec = do(t, srv, http.MethodGet, "/api/levels/2/history", "", "")
	if !strings.Contains(rec.Body.String(), `"entries":[]`) {
		t.Fatalf("leere Historie: %s", rec.Body.String())
	}
}
