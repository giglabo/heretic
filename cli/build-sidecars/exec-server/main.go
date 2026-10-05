// Command exec-server is the HTTP build-sidecar server for heretic-cli.
//
// It runs inside a per-runtime "builder" container (node/python/java/go/rust)
// that shares the agent's /workspace bind. The agent forwards wrapped build
// commands (npm install, pytest, mvn package, …) to this server over the
// private compose network via the `sidecar-exec` client, so heavy toolchains
// live in the builder rather than the agent image.
//
// Wire contract (see cli/src/templates/assets/sidecar-exec and
// cli/docs/tool-execution-backends-plan.md, "02-contracts"):
//
//	GET  /health          -> 200 {"status":"ok"}
//	GET  /info            -> 200 {"runtime","cwd","version"}   (never leaks env — gap C-10)
//	POST /exec            -> 200 {"exit_code","output","stderr","error"}   (blocking)
//	POST /exec/stream     -> text/event-stream of {"type","data"} frames   (SSE)
//
// Request body for /exec and /exec/stream:
//
//	{"cmd":["npm","install"], "cwd":"/workspace", "timeout":600, "env":{"K":"V"}}
//
// `cmd` is an argv array run WITHOUT a shell. Only the env keys present in the
// request are overlaid on the builder's own environment; the agent's secrets
// are never in scope here (separate container) and are only forwarded when the
// operator opts in via SIDECAR_ENV_PASSTHROUGH on the agent side (gap C-8).
//
// Hardening folded in from the reference implementation's defect register:
//   - C-9  optional bearer-token auth (EXEC_SERVER_TOKEN) + request body limit +
//     read-header timeout; builders publish no ports on the compose network.
//   - C-10 /info never returns the environment.
//   - C-11 stdout and stderr are drained concurrently (no >64 KiB pipe deadlock).
//   - C-12 the child is a process-group leader (Setpgid) and the WHOLE group is
//     killed on timeout, so timed-out builds actually die.
//   - F-1  the health probe reads the configured port; nothing hard-codes :8080.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

const version = "0.1.0"

const (
	// defaultTimeout matches the sidecar-exec client default (gap C-5: the
	// reference client's 300s silently killed long builds).
	defaultTimeout = 600
	// maxTimeout caps how long a single command may run, regardless of request.
	maxTimeout = 3600
	// maxBodyBytes bounds the request body (argv/env/cwd only — never payload).
	maxBodyBytes = 1 << 20 // 1 MiB
	// killGrace gives the I/O copiers time to drain after the process exits or
	// is killed, so grandchildren holding the pipe can't hang Wait forever.
	killGrace = 10 * time.Second
)

type server struct {
	defaultCwd string
	runtime    string
	token      string
}

// execRequest is the POST body for /exec and /exec/stream.
type execRequest struct {
	Cmd     []string          `json:"cmd"`
	Cwd     string            `json:"cwd"`
	Timeout int               `json:"timeout"`
	Env     map[string]string `json:"env"`
}

// execResponse is the blocking /exec reply. exit_code == -1 signals a
// server-side failure (start error / timeout); the client maps a timeout to 124.
type execResponse struct {
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output"`
	Stderr   string `json:"stderr"`
	Error    string `json:"error,omitempty"`
}

// frame is one Server-Sent Event on /exec/stream. Data is a string for
// stdout/stderr/error and the integer exit code for the terminal "exit" frame.
type frame struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

func main() {
	defaultPort := envInt("EXEC_SERVER_PORT", 8080)
	defaultCwd := envStr("EXEC_SERVER_CWD", "/workspace")

	port := flag.Int("port", defaultPort, "TCP port to listen on (env EXEC_SERVER_PORT)")
	cwd := flag.String("cwd", defaultCwd, "default working directory for commands (env EXEC_SERVER_CWD)")
	healthcheck := flag.Bool("healthcheck", false, "probe the local /health endpoint and exit 0/1 (for container HEALTHCHECK)")
	flag.Parse()

	// Healthcheck mode: used by the container HEALTHCHECK / compose healthcheck.
	// It reads the SAME -port, so nothing hard-codes the port (gap F-1).
	if *healthcheck {
		os.Exit(probeHealth(*port))
	}

	s := &server{
		defaultCwd: *cwd,
		runtime:    envStr("EXEC_SERVER_RUNTIME", "unknown"),
		token:      envStr("EXEC_SERVER_TOKEN", ""),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/info", s.auth(s.handleInfo))
	mux.HandleFunc("/exec", s.auth(s.handleExec))
	mux.HandleFunc("/exec/stream", s.auth(s.handleExecStream))

	addr := fmt.Sprintf(":%d", *port)
	srv := &http.Server{
		Addr:    addr,
		Handler: mux,
		// Bound header read; do NOT set ReadTimeout/WriteTimeout — a long build
		// legitimately holds the connection open for minutes.
		ReadHeaderTimeout: 10 * time.Second,
	}

	fmt.Fprintf(os.Stderr, "exec-server %s: runtime=%s cwd=%s listening on %s\n", version, s.runtime, s.defaultCwd, addr)
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintf(os.Stderr, "exec-server: %v\n", err)
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// auth enforces a bearer token when EXEC_SERVER_TOKEN is set (gap C-9). On a
// private single-host compose network the token is optional; on a shared host
// it should be set. /health stays open so healthchecks need no secret.
func (s *server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.token != "" {
			got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if got != s.token {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		next(w, r)
	}
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleInfo reports the runtime and cwd only. It NEVER returns the process
// environment, regardless of any ?env= query param (gap C-10).
func (s *server) handleInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"runtime": s.runtime,
		"cwd":     s.defaultCwd,
		"version": version,
	})
}

func (s *server) handleExec(w http.ResponseWriter, r *http.Request) {
	req, ok := s.parseRequest(w, r)
	if !ok {
		return
	}

	timeout := clampTimeout(req.Timeout)
	dir := req.Cwd
	if dir == "" {
		dir = s.defaultCwd
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()

	cmd := s.buildCmd(ctx, req, dir)

	var outBuf, errBuf bytes.Buffer
	// Assigning *bytes.Buffer (not *os.File) makes exec spawn a goroutine per
	// stream, draining both concurrently — avoids the >64 KiB deadlock (C-11).
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	if err := cmd.Start(); err != nil {
		writeJSON(w, http.StatusOK, execResponse{
			ExitCode: -1,
			Error:    fmt.Sprintf("failed to start command: %v", err),
		})
		return
	}

	waitErr := cmd.Wait()

	if ctx.Err() == context.DeadlineExceeded {
		writeJSON(w, http.StatusOK, execResponse{
			ExitCode: -1,
			Output:   outBuf.String(),
			Stderr:   errBuf.String(),
			Error:    fmt.Sprintf("command timed out after %ds", timeout),
		})
		return
	}

	exitCode, err := exitCodeOf(waitErr)
	if err != nil {
		writeJSON(w, http.StatusOK, execResponse{
			ExitCode: -1,
			Output:   outBuf.String(),
			Stderr:   errBuf.String(),
			Error:    err.Error(),
		})
		return
	}

	writeJSON(w, http.StatusOK, execResponse{
		ExitCode: exitCode,
		Output:   outBuf.String(),
		Stderr:   errBuf.String(),
	})
}

func (s *server) handleExecStream(w http.ResponseWriter, r *http.Request) {
	req, ok := s.parseRequest(w, r)
	if !ok {
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	timeout := clampTimeout(req.Timeout)
	dir := req.Cwd
	if dir == "" {
		dir = s.defaultCwd
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()

	cmd := s.buildCmd(ctx, req, dir)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.sendFrame(w, flusher, nil, frame{Type: "error", Data: err.Error()})
		s.sendFrame(w, flusher, nil, frame{Type: "exit", Data: -1})
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		s.sendFrame(w, flusher, nil, frame{Type: "error", Data: err.Error()})
		s.sendFrame(w, flusher, nil, frame{Type: "exit", Data: -1})
		return
	}

	if err := cmd.Start(); err != nil {
		s.sendFrame(w, flusher, nil, frame{Type: "error", Data: fmt.Sprintf("failed to start command: %v", err)})
		s.sendFrame(w, flusher, nil, frame{Type: "exit", Data: -1})
		return
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(2)
	// Drain both pipes concurrently (C-11) and serialize frame writes with mu.
	go s.streamPipe(&wg, w, flusher, &mu, stdout, "stdout")
	go s.streamPipe(&wg, w, flusher, &mu, stderr, "stderr")
	wg.Wait()

	waitErr := cmd.Wait()

	if ctx.Err() == context.DeadlineExceeded {
		s.sendFrame(w, flusher, &mu, frame{Type: "error", Data: fmt.Sprintf("command timed out after %ds", timeout)})
		s.sendFrame(w, flusher, &mu, frame{Type: "exit", Data: -1})
		return
	}

	exitCode, err := exitCodeOf(waitErr)
	if err != nil {
		s.sendFrame(w, flusher, &mu, frame{Type: "error", Data: err.Error()})
		s.sendFrame(w, flusher, &mu, frame{Type: "exit", Data: -1})
		return
	}
	s.sendFrame(w, flusher, &mu, frame{Type: "exit", Data: exitCode})
}

// ---------------------------------------------------------------------------
// Command construction & streaming helpers
// ---------------------------------------------------------------------------

// buildCmd wires up an *exec.Cmd that runs as its own process-group leader and,
// on context cancel/timeout, kills the ENTIRE group so descendants die too
// (gap C-12). argv is executed directly — never through a shell.
func (s *server) buildCmd(ctx context.Context, req execRequest, dir string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, req.Cmd[0], req.Cmd[1:]...)
	cmd.Dir = dir
	cmd.Env = mergeEnv(req.Env)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			// Negative PID targets the whole process group (Setpgid above makes
			// the child the group leader, so pgid == pid).
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	cmd.WaitDelay = killGrace
	return cmd
}

// streamPipe reads a pipe line-by-line and emits one SSE frame per line.
func (s *server) streamPipe(wg *sync.WaitGroup, w http.ResponseWriter, flusher http.Flusher, mu *sync.Mutex, pipe interface {
	Read([]byte) (int, error)
}, kind string) {
	defer wg.Done()
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024) // tolerate long lines up to 10 MiB
	for scanner.Scan() {
		s.sendFrame(w, flusher, mu, frame{Type: kind, Data: scanner.Text()})
	}
}

// sendFrame writes one `data: <json>\n\n` SSE event and flushes. mu may be nil
// when only one goroutine can be writing (pre-Start error paths).
func (s *server) sendFrame(w http.ResponseWriter, flusher http.Flusher, mu *sync.Mutex, f frame) {
	payload, err := json.Marshal(f)
	if err != nil {
		return
	}
	if mu != nil {
		mu.Lock()
		defer mu.Unlock()
	}
	fmt.Fprintf(w, "data: %s\n\n", payload)
	flusher.Flush()
}

// ---------------------------------------------------------------------------
// Request parsing & small utilities
// ---------------------------------------------------------------------------

func (s *server) parseRequest(w http.ResponseWriter, r *http.Request) (execRequest, bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return execRequest{}, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	var req execRequest
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid request body: %v", err), http.StatusBadRequest)
		return execRequest{}, false
	}
	if len(req.Cmd) == 0 {
		http.Error(w, "cmd must be a non-empty argv array", http.StatusBadRequest)
		return execRequest{}, false
	}
	return req, true
}

// mergeEnv overlays the request's env onto the builder's own environment. The
// builder never holds the agent's secrets, so this only sees what the operator
// explicitly allow-listed on the agent side (gap C-8).
func mergeEnv(overlay map[string]string) []string {
	if len(overlay) == 0 {
		return os.Environ()
	}
	base := os.Environ()
	out := make([]string, 0, len(base)+len(overlay))
	for _, kv := range base {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		if _, override := overlay[key]; override {
			continue // replaced below
		}
		out = append(out, kv)
	}
	for k, v := range overlay {
		out = append(out, k+"="+v)
	}
	return out
}

// exitCodeOf turns a cmd.Wait() error into an exit code. A normal non-zero exit
// returns (code, nil); anything else (couldn't fork, signal without an
// ExitError, …) returns (-1, err).
func exitCodeOf(waitErr error) (int, error) {
	if waitErr == nil {
		return 0, nil
	}
	if ee, ok := waitErr.(*exec.ExitError); ok {
		return ee.ExitCode(), nil
	}
	return -1, waitErr
}

func clampTimeout(t int) int {
	if t <= 0 {
		return defaultTimeout
	}
	if t > maxTimeout {
		return maxTimeout
	}
	return t
}

func probeHealth(port int) int {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n := 0
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil {
		return def
	}
	return n
}
