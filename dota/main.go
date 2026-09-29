package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"sync/atomic"
	"time"

	dota2 "github.com/paralin/go-dota2"
	"github.com/paralin/go-dota2/cso"
	devents "github.com/paralin/go-dota2/events"
	proto "github.com/paralin/go-dota2/protocol"
	"github.com/paralin/go-steam"
	"github.com/paralin/go-steam/protocol/steamlang"
	"github.com/paralin/go-steam/steamid"
	"github.com/sirupsen/logrus"
	_ "modernc.org/sqlite"
)

type match struct {
	id              int64
	status          string
	gameMode        string
	lobbyID         sql.NullString
	previousLobbyID sql.NullString
	matchID         sql.NullString
}
type player struct {
	steamID string
	team    string
}

var lastResultPoll time.Time

func main() {
	username := os.Getenv("STEAM_USERNAME")
	password := os.Getenv("STEAM_PASSWORD")
	token := os.Getenv("STEAM_ACCESS_TOKEN")
	if username == "" || (password == "" && token == "") {
		log.Fatal("STEAM_USERNAME and STEAM_PASSWORD or STEAM_ACCESS_TOKEN are required")
	}
	path := os.Getenv("DB_PATH")
	if path == "" {
		path = "./inhouses.db"
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.Exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON"); err != nil {
		log.Fatal(err)
	}
	if _, err = db.Exec("SELECT id FROM matches LIMIT 1"); err != nil {
		log.Fatal("Start the Discord service once to initialize the database: ", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	client := steam.NewClient()
	dota := dota2.New(client, logrus.New())
	defer dota.Close()
	details := &steam.LogOnDetails{Username: username, Password: password, AccessToken: token}
	var gcReady atomic.Bool
	var steamLoggedOn atomic.Bool
	go func() {
		for event := range client.Events() {
			switch e := event.(type) {
			case *steam.ConnectedEvent:
				loginCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
				if err := client.Auth.LogOn(loginCtx, details); err != nil {
					log.Printf("Steam login: %v", err)
				}
				cancel()
			case *steam.LoggedOnEvent:
				client.Social.SetPersonaState(steamlang.EPersonaState_Online)
				dota.SetPlaying(true)
				steamLoggedOn.Store(true)
				log.Print("Steam logged on; waiting for Dota coordinator")
			case *steam.DisconnectedEvent:
				gcReady.Store(false)
				steamLoggedOn.Store(false)
			case *devents.GCConnectionStatusChanged:
				gcReady.Store(e.NewState == proto.GCConnectionStatus_GCConnectionStatus_HAVE_SESSION)
			case error:
				log.Printf("Steam event: %v", e)
			}
		}
	}()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	var lastHello time.Time
	for {
		select {
		case <-ctx.Done():
			client.Disconnect()
			return
		case <-ticker.C:
			if !client.Connected() {
				connectCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				_, err := client.ConnectContext(connectCtx)
				cancel()
				if err != nil {
					log.Printf("Steam connect: %v", err)
				}
				continue
			}
			if !gcReady.Load() {
				if steamLoggedOn.Load() && time.Since(lastHello) >= 15*time.Second {
					dota.SayHello()
					lastHello = time.Now()
				}
				continue
			}
			if err := tick(ctx, db, dota); err != nil {
				log.Printf("Dota worker: %v", err)
			}
		}
	}
}

func tick(ctx context.Context, db *sql.DB, dota *dota2.Dota2) error {
	m, err := activeMatch(db)
	if err != nil {
		return err
	}
	lobby, err := currentLobby(dota)
	if err != nil {
		return err
	}
	if m == nil {
		return cleanupCancelledLobby(ctx, db, dota, lobby, 0)
	}
	if err := cleanupCancelledLobby(ctx, db, dota, lobby, m.id); err != nil {
		return err
	}
	if m.status == "pending" {
		gameMode, err := configuredGameMode(m.gameMode)
		if err != nil {
			return err
		}
		var previousLobbyID any
		if lobby != nil {
			previousLobbyID = strconv.FormatUint(lobby.GetLobbyId(), 10)
		}
		claimed, err := db.Exec("UPDATE matches SET status='creating',previous_lobby_id=? WHERE id=? AND status='pending'", previousLobbyID, m.id)
		if err != nil {
			return err
		}
		if rows, _ := claimed.RowsAffected(); rows == 0 {
			return nil
		}
		name := os.Getenv("LOBBY_NAME")
		if name == "" {
			name = "Discord Inhouse"
		}
		pass := os.Getenv("LOBBY_PASS_KEY")
		if pass == "" {
			secret := make([]byte, 12)
			if _, err := rand.Read(secret); err != nil {
				return err
			}
			pass = hex.EncodeToString(secret)
		}
		regionString := os.Getenv("LOBBY_SERVER_REGION")
		var region uint32
		if regionString != "" {
			parsed, err := strconv.ParseUint(regionString, 10, 32)
			if err != nil {
				return fmt.Errorf("LOBBY_SERVER_REGION: %w", err)
			}
			region = uint32(parsed)
		}
		visibility := proto.DOTALobbyVisibility_DOTALobbyVisibility_Unlisted
		allowSpectating := true
		createCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		err = dota.LeaveCreateLobby(createCtx, &proto.CMsgPracticeLobbySetDetails{
			GameName: &name, PassKey: &pass, GameMode: &gameMode, ServerRegion: &region,
			Visibility: &visibility, AllowSpectating: &allowSpectating,
		}, true)
		cancel()
		if errors.Is(err, dota2.ErrNotReady) {
			_, _ = db.Exec("UPDATE matches SET status='pending' WHERE id=? AND status='creating'", m.id)
			return nil
		}
		if err != nil {
			return fmt.Errorf("lobby creation for match %d is uncertain; inspect Steam before retrying: %w", m.id, err)
		}
		lobby, err = currentLobby(dota)
		if err != nil {
			return err
		}
		if lobby == nil {
			return fmt.Errorf("created lobby is missing from cache for match %d", m.id)
		}
		if _, err := db.Exec("UPDATE matches SET lobby_id=? WHERE id=? AND status IN ('creating','cancelled')", strconv.FormatUint(lobby.GetLobbyId(), 10), m.id); err != nil {
			return err
		}
		status, err := matchStatus(db, m.id)
		if err != nil {
			return err
		}
		if status == "cancelled" {
			_, err := dota.DestroyLobby(ctx)
			return err
		}
		dota.JoinLobbyTeam(proto.DOTA_GC_TEAM_DOTA_GC_TEAM_SPECTATOR, 0)
		players, err := matchPlayers(db, m.id)
		if err != nil {
			return err
		}
		if len(players) != 10 {
			return fmt.Errorf("match %d has %d players, expected 10", m.id, len(players))
		}
		for _, p := range players {
			id, err := strconv.ParseUint(p.steamID, 10, 64)
			if err != nil {
				return err
			}
			dota.InviteLobbyMember(steamid.SteamId(id))
		}
		_, err = db.Exec("UPDATE matches SET status='lobby',lobby_id=? WHERE id=? AND status='creating'", strconv.FormatUint(lobby.GetLobbyId(), 10), m.id)
		if err == nil {
			log.Printf("match %d: invited %d players to lobby %d", m.id, len(players), lobby.GetLobbyId())
		}
		return err
	}
	if lobby != nil && m.lobbyID.Valid && strconv.FormatUint(lobby.GetLobbyId(), 10) != m.lobbyID.String {
		lobby = nil
	}
	if m.status == "creating" {
		// A crash after sending CreateLobby is ambiguous. Adopt only a lobby that is visible in the GC cache.
		if lobby == nil {
			return nil
		}
		if m.previousLobbyID.Valid && strconv.FormatUint(lobby.GetLobbyId(), 10) == m.previousLobbyID.String {
			return nil
		}
		if _, err := db.Exec("UPDATE matches SET lobby_id=? WHERE id=? AND status IN ('creating','cancelled')", strconv.FormatUint(lobby.GetLobbyId(), 10), m.id); err != nil {
			return err
		}
		status, err := matchStatus(db, m.id)
		if err != nil {
			return err
		}
		if status == "cancelled" {
			_, err := dota.DestroyLobby(ctx)
			return err
		}
		dota.JoinLobbyTeam(proto.DOTA_GC_TEAM_DOTA_GC_TEAM_SPECTATOR, 0)
		players, err := matchPlayers(db, m.id)
		if err != nil {
			return err
		}
		for _, p := range players {
			id, err := strconv.ParseUint(p.steamID, 10, 64)
			if err != nil {
				return err
			}
			dota.InviteLobbyMember(steamid.SteamId(id))
		}
		_, err = db.Exec("UPDATE matches SET status='lobby',lobby_id=? WHERE id=? AND status='creating'", strconv.FormatUint(lobby.GetLobbyId(), 10), m.id)
		return err
	}
	if m.status == "lobby" && lobby != nil {
		players, err := matchPlayers(db, m.id)
		if err != nil {
			return err
		}
		if lobbyReady(lobby, players) {
			status, err := matchStatus(db, m.id)
			if err != nil {
				return err
			}
			if status != "lobby" {
				return nil
			}
			dota.LaunchLobby()
			_, err = db.Exec("UPDATE matches SET status='live' WHERE id=? AND status='lobby'", m.id)
			if err == nil {
				log.Printf("match %d: launched lobby", m.id)
			}
			return err
		}
	}
	if (m.status == "live" || m.status == "results_pending") && lobby != nil && lobby.GetMatchId() != 0 && !m.matchID.Valid {
		m.matchID = sql.NullString{String: strconv.FormatUint(lobby.GetMatchId(), 10), Valid: true}
		if _, err := db.Exec("UPDATE matches SET dota_match_id=? WHERE id=?", m.matchID.String, m.id); err != nil {
			return err
		}
	}
	if m.status == "live" && m.matchID.Valid && (lobby == nil || lobby.GetState() == proto.CSODOTALobby_POSTGAME) {
		if _, err := db.Exec("UPDATE matches SET status='results_pending' WHERE id=? AND status='live'", m.id); err != nil {
			return err
		}
		m.status = "results_pending"
	}
	if m.status == "results_pending" && m.matchID.Valid {
		if time.Since(lastResultPoll) < 30*time.Second {
			return nil
		}
		lastResultPoll = time.Now()
		id, err := strconv.ParseUint(m.matchID.String, 10, 64)
		if err != nil {
			return err
		}
		queryCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		resp, err := dota.RequestMatchDetails(queryCtx, id)
		cancel()
		if err != nil {
			return err
		}
		result := resp.GetMatch()
		if result == nil || result.GetMatchId() != id || result.GetDuration() == 0 {
			return nil
		}
		var winner string
		switch result.GetMatchOutcome() {
		case proto.EMatchOutcome_k_EMatchOutcome_RadVictory:
			winner = "radiant"
		case proto.EMatchOutcome_k_EMatchOutcome_DireVictory:
			winner = "dire"
		case proto.EMatchOutcome_k_EMatchOutcome_Unknown:
			return nil
		default:
			_, err = db.Exec("UPDATE matches SET status='failed',error=?,finished_at=? WHERE id=? AND status='results_pending'", result.GetMatchOutcome().String(), time.Now().UnixMilli(), m.id)
			return err
		}
		players, err := matchPlayers(db, m.id)
		if err != nil {
			return err
		}
		accounts := make(map[uint32]string, len(players))
		for _, p := range players {
			steamID, err := strconv.ParseUint(p.steamID, 10, 64)
			if err != nil {
				return err
			}
			accounts[uint32(steamID)] = p.steamID
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		for _, p := range result.GetPlayers() {
			steamID, ok := accounts[p.GetAccountId()]
			if !ok || p.GetAccountId() == 0 {
				continue
			}
			if _, err := tx.Exec("UPDATE match_players SET hero_id=?,kills=?,deaths=?,assists=? WHERE match_id=? AND steam_id=?", p.GetHeroId(), p.GetKills(), p.GetDeaths(), p.GetAssists(), m.id, steamID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec("UPDATE matches SET status='complete',winner=?,finished_at=? WHERE id=? AND status='results_pending'", winner, time.Now().UnixMilli(), m.id); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		log.Printf("match %d: Dota match %d won by %s", m.id, id, winner)
		return nil
	}
	return nil
}

func configuredGameMode(mode string) (uint32, error) {
	switch mode {
	case "cm":
		return uint32(proto.DOTA_GameMode_DOTA_GAMEMODE_CM), nil
	case "ap":
		return uint32(proto.DOTA_GameMode_DOTA_GAMEMODE_AP), nil
	default:
		return 0, fmt.Errorf("match game mode %q must be cm or ap", mode)
	}
}

func activeMatch(db *sql.DB) (*match, error) {
	m := new(match)
	err := db.QueryRow("SELECT id,status,game_mode,lobby_id,previous_lobby_id,dota_match_id FROM matches WHERE status IN ('pending','creating','lobby','live','results_pending') ORDER BY id LIMIT 1").Scan(&m.id, &m.status, &m.gameMode, &m.lobbyID, &m.previousLobbyID, &m.matchID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return m, err
}

func matchStatus(db *sql.DB, id int64) (string, error) {
	var status string
	err := db.QueryRow("SELECT status FROM matches WHERE id=?", id).Scan(&status)
	return status, err
}

func cleanupCancelledLobby(ctx context.Context, db *sql.DB, dota *dota2.Dota2, lobby *proto.CSODOTALobby, activeID int64) error {
	if lobby == nil {
		return nil
	}
	var cancelledID int64
	var lobbyID string
	err := db.QueryRow("SELECT id,lobby_id FROM matches WHERE status='cancelled' AND lobby_id IS NOT NULL ORDER BY id DESC LIMIT 1").Scan(&cancelledID, &lobbyID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if activeID > cancelledID || strconv.FormatUint(lobby.GetLobbyId(), 10) != lobbyID {
		return nil
	}
	destroyCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	_, err = dota.DestroyLobby(destroyCtx)
	return err
}

func matchPlayers(db *sql.DB, matchID int64) ([]player, error) {
	rows, err := db.Query("SELECT steam_id,team FROM match_players WHERE match_id=?", matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var players []player
	for rows.Next() {
		var p player
		if err := rows.Scan(&p.steamID, &p.team); err != nil {
			return nil, err
		}
		players = append(players, p)
	}
	return players, rows.Err()
}

func currentLobby(dota *dota2.Dota2) (*proto.CSODOTALobby, error) {
	container, err := dota.GetCache().GetContainerForTypeID(uint32(cso.Lobby))
	if err != nil {
		return nil, err
	}
	obj := container.GetOne()
	if obj == nil {
		return nil, nil
	}
	lobby, ok := obj.(*proto.CSODOTALobby)
	if !ok {
		return nil, fmt.Errorf("unexpected lobby cache type %T", obj)
	}
	return lobby, nil
}

func lobbyReady(lobby *proto.CSODOTALobby, players []player) bool {
	if len(players) != 10 {
		return false
	}
	wanted := make(map[uint64]proto.DOTA_GC_TEAM, 10)
	for _, p := range players {
		id, err := strconv.ParseUint(p.steamID, 10, 64)
		if err != nil {
			return false
		}
		team := proto.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS
		if p.team == "dire" {
			team = proto.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS
		}
		wanted[id] = team
	}
	seen := make(map[uint64]bool, 10)
	members := lobby.GetAllMembers()
	if len(lobby.GetMemberIndices()) < 10 {
		return false
	}
	for _, index := range lobby.GetMemberIndices() {
		if int(index) >= len(members) {
			return false
		}
		member := members[index]
		team, expected := wanted[member.GetId()]
		if expected {
			if member.GetTeam() != team {
				return false
			}
			seen[member.GetId()] = true
		} else if member.GetTeam() == proto.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS || member.GetTeam() == proto.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS {
			return false
		}
	}
	return len(seen) == 10
}
