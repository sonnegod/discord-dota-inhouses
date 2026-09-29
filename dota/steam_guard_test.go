package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/paralin/go-steam"
	"github.com/paralin/go-steam/protocol/protobuf/unified"
)

func TestSteamGuardPromptSelectsCodeMethod(t *testing.T) {
	confirmations := []steam.SteamGuardConfirmation{
		{Type: unified.EAuthSessionGuardType_k_EAuthSessionGuardType_DeviceConfirmation},
		{Type: unified.EAuthSessionGuardType_k_EAuthSessionGuardType_EmailCode},
	}
	var output bytes.Buffer
	code, kind, err := readSteamGuard(context.Background(), confirmations, strings.NewReader("2\n12345\n"), &output)
	if err != nil || code != "12345" || kind != unified.EAuthSessionGuardType_k_EAuthSessionGuardType_EmailCode {
		t.Fatalf("code=%q kind=%v err=%v", code, kind, err)
	}
	if strings.Contains(output.String(), code) {
		t.Fatal("Steam Guard code must not be written to worker output")
	}
}

func TestSteamGuardPromptAcceptsMobileApproval(t *testing.T) {
	confirmations := []steam.SteamGuardConfirmation{
		{Type: unified.EAuthSessionGuardType_k_EAuthSessionGuardType_DeviceConfirmation},
	}
	code, kind, err := readSteamGuard(context.Background(), confirmations, strings.NewReader("\n"), &bytes.Buffer{})
	if err != nil || code != "" || kind != unified.EAuthSessionGuardType_k_EAuthSessionGuardType_DeviceConfirmation {
		t.Fatalf("code=%q kind=%v err=%v", code, kind, err)
	}
}
