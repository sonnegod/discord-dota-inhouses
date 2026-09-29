package main

import (
	"database/sql"
	"time"
)

func workerEnabled(db *sql.DB) (bool, error) {
	var enabled bool
	err := db.QueryRow("SELECT enabled FROM worker_control WHERE id=1").Scan(&enabled)
	return enabled, err
}

func workerHeartbeat(db *sql.DB, steamOnline bool) error {
	online := 0
	if steamOnline {
		online = 1
	}
	_, err := db.Exec("UPDATE worker_control SET steam_online=?,heartbeat_at=? WHERE id=1", online, time.Now().UnixMilli())
	return err
}

func workerStopped(db *sql.DB) {
	_, _ = db.Exec("UPDATE worker_control SET steam_online=0,heartbeat_at=NULL WHERE id=1")
}
