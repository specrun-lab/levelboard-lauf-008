package main

import (
	"errors"
)

// State ist der Stand eines Durchlaufs: die 10 Levels und der Zeitpunkt der letzten Meldung.
type State struct {
	Levels    []Level
	UpdatedAt *string
}

// Store speichert den Stand und die Historie. Die Regeln setzt applyReport durch.
type Store interface {
	State() (State, error)
	Report(n int, rep Report, at string) (State, error)
	History(n, limit int) (History, error)
}

var ErrOutOfOrder = errors.New("ein niedrigeres Level ist nicht bestanden")

// applyReport wendet die Regeln aus spec/04-api.md auf den Stand an und liefert den neuen Stand.
// Bei einem Konflikt liefert es ErrOutOfOrder; der Aufrufer schreibt dann nichts.
func applyReport(levels []Level, n int, rep Report, at string) ([]Level, error) {
	for k := 1; k < n; k++ {
		if levels[k-1].Status != "bestanden" {
			return nil, ErrOutOfOrder
		}
	}
	status := "bestanden"
	for _, c := range rep.Checks {
		if !c.OK {
			status = "fehlgeschlagen"
			break
		}
	}
	next := make([]Level, len(levels))
	copy(next, levels)
	dur := rep.DurationMs
	checkedAt := at
	next[n-1] = Level{
		Level:      n,
		Title:      titles[n-1],
		Status:     status,
		CheckedAt:  &checkedAt,
		DurationMs: &dur,
		Checks:     rep.Checks,
		Metrics:    rep.Metrics,
	}
	above := "gesperrt"
	if status == "bestanden" {
		above = "offen"
	}
	for k := n + 1; k <= 10; k++ {
		next[k-1] = emptyLevel(k)
		next[k-1].Status = above
	}
	return next, nil
}

var titles = [10]string{
	"Statische Seite",
	"Webserver",
	"REST-Backend",
	"Datenbank",
	"Frontend + Backend",
	"Repo + CI",
	"Images in der Pipeline",
	"Deployment",
	"Live-Prüfung",
	"Metriken veröffentlicht",
}

const version = "0.1.0"

// Datenformen wie in results.schema.json und 04-api.md.
type Check struct {
	Name string `json:"name"`
	OK   bool   `json:"ok"`
}

type Level struct {
	Level      int            `json:"level"`
	Title      string         `json:"title"`
	Status     string         `json:"status"`
	CheckedAt  *string        `json:"checkedAt"`
	DurationMs *int64         `json:"durationMs"`
	Checks     []Check        `json:"checks"`
	Metrics    map[string]any `json:"metrics"`
}

type Run struct {
	ID        string  `json:"id"`
	Version   string  `json:"version"`
	Commit    *string `json:"commit"`
	UpdatedAt *string `json:"updatedAt"`
}

type Results struct {
	Run    Run     `json:"run"`
	Levels []Level `json:"levels"`
}

type HistoryEntry struct {
	ID         int64          `json:"id"`
	Status     string         `json:"status"`
	CheckedAt  string         `json:"checkedAt"`
	DurationMs int64          `json:"durationMs"`
	Checks     []Check        `json:"checks"`
	Metrics    map[string]any `json:"metrics"`
}

type History struct {
	Level   int            `json:"level"`
	Entries []HistoryEntry `json:"entries"`
}

// Report ist eine geprüfte, syntaktisch gültige Meldung.
type Report struct {
	Checks     []Check
	DurationMs int64
	Metrics    map[string]any
}

func emptyLevel(n int) Level {
	return Level{Level: n, Title: titles[n-1], Status: "offen", Checks: []Check{}, Metrics: map[string]any{}}
}
