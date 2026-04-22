package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	_ "github.com/lib/pq"
)

type Greeting struct {
	ID        int64     `json:"id"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
}

type Config struct {
	Port       int
	DBHost     string
	DBPort     int
	DBUser     string
	DBPassword string
	DBName     string
}

type Server struct {
	db  *sql.DB
	log *slog.Logger
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	cfg, err := loadConfig()
	if err != nil {
		log.Error("config load failed", "err", err)
		os.Exit(1)
	}

	db, err := connectDB(cfg)
	if err != nil {
		log.Error("database connect failed",
			"err", err, "host", cfg.DBHost, "port", cfg.DBPort, "db", cfg.DBName)
		os.Exit(1)
	}
	defer db.Close()

	if err := initSchema(db); err != nil {
		log.Error("schema init failed", "err", err)
		os.Exit(1)
	}
	log.Info("schema ready", "table", "greetings")

	srv := &Server{db: db, log: log}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", srv.health)
	mux.HandleFunc("GET /ready", srv.ready)
	mux.HandleFunc("GET /greetings", srv.listGreetings)
	mux.HandleFunc("POST /greetings", srv.createGreeting)

	httpSrv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           logMiddleware(log, mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	idleClosed := make(chan struct{})
	go func() {
		sigint := make(chan os.Signal, 1)
		signal.Notify(sigint, os.Interrupt, syscall.SIGTERM)
		sig := <-sigint
		log.Info("shutdown signal received", "signal", sig.String())
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(ctx); err != nil {
			log.Error("shutdown error", "err", err)
		}
		close(idleClosed)
	}()

	log.Info("listening", "port", cfg.Port)
	if err := httpSrv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Error("http server error", "err", err)
		os.Exit(1)
	}
	<-idleClosed
	log.Info("bye")
}

func loadConfig() (*Config, error) {
	c := &Config{}
	var err error
	if c.Port, err = requireInt("PORT"); err != nil {
		return nil, err
	}
	if c.DBHost, err = requireString("DB_HOST"); err != nil {
		return nil, err
	}
	if c.DBPort, err = requireInt("DB_PORT"); err != nil {
		return nil, err
	}
	if c.DBUser, err = requireString("DB_USER"); err != nil {
		return nil, err
	}
	if c.DBPassword, err = requireString("DB_PASSWORD"); err != nil {
		return nil, err
	}
	if c.DBName, err = requireString("DB_NAME"); err != nil {
		return nil, err
	}
	return c, nil
}

func requireString(key string) (string, error) {
	v := os.Getenv(key)
	if v == "" {
		return "", fmt.Errorf("env var %s is required but not set", key)
	}
	return v, nil
}

func requireInt(key string) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return 0, fmt.Errorf("env var %s is required but not set", key)
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("env var %s must be an integer, got: %q", key, v)
	}
	return i, nil
}

func connectDB(c *Config) (*sql.DB, error) {
	dsn := fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=disable connect_timeout=5",
		c.DBHost, c.DBPort, c.DBUser, c.DBPassword, c.DBName)
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping db: %w", err)
	}
	return db, nil
}

func initSchema(db *sql.DB) error {
	const ddl = `
		CREATE TABLE IF NOT EXISTS greetings (
			id BIGSERIAL PRIMARY KEY,
			body TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`
	_, err := db.Exec(ddl)
	return err
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "UP"})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.PingContext(ctx); err != nil {
		s.log.Warn("readiness check failed", "err", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "DOWN", "error": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "UP", "db": "connected"})
}

func (s *Server) listGreetings(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(),
		`SELECT id, body, created_at FROM greetings ORDER BY id DESC LIMIT 100`)
	if err != nil {
		s.log.Error("query greetings failed", "err", err)
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	out := make([]Greeting, 0)
	for rows.Next() {
		var g Greeting
		if err := rows.Scan(&g.ID, &g.Body, &g.CreatedAt); err != nil {
			s.log.Error("scan row failed", "err", err)
			http.Error(w, "scan failed", http.StatusInternalServerError)
			return
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		s.log.Error("rows iteration failed", "err", err)
		http.Error(w, "iteration failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) createGreeting(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.log.Warn("invalid json body", "err", err)
		http.Error(w, "invalid json body", http.StatusBadRequest)
		return
	}
	if req.Body == "" {
		http.Error(w, "body must not be empty", http.StatusBadRequest)
		return
	}

	var g Greeting
	err := s.db.QueryRowContext(r.Context(),
		`INSERT INTO greetings (body) VALUES ($1) RETURNING id, body, created_at`,
		req.Body).Scan(&g.ID, &g.Body, &g.CreatedAt)
	if err != nil {
		s.log.Error("insert greeting failed", "err", err)
		http.Error(w, "insert failed", http.StatusInternalServerError)
		return
	}
	s.log.Info("greeting created", "id", g.ID, "body", g.Body)
	writeJSON(w, http.StatusCreated, g)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func logMiddleware(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r)
		log.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rw.status,
			"durationMs", time.Since(start).Milliseconds(),
		)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}
