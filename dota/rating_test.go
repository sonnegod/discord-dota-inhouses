package main

import (
	"database/sql"
	"testing"
)

func TestRatingDelta(t *testing.T) {
	for _, tc := range []struct {
		own, other float64
		won        bool
		want       int
	}{
		{3000, 3000, true, 25},
		{3000, 3000, false, -25},
		{3400, 3000, true, 5},
		{3400, 3000, false, -45},
		{3000, 3400, true, 45},
		{3000, 3400, false, -5},
		{15000, 0, true, 0},
		{0, 15000, false, 0},
	} {
		got := ratingDelta(tc.own, tc.other, tc.won)
		if got != tc.want {
			t.Errorf("ratingDelta(%v,%v,%v) = %d, want %d", tc.own, tc.other, tc.won, got, tc.want)
		}
		if got < -50 || got > 50 {
			t.Errorf("rating change %d exceeded cap", got)
		}
	}
}

func TestApplyMatchRatingsUsesSnapshotAndRecordsActualChange(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE players (discord_id TEXT PRIMARY KEY, mmr INTEGER NOT NULL);
		CREATE TABLE match_players (match_id INTEGER, discord_id TEXT, team TEXT, mmr_at_match INTEGER, mmr_change INTEGER);`)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		team, snapshot, current := "radiant", 3400, 3400
		if i >= 5 {
			team, snapshot, current = "dire", 3000, 3000
		}
		if i == 0 {
			current = 14998
		}
		if _, err := db.Exec("INSERT INTO players(discord_id,mmr) VALUES(?,?)", i, current); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO match_players(match_id,discord_id,team,mmr_at_match) VALUES(1,?,?,?)", i, team, snapshot); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := applyMatchRatings(tx, 1, "radiant"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var mmr, change int
	if err := db.QueryRow("SELECT p.mmr,mp.mmr_change FROM players p JOIN match_players mp USING(discord_id) WHERE p.discord_id=0").Scan(&mmr, &change); err != nil {
		t.Fatal(err)
	}
	if mmr != 15000 || change != 2 {
		t.Fatalf("capped winner got MMR %d change %d", mmr, change)
	}
	if err := db.QueryRow("SELECT p.mmr,mp.mmr_change FROM players p JOIN match_players mp USING(discord_id) WHERE p.discord_id=5").Scan(&mmr, &change); err != nil {
		t.Fatal(err)
	}
	if mmr != 2995 || change != -5 {
		t.Fatalf("loser got MMR %d change %d", mmr, change)
	}
}
