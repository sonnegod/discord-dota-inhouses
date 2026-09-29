package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/paralin/go-steam"
	"github.com/paralin/go-steam/protocol/protobuf/unified"
)

func promptSteamGuard(ctx context.Context, confirmations []steam.SteamGuardConfirmation) (string, unified.EAuthSessionGuardType, error) {
	return readSteamGuard(ctx, confirmations, os.Stdin, os.Stdout)
}

func readSteamGuard(ctx context.Context, confirmations []steam.SteamGuardConfirmation, input io.Reader, output io.Writer) (string, unified.EAuthSessionGuardType, error) {
	options := make([]steam.SteamGuardConfirmation, 0, len(confirmations))
	for _, confirmation := range confirmations {
		if steamGuardLabel(confirmation.Type) != "" {
			options = append(options, confirmation)
		}
	}
	if len(options) == 0 {
		return "", 0, fmt.Errorf("Steam Guard requested an unsupported confirmation method")
	}

	reader := bufio.NewReader(input)
	fmt.Fprintln(output, "Steam Guard verification is required for the Dota worker account.")
	choice := 0
	if len(options) > 1 {
		for i, option := range options {
			fmt.Fprintf(output, "  %d. %s\n", i+1, steamGuardLabel(option.Type))
		}
		for {
			fmt.Fprint(output, "Choose a verification method: ")
			line, err := readSteamGuardLine(ctx, reader)
			if err != nil {
				return "", 0, err
			}
			n, err := strconv.Atoi(line)
			if err == nil && n >= 1 && n <= len(options) {
				choice = n - 1
				break
			}
			fmt.Fprintln(output, "Enter one of the numbers shown above.")
		}
	}

	selected := options[choice]
	if selected.Message != "" {
		fmt.Fprintln(output, selected.Message)
	}
	switch selected.Type {
	case unified.EAuthSessionGuardType_k_EAuthSessionGuardType_DeviceConfirmation,
		unified.EAuthSessionGuardType_k_EAuthSessionGuardType_EmailConfirmation:
		fmt.Fprint(output, "Approve the Steam sign-in, then press Enter here: ")
		if _, err := readSteamGuardLine(ctx, reader); err != nil {
			return "", 0, err
		}
		return "", selected.Type, nil
	default:
		fmt.Fprint(output, "Enter the Steam Guard code in this terminal: ")
		code, err := readSteamGuardLine(ctx, reader)
		if err != nil {
			return "", 0, err
		}
		if code == "" {
			return "", 0, fmt.Errorf("Steam Guard code cannot be empty")
		}
		return code, selected.Type, nil
	}
}

func readSteamGuardLine(ctx context.Context, reader *bufio.Reader) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	if err == io.EOF && line == "" {
		return "", fmt.Errorf("Steam Guard input ended before verification")
	}
	return strings.TrimSpace(line), nil
}

func steamGuardLabel(kind unified.EAuthSessionGuardType) string {
	switch kind {
	case unified.EAuthSessionGuardType_k_EAuthSessionGuardType_DeviceConfirmation:
		return "Approve in the Steam mobile app"
	case unified.EAuthSessionGuardType_k_EAuthSessionGuardType_EmailConfirmation:
		return "Approve via Steam email"
	case unified.EAuthSessionGuardType_k_EAuthSessionGuardType_DeviceCode:
		return "Code from the Steam mobile app"
	case unified.EAuthSessionGuardType_k_EAuthSessionGuardType_EmailCode:
		return "Code from Steam email"
	default:
		return ""
	}
}
