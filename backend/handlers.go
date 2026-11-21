package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strconv"
	"time"
)

const (
	maxBody    = 64 * 1024
	isoLayout  = "2006-01-02T15:04:05.000Z" // wie JavaScript toISOString()
	defaultRun = "lokal"
)

// Config kommt aus der Umgebung: RUN_ID, LEVELBOARD_COMMIT.
type Config struct {
	RunID  string
	Commit string
}

type Server struct {
	store Store
	cfg   Config
	now   func() time.Time
}

func NewServer(store Store, cfg Config) *Server {
	return &Server{store: store, cfg: cfg, now: time.Now}
}

// Handler liefert alle Routen. Methoden prüft jede Route selbst, damit Fehler immer JSON sind.
func (s *Server) Handler(logger *log.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.health)
	mux.HandleFunc("/api/levels", s.levels)
	mux.HandleFunc("/api/levels/{n}", s.level)
	mux.HandleFunc("/api/levels/{n}/result", s.result)
	mux.HandleFunc("/api/levels/{n}/history", s.history)
	mux.HandleFunc("/", notFound)
	return logRequests(logger, mux)
}

func (s *Server) commit() *string {
	if s.cfg.Commit == "" {
		return nil
	}
	c := s.cfg.Commit
	return &c
}

func (s *Server) runID() string {
	if s.cfg.RunID == "" {
		return defaultRun
	}
	return s.cfg.RunID
}

func (s *Server) results(st State) Results {
	return Results{
		Run:    Run{ID: s.runID(), Version: version, Commit: s.commit(), UpdatedAt: st.UpdatedAt},
		Levels: st.Levels,
	}
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Status  string  `json:"status"`
		Version string  `json:"version"`
		Commit  *string `json:"commit"`
	}{"ok", version, s.commit()})
}

func (s *Server) levels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	st, err := s.store.State()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Stand konnte nicht gelesen werden")
		return
	}
	writeJSON(w, http.StatusOK, s.results(st))
}

func (s *Server) level(w http.ResponseWriter, r *http.Request) {
	n, ok := levelNumber(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	st, err := s.store.State()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Stand konnte nicht gelesen werden")
		return
	}
	writeJSON(w, http.StatusOK, st.Levels[n-1])
}

// Reihenfolge der Prüfung: Levelnummer (404), Methode (405), Content-Type (415), Größe (413), Body (400), Reihenfolge (409).
func (s *Server) result(w http.ResponseWriter, r *http.Request) {
	n, ok := levelNumber(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "Content-Type muss application/json sein")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "Body größer als 64 KB")
			return
		}
		writeError(w, http.StatusBadRequest, "Body konnte nicht gelesen werden")
		return
	}
	rep, msg := parseReport(body)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	st, err := s.store.Report(n, rep, s.now().UTC().Format(isoLayout))
	if errors.Is(err, ErrOutOfOrder) {
		writeError(w, http.StatusConflict, ErrOutOfOrder.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Meldung konnte nicht gespeichert werden")
		return
	}
	writeJSON(w, http.StatusOK, s.results(st))
}

// history liefert die angenommenen Meldungen zu Level n, neueste zuerst. limit: 1 bis 500, Standard 50.
func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	n, ok := levelNumber(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	limit := 50
	if vals, has := r.URL.Query()["limit"]; has {
		raw := ""
		if len(vals) > 0 {
			raw = vals[0]
		}
		v, err := strconv.Atoi(raw)
		if err != nil || !allDigits(raw) || v < 1 || v > 500 {
			writeError(w, http.StatusBadRequest, "limit: ganze Zahl von 1 bis 500 erwartet")
			return
		}
		limit = v
	}
	h, err := s.store.History(n, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Historie konnte nicht gelesen werden")
		return
	}
	writeJSON(w, http.StatusOK, h)
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

type reportIn struct {
	Checks     []checkIn       `json:"checks"`
	DurationMs *int64          `json:"durationMs"`
	Metrics    json.RawMessage `json:"metrics"`
}

type checkIn struct {
	Name *string `json:"name"`
	OK   *bool   `json:"ok"`
}

// parseReport prüft den Body strikt: unbekannte Felder, Pflichtfelder, Wertebereiche.
// Liefert eine deutsche Fehlermeldung, wenn etwas nicht passt.
func parseReport(body []byte) (Report, string) {
	const badJSON = "ungültiges JSON"
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var in reportIn
	if err := dec.Decode(&in); err != nil {
		return Report{}, badJSON
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return Report{}, badJSON
	}
	if len(in.Checks) < 1 || len(in.Checks) > 100 {
		return Report{}, "checks: 1 bis 100 Einträge erwartet"
	}
	checks := make([]Check, 0, len(in.Checks))
	for _, c := range in.Checks {
		if c.Name == nil || *c.Name == "" || c.OK == nil {
			return Report{}, "jeder Check braucht name (nicht leer) und ok (true/false)"
		}
		checks = append(checks, Check{Name: *c.Name, OK: *c.OK})
	}
	if in.DurationMs == nil || *in.DurationMs < 0 {
		return Report{}, "durationMs: ganze Zahl ≥ 0 erwartet"
	}
	metrics := map[string]any{}
	if raw := bytes.TrimSpace(in.Metrics); len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &metrics); err != nil {
			return Report{}, "metrics muss ein Objekt sein"
		}
	}
	return Report{Checks: checks, DurationMs: *in.DurationMs, Metrics: metrics}, ""
}

// levelNumber liest {n}: nur Ziffern, 1 bis 10. Sonst 404.
func levelNumber(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.PathValue("n")
	for _, c := range raw {
		if c < '0' || c > '9' {
			writeError(w, http.StatusNotFound, "unbekanntes Level")
			return 0, false
		}
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 10 {
		writeError(w, http.StatusNotFound, "unbekanntes Level")
		return 0, false
	}
	return n, true
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "unbekannter Pfad")
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeError(w, http.StatusMethodNotAllowed, "Methode nicht erlaubt")
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// logRequests schreibt pro Anfrage eine Zeile.
func logRequests(logger *log.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		logger.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Microsecond))
	})
}
