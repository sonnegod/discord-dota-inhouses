package main

import (
	"strconv"
	"testing"

	proto "github.com/paralin/go-dota2/protocol"
)

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
	spectator := proto.DOTA_GC_TEAM_DOTA_GC_TEAM_SPECTATOR
	lobby.AllMembers = append(lobby.AllMembers, &proto.CSODOTALobbyMember{Id: &serviceID, Team: &spectator})
	lobby.MemberIndices = append(lobby.MemberIndices, 10)
	if !lobbyReady(lobby, players) {
		t.Fatal("expected ten assigned players plus spectator to be ready")
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
