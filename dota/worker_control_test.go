package main

import (
	"database/sql"
	"testing"
)

func TestWorkerControlReadsPauseAndClearsHeartbeatOnStop(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE worker_control (id INTEGER PRIMARY KEY, enabled INTEGER, steam_online INTEGER, heartbeat_at INTEGER);
		INSERT INTO worker_control VALUES (1,1,0,NULL)`); err != nil {
		t.Fatal(err)
	}
	enabled, err := workerEnabled(db)
	if err != nil || !enabled {
		t.Fatalf("enabled = %v, err = %v", enabled, err)
	}
	if _, err := db.Exec("UPDATE worker_control SET enabled=0 WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	enabled, err = workerEnabled(db)
	if err != nil || enabled {
		t.Fatalf("paused = %v, err = %v", !enabled, err)
	}
	if err := workerHeartbeat(db, true); err != nil {
		t.Fatal(err)
	}
	var online int
	var heartbeat sql.NullInt64
	if err := db.QueryRow("SELECT steam_online,heartbeat_at FROM worker_control WHERE id=1").Scan(&online, &heartbeat); err != nil {
		t.Fatal(err)
	}
	if online != 1 || !heartbeat.Valid {
		t.Fatalf("heartbeat = %v, online = %d", heartbeat, online)
	}
	workerStopped(db)
	if err := db.QueryRow("SELECT steam_online,heartbeat_at FROM worker_control WHERE id=1").Scan(&online, &heartbeat); err != nil {
		t.Fatal(err)
	}
	if online != 0 || heartbeat.Valid {
		t.Fatalf("stopped heartbeat = %v, online = %d", heartbeat, online)
	}
}
