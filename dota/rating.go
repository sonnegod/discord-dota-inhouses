package main

import (
	"database/sql"
	"fmt"
	"math"
)

// A 50-point Elo factor gives both teams 25 points at even odds.
func ratingDelta(ownAverage, otherAverage float64, won bool) int {
	expected := 1 / (1 + math.Pow(10, (otherAverage-ownAverage)/400))
	actual := 0.0
	if won {
		actual = 1
	}
	return int(math.Round(50 * (actual - expected)))
}

func applyMatchRatings(tx *sql.Tx, matchID int64, winner string) error {
	rows, err := tx.Query(`SELECT mp.discord_id,mp.team,mp.mmr_at_match,p.mmr
		FROM match_players mp JOIN players p ON p.discord_id=mp.discord_id WHERE mp.match_id=?`, matchID)
	if err != nil {
		return err
	}
	type ratingPlayer struct {
		id, team             string
		matchMMR, currentMMR int
	}
	var players []ratingPlayer
	sums := map[string]int{"radiant": 0, "dire": 0}
	counts := map[string]int{"radiant": 0, "dire": 0}
	for rows.Next() {
		var p ratingPlayer
		if err := rows.Scan(&p.id, &p.team, &p.matchMMR, &p.currentMMR); err != nil {
			rows.Close()
			return err
		}
		if _, ok := sums[p.team]; !ok {
			rows.Close()
			return fmt.Errorf("match %d has unknown team %q", matchID, p.team)
		}
		players = append(players, p)
		sums[p.team] += p.matchMMR
		counts[p.team]++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if counts["radiant"] != 5 || counts["dire"] != 5 {
		return fmt.Errorf("match %d needs five players on each team for rating", matchID)
	}
	if winner != "radiant" && winner != "dire" {
		return fmt.Errorf("invalid winning team %q", winner)
	}
	avgRadiant := float64(sums["radiant"]) / 5
	avgDire := float64(sums["dire"]) / 5
	deltas := map[string]int{
		"radiant": ratingDelta(avgRadiant, avgDire, winner == "radiant"),
		"dire":    ratingDelta(avgDire, avgRadiant, winner == "dire"),
	}
	for _, p := range players {
		updated := max(0, min(15000, p.currentMMR+deltas[p.team]))
		if _, err := tx.Exec("UPDATE players SET mmr=? WHERE discord_id=?", updated, p.id); err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE match_players SET mmr_change=? WHERE match_id=? AND discord_id=?", updated-p.currentMMR, matchID, p.id); err != nil {
			return err
		}
	}
	return nil
}
