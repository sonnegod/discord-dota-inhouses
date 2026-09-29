# Discord Dota inhouses

Two services run one inhouse at a time: a JavaScript Discord bot handles player registration, queues, matchmaking, and stats; a Go worker logs into Steam with [go-steam](https://github.com/paralin/go-steam), creates and watches Dota lobbies with [go-dota2](https://github.com/paralin/go-dota2), and writes results to the same SQLite database.

## What it does

- `/link` opens a Steam OpenID sign-in. The returned SteamID64 is verified with Steam before it is linked to a Discord user. A Steam account can belong to only one Discord user.
- `/queue join`, `/queue leave`, and `/queue status` manage a persistent queue. Only linked players may join. One active match is allowed at a time.
- Ten selected players are split into two five-player teams with the smallest available MMR sum difference. The bot announces the teams in Discord.
- The Dota worker creates a private practice lobby, invites the ten Steam accounts, takes the spectator slot, and launches after all ten join their assigned teams. It reads the lobby match ID and polls the game coordinator for the final result.
- `/stats` and `/matches` read completed results from SQLite, including wins, losses, and kills/deaths/assists. The database also keeps each match's hero ID when Dota provides it. `/setmmr` lets a server manager assign a matchmaking rating. MMR is an admin-maintained value; Steam does not expose a player's ranked MMR to this bot.
- A server manager can use `/cancelmatch` before a lobby launches if players do not arrive. Players can then queue again.

## Queue modes

Set `QUEUE_MODE` to one of:

| Mode | Selection rule |
| --- | --- |
| `fifo` | Oldest ten queued players. |
| `role` | Discord roles in `ROLE_PRIORITY_IDS` order take priority, then queue time. Players without a listed role follow. |
| `mmr` | Ten players with the smallest MMR spread, breaking ties by total queue age. After `MMR_MAX_WAIT_MINUTES`, the oldest player is included by selecting the oldest ten. |

The role mode uses the roles a player had when they joined the queue. Rating changes apply when the next match is formed.

A server manager with **Manage Server** permission can use `/settings show`, `/settings queue mode:<fifo|role|mmr>`, and `/settings gamemode mode:<cm|ap>` in Discord. Changes are saved in SQLite and apply to matches formed afterward. Existing matches keep the game mode selected when they formed. The queue and lobby modes are also shown by `/queue status`.

## Setup

1. Install Node.js 22.13+ and Go 1.26+.
2. Create a Discord application and bot, invite it to one server with `bot` and `applications.commands` scopes, and grant it permission to send messages in the announcement channel. Only the `Guilds` gateway intent is used.
3. Copy `.env.example` to `.env` and fill the values. Set `PUBLIC_BASE_URL` to the public HTTPS address that reaches `HTTP_ADDR`. Steam's OpenID callback must reach `/auth/steam/callback` on the Discord service; a reverse proxy or tunnel is needed when hosting locally. Use the same **absolute** `DB_PATH` for both processes.
4. Run `npm install` and `go mod tidy`.
5. Load the variables from `.env` in your shell or process manager. Start the Discord service first with `npm run start:discord`; it creates the database. Start the Dota worker with `go run ./dota`.
6. Use `/link` and have ten players join the queue. Players must accept the Steam lobby invite and join the announced Radiant or Dire team. The worker launches when the lobby cache shows all ten on the correct teams.

The Go service needs a Steam account able to log into Dota 2 and create practice lobbies. Set `STEAM_USERNAME` with either `STEAM_PASSWORD` or `STEAM_ACCESS_TOKEN`. If Steam Guard requires a code or mobile approval, supply a valid access token from a prior authenticated session; the worker does not implement an interactive Steam Guard prompt. Keep the `.env` file private. `QUEUE_MODE` and `LOBBY_GAME_MODE` seed the SQLite settings when the Discord service first starts with them; later changes through `/settings` persist across restarts. Use `LOBBY_GAME_MODE=cm` for Captains Mode (the default) or `LOBBY_GAME_MODE=ap` for All Pick. The worker makes an unlisted lobby and generates a random password when `LOBBY_PASS_KEY` is empty; players receive direct Steam invites. Set `LOBBY_SERVER_REGION` to the Dota region number for your group if Valve does not accept the default value of `0`.

On Windows PowerShell, npm may resolve to a disabled `.ps1` shim. Run `npm.cmd install` and `npm.cmd run start:discord` in that case.

## Operations

The database uses WAL mode so both services can read and write concurrently. Back up the `.db` file with SQLite's backup API or after both services are stopped. The Discord service registers server-specific slash commands when it starts.

If the Go worker stops after sending a lobby creation request and before seeing the lobby in the coordinator cache, match status stays `creating` to avoid making a duplicate lobby. It will adopt a new visible lobby but will not mistake the previous lobby for the new one. A server manager can run `/cancelmatch` to release a stalled match; players must queue again. Result polling resumes after a normal worker restart if the Dota match ID was already stored. A live ten-player test with a real Steam account is needed before relying on unattended operation; Valve's coordinator can change independently of these libraries.

Run JavaScript tests with `npm test`, Go tests with `go test ./dota`, and compile the worker with `go build ./dota`.
