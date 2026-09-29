package main

import (
	"encoding/hex"
	"strconv"
	"testing"

	proto "github.com/paralin/go-dota2/protocol"
)

func TestMatchLobbyName(t *testing.T) {
	if got := matchLobbyName("  Friday Inhouse  ", 11); got != "Friday Inhouse #11" {
		t.Fatalf("custom lobby name = %q", got)
	}
	if got := matchLobbyName("", 12); got != "Discord Inhouse #12" {
		t.Fatalf("default lobby name = %q", got)
	}
}

func TestLobbyPassword(t *testing.T) {
	if got, err := lobbyPassword("chosen-password"); err != nil || got != "chosen-password" {
		t.Fatalf("configured password = %q, err = %v", got, err)
	}
	first, err := lobbyPassword("")
	if err != nil {
		t.Fatal(err)
	}
	second, err := lobbyPassword("")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("new lobbies should receive distinct random passwords")
	}
	if decoded, err := hex.DecodeString(first); err != nil || len(decoded) != 12 {
		t.Fatalf("random password has invalid format: %q, err = %v", first, err)
	}
}

func TestLobbyReadyRequiresExactAssignedTeams(t *testing.T) {
	var players []player
	lobby := &proto.CSODOTALobby{}
	for i := 0; i < 10; i++ {
		id := uint64(76561197960265729) + uint64(i)
		teamName := "radiant"
		team := proto.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS
		if i >= 5 {
			teamName = "dire"
			team = proto.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS
		}
		players = append(players, player{steamID: strconv.FormatUint(id, 10), team: teamName})
		lobby.AllMembers = append(lobby.AllMembers, &proto.CSODOTALobbyMember{Id: &id, Team: &team})
		lobby.MemberIndices = append(lobby.MemberIndices, uint32(i))
	}
	serviceID := uint64(76561197960265999)
	playerPool := proto.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL
	lobby.AllMembers = append(lobby.AllMembers, &proto.CSODOTALobbyMember{Id: &serviceID, Team: &playerPool})
	lobby.MemberIndices = append(lobby.MemberIndices, 10)
	if !lobbyReady(lobby, players) {
		t.Fatal("expected ten assigned players plus the worker in the player pool to be ready")
	}
	wrong := proto.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS
	lobby.AllMembers[0].Team = &wrong
	if lobbyReady(lobby, players) {
		t.Fatal("wrong team should prevent launch")
	}
	lobby.MemberIndices = lobby.MemberIndices[1:]
	if lobbyReady(lobby, players) {
		t.Fatal("missing player should prevent launch")
	}
}

func TestSoloLobbyDoesNotAutoLaunch(t *testing.T) {
	id := uint64(76561197960265729)
	team := proto.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS
	lobby := &proto.CSODOTALobby{
		AllMembers:    []*proto.CSODOTALobbyMember{{Id: &id, Team: &team}},
		MemberIndices: []uint32{0},
	}
	if lobbyReady(lobby, []player{{steamID: strconv.FormatUint(id, 10), team: "radiant"}}) {
		t.Fatal("solo test lobby must stay open without auto-launching")
	}
}

func TestLobbyHasMemberUsesActiveIndices(t *testing.T) {
	joined := uint64(76561197960265729)
	left := joined + 1
	lobby := &proto.CSODOTALobby{
		AllMembers:    []*proto.CSODOTALobbyMember{{Id: &joined}, {Id: &left}},
		MemberIndices: []uint32{0},
	}
	if !lobbyHasMember(lobby, joined) || lobbyHasMember(lobby, left) {
		t.Fatal("only active lobby members should count as joined")
	}
}

func TestWorkerIsInPlayerPoolUsesActiveMemberTeam(t *testing.T) {
	workerID := uint64(76561197960265729)
	playerTeam := proto.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS
	playerPool := proto.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL
	lobby := &proto.CSODOTALobby{
		AllMembers:    []*proto.CSODOTALobbyMember{{Id: &workerID, Team: &playerTeam}},
		MemberIndices: []uint32{0},
	}
	if workerIsInPlayerPool(lobby, workerID) {
		t.Fatal("worker in a player slot must not count as in the player pool")
	}
	lobby.AllMembers[0].Team = &playerPool
	if !workerIsInPlayerPool(lobby, workerID) {
		t.Fatal("worker in the player pool must be recognized")
	}
	spectatorTeam := proto.DOTA_GC_TEAM_DOTA_GC_TEAM_SPECTATOR
	lobby.AllMembers[0].Team = &spectatorTeam
	if workerIsInPlayerPool(lobby, workerID) {
		t.Fatal("spectator team must not count as the player pool")
	}
	lobby.AllMembers[0].Team = &playerPool
	lobby.MemberIndices = nil
	if workerIsInPlayerPool(lobby, workerID) {
		t.Fatal("inactive lobby member must not count as in the player pool")
	}
}

func TestValidateInviteRecipientsRejectsWorkerAccount(t *testing.T) {
	workerID := uint64(76561197960265729)
	if err := validateInviteRecipients([]player{{steamID: strconv.FormatUint(workerID, 10)}}, workerID); err == nil {
		t.Fatal("worker account cannot receive its own lobby invite")
	}
	if err := validateInviteRecipients([]player{{steamID: strconv.FormatUint(workerID+1, 10)}}, workerID); err != nil {
		t.Fatalf("separate player account rejected: %v", err)
	}
}

func TestConfiguredGameMode(t *testing.T) {
	for _, test := range []struct {
		mode string
		want uint32
	}{
		{"cm", uint32(proto.DOTA_GameMode_DOTA_GAMEMODE_CM)},
		{"ap", uint32(proto.DOTA_GameMode_DOTA_GAMEMODE_AP)},
	} {
		got, err := configuredGameMode(test.mode)
		if err != nil || got != test.want {
			t.Fatalf("configuredGameMode(%q) = %d, %v; want %d", test.mode, got, err, test.want)
		}
	}
	if _, err := configuredGameMode("invalid"); err == nil {
		t.Fatal("invalid match game mode was accepted")
	}
}
