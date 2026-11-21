package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	store, err := openSQLStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Datenbank: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	srv := NewServer(store, Config{RunID: "test"})
	return srv.Handler(log.New(io.Discard, "", 0))
}

func do(t *testing.T, h http.Handler, method, path, contentType, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeLevels(t *testing.T, rec *httptest.ResponseRecorder) Results {
	t.Helper()
	var res Results
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("Antwort ist kein Gesamtstand: %v (%s)", err, rec.Body.String())
	}
	return res
}

func TestHealthExactContentType(t *testing.T) {
	h := newTestServer(t)
	rec := do(t, h, http.MethodGet, "/api/health", "", "")
	if rec.Code != 200 {
		t.Fatalf("Status %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type %q", ct)
	}
	if got := rec.Body.String(); !strings.Contains(got, `"commit":null`) || !strings.Contains(got, `"status":"ok"`) {
		t.Fatalf("Body %s", got)
	}
}

func TestInitialStateHasTenOpenLevels(t *testing.T) {
	h := newTestServer(t)
	res := decodeLevels(t, do(t, h, http.MethodGet, "/api/levels", "", ""))
	if len(res.Levels) != 10 || res.Run.ID != "test" || res.Run.UpdatedAt != nil {
		t.Fatalf("Startzustand falsch: %+v", res.Run)
	}
	for i, l := range res.Levels {
		if l.Level != i+1 || l.Status != "offen" || l.Checks == nil || l.Metrics == nil {
			t.Fatalf("Level %d falsch: %+v", i+1, l)
		}
	}
}

func TestResultRules(t *testing.T) {
	h := newTestServer(t)
	const ok = `{"checks":[{"name":"a","ok":true}],"durationMs":10}`
	const bad = `{"checks":[{"name":"a","ok":false}],"durationMs":5}`

	rec := do(t, h, http.MethodPost, "/api/levels/1/result", "application/json", ok)
	if rec.Code != 200 {
		t.Fatalf("Level 1 bestanden: Status %d %s", rec.Code, rec.Body.String())
	}
	res := decodeLevels(t, rec)
	if res.Levels[0].Status != "bestanden" || res.Levels[0].Checks[0].Name != "a" || res.Run.UpdatedAt == nil {
		t.Fatalf("Level 1 nicht bestanden: %+v", res.Levels[0])
	}

	rec = do(t, h, http.MethodPost, "/api/levels/3/result", "application/json", ok)
	if rec.Code != http.StatusConflict {
		t.Fatalf("Level 3 ohne 2: Status %d, erwartet 409", rec.Code)
	}

	rec = do(t, h, http.MethodPost, "/api/levels/2/result", "application/json", bad)
	if rec.Code != 200 {
		t.Fatalf("Level 2 fehlgeschlagen: Status %d", rec.Code)
	}
	res = decodeLevels(t, rec)
	if res.Levels[1].Status != "fehlgeschlagen" || res.Levels[2].Status != "gesperrt" {
		t.Fatalf("Fehlschlag sperrt höhere Levels nicht: %+v", res.Levels[1:3])
	}

	// Ein Fehler bei Level 1 macht Level 2 und die höheren Levels zu gesperrt.
	rec = do(t, h, http.MethodPost, "/api/levels/1/result", "application/json", bad)
	res = decodeLevels(t, rec)
	if res.Levels[0].Status != "fehlgeschlagen" {
		t.Fatalf("Level 1 hätte fehlgeschlagen sein sollen")
	}
	for _, l := range res.Levels[1:] {
		if l.Status != "gesperrt" || l.CheckedAt != nil || len(l.Checks) != 0 || len(l.Metrics) != 0 {
			t.Fatalf("Level %d nicht geleert: %+v", l.Level, l)
		}
	}
}

func TestMetricsNullCountsAsEmpty(t *testing.T) {
	h := newTestServer(t)
	rec := do(t, h, http.MethodPost, "/api/levels/1/result", "application/json",
		`{"checks":[{"name":"a","ok":true}],"durationMs":1,"metrics":null}`)
	if rec.Code != 200 {
		t.Fatalf("Status %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"metrics":{}`) {
		t.Fatalf("metrics null sollte {} ergeben: %s", rec.Body.String())
	}
}

func TestInvalidBodiesGive400(t *testing.T) {
	h := newTestServer(t)
	cases := map[string]string{
		"kaputtes JSON":          `{kaputt`,
		"ohne checks":            `{"durationMs":1}`,
		"leere checks":           `{"checks":[],"durationMs":1}`,
		"ohne durationMs":        `{"checks":[{"name":"a","ok":true}]}`,
		"Kommazahl":              `{"checks":[{"name":"a","ok":true}],"durationMs":1.5}`,
		"negative Dauer":         `{"checks":[{"name":"a","ok":true}],"durationMs":-1}`,
		"leerer Name":            `{"checks":[{"name":"","ok":true}],"durationMs":1}`,
		"unbekanntes Feld":       `{"checks":[{"name":"a","ok":true}],"durationMs":1,"x":1}`,
		"unbekanntes Check-Feld": `{"checks":[{"name":"a","ok":true,"x":1}],"durationMs":1}`,
		"metrics kein Objekt":    `{"checks":[{"name":"a","ok":true}],"durationMs":1,"metrics":[1]}`,
		"zweites JSON-Objekt":    `{"checks":[{"name":"a","ok":true}],"durationMs":1}{}`,
	}
	for name, body := range cases {
		rec := do(t, h, http.MethodPost, "/api/levels/1/result", "application/json", body)
		if rec.Code != 400 {
			t.Errorf("%s: Status %d, erwartet 400", name, rec.Code)
			continue
		}
		var e map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e["error"] == "" {
			t.Errorf("%s: Fehlerbody ohne error: %s", name, rec.Body.String())
		}
	}
}

func TestContentTypeAndSize(t *testing.T) {
	h := newTestServer(t)
	body := `{"checks":[{"name":"a","ok":true}],"durationMs":1}`
	if rec := do(t, h, http.MethodPost, "/api/levels/1/result", "text/plain", body); rec.Code != 415 {
		t.Errorf("text/plain: Status %d, erwartet 415", rec.Code)
	}
	if rec := do(t, h, http.MethodPost, "/api/levels/1/result", "", body); rec.Code != 415 {
		t.Errorf("ohne Content-Type: Status %d, erwartet 415", rec.Code)
	}
	if rec := do(t, h, http.MethodPost, "/api/levels/1/result", "application/json; charset=utf-8", body); rec.Code != 200 {
		t.Errorf("mit charset: Status %d, erwartet 200", rec.Code)
	}
	big := `{"checks":[{"name":"` + strings.Repeat("x", 70000) + `","ok":true}],"durationMs":1}`
	if rec := do(t, h, http.MethodPost, "/api/levels/1/result", "application/json", big); rec.Code != 413 {
		t.Errorf("zu großer Body: Status %d, erwartet 413", rec.Code)
	}
}

func TestRoutingErrors(t *testing.T) {
	h := newTestServer(t)
	cases := []struct {
		method, path string
		code         int
		allow        string
	}{
		{http.MethodGet, "/api/levels/0", 404, ""},
		{http.MethodGet, "/api/levels/11", 404, ""},
		{http.MethodGet, "/api/levels/abc", 404, ""},
		{http.MethodGet, "/api/levels/+1", 404, ""},
		{http.MethodGet, "/gibt-es-nicht", 404, ""},
		{http.MethodDelete, "/api/levels", 405, "GET"},
		{http.MethodGet, "/api/levels/1/result", 405, "POST"},
		{http.MethodPost, "/api/health", 405, "GET"},
		{http.MethodPost, "/api/levels/1", 405, "GET"},
	}
	for _, c := range cases {
		rec := do(t, h, c.method, c.path, "", "")
		if rec.Code != c.code {
			t.Errorf("%s %s: Status %d, erwartet %d", c.method, c.path, rec.Code, c.code)
		}
		if c.allow != "" && rec.Header().Get("Allow") != c.allow {
			t.Errorf("%s %s: Allow %q, erwartet %q", c.method, c.path, rec.Header().Get("Allow"), c.allow)
		}
		if rec.Header().Get("Content-Type") != "application/json" {
			t.Errorf("%s %s: Content-Type %q", c.method, c.path, rec.Header().Get("Content-Type"))
		}
	}
}

func TestConcurrentReportsStayConsistent(t *testing.T) {
	h := newTestServer(t)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := do(t, h, http.MethodPost, "/api/levels/1/result", "application/json",
				`{"checks":[{"name":"a","ok":true}],"durationMs":1}`)
			if rec.Code >= 500 {
				t.Errorf("Status %d", rec.Code)
			}
		}()
	}
	wg.Wait()
	res := decodeLevels(t, do(t, h, http.MethodGet, "/api/levels", "", ""))
	if res.Levels[0].Status != "bestanden" {
		t.Fatalf("Level 1 nach parallelen Meldungen: %s", res.Levels[0].Status)
	}
}
