package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	logger := log.New(os.Stdout, "", log.LstdFlags)

	addr := os.Getenv("LEVELBOARD_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8081"
	}
	dbPath := os.Getenv("LEVELBOARD_DB")
	if dbPath == "" {
		dbPath = ".run/levelboard.db"
	}

	store, err := openSQLStore(dbPath)
	if err != nil {
		logger.Fatalf("Datenbank %s: %v", dbPath, err)
	}
	defer store.Close()

	srv := NewServer(store, Config{RunID: os.Getenv("RUN_ID"), Commit: os.Getenv("LEVELBOARD_COMMIT")})
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(logger),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.ListenAndServe() }()
	logger.Printf("Backend lauscht auf %s, Datenbank %s", addr, dbPath)

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatal(err)
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			logger.Fatalf("Herunterfahren fehlgeschlagen: %v", err)
		}
		logger.Printf("Backend beendet")
	}
}
