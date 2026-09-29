# Discord Dota inhouses

Two services run one inhouse at a time: a JavaScript Discord bot handles player registration, queues, matchmaking, and stats; a Go worker logs into Steam with [go-steam](https://github.com/paralin/go-steam), creates and watches Dota lobbies with [go-dota2](https://github.com/paralin/go-dota2), and writes results to the same SQLite database.

## What it does

- `/link` opens a Steam OpenID sign-in. The returned SteamID64 is verified with Steam before it is linked to a Discord user. A Steam account can belong to only one Discord user.
- `/roles add position:1` and `/roles remove position:1` edit preferred Dota positions 1–5; `/roles set positions:1,3,5` replaces the full list, and `/roles show` displays it. `/queue join`, `/queue leave`, and `/queue status` manage a persistent queue. Only linked players may join. One active match is allowed at a time.
- FIFO selects the oldest ten regardless of positions and splits them into two teams with the smallest available MMR sum difference. Role mode only forms a match when each team can have one player in each position 1–5. The bot announces the teams and assigned positions in Discord.
- Captain queue takes the oldest ten and makes the two players with the closest MMR captains. A coin flip chooses first pick (FP) and second pick (SP); each captain picks four teammates using `/draft pick player:@name`. The Dota lobby is created after all eight picks.
- The Dota worker creates a public practice lobby, invites the ten Steam accounts, moves itself to the player pool, and launches after all ten join their assigned teams and the worker is confirmed in the player pool. It reads the lobby match ID and polls the game coordinator for the final result.
- `/stats` and `/matches` read completed results from SQLite, including wins, losses, and kills/deaths/assists. The database also keeps each match's hero ID when Dota provides it. `/setmmr` lets a server manager assign a starting or corrected rating. Steam does not expose a player's ranked MMR to this bot. Completed matches update the inhouse rating automatically.
- A server manager can use `/cancelmatch` before a lobby launches if players do not arrive. Players can then queue again.
- A server manager can use `/worker pause` to disconnect the Steam/Dota worker while leaving the Discord bot online, `/worker resume` to reconnect it, and `/worker status` to check the connection. The Go worker process stays open and checks the requested state every five seconds.

## Queue modes

Set `QUEUE_MODE` to one of:

| Mode | Selection rule |
| --- | --- |
| `fifo` | Oldest ten queued players. |
| `role` | Select the oldest group that can fill two teams with one player per position 1–5, using each player's saved preferences. If no complete lineups exist, the queue waits. Among valid position assignments for those ten players, choose the smallest team MMR gap. |
| `captain` | Take the oldest ten; choose the closest MMR pair within those ten as captains. Randomize who picks first, then draft in FP, SP, SP, FP, FP, SP, SP, FP order. |

Role mode uses the position preferences saved when each player joins the queue. To change them while queued, use `/queue leave`, `/roles set`, then `/queue join`. Existing queued players from older versions must rejoin to store position preferences. All queue modes update ratings after a scored match. With equal team average MMR, winners gain 25 and losers lose 25; the change scales with the difference in team average MMR up to 50 points. Ratings stay within 0–15000. Failed and cancelled matches do not change ratings.

A server manager with **Manage Server** permission can use `/settings show`, `/settings queue mode:<fifo|role|captain>`, and `/settings gamemode mode:<cm|ap>` in Discord. Changes are saved in SQLite and apply to matches formed afterward. Existing matches keep the game mode selected when they formed. The queue and lobby modes are also shown by `/queue status`.

Captains can use `/draft status` to see the unpicked players and whose turn is next. The draft survives a bot restart. `/cancelmatch` cancels an unfinished draft; its players can queue again. When upgrading, an old saved `mmr` queue setting becomes `captain`. The `captain` queue mode is separate from Dota's `cm` lobby game mode.

## Setup

1. Install Node.js 22.13+ and Go 1.26+.
2. Create a Discord application and bot, invite it to one server with `bot` and `applications.commands` scopes, and grant it permission to send messages in the announcement channel. Only the `Guilds` gateway intent is used.
3. Copy `.env.example` to `.env` and fill the values. Set `PUBLIC_BASE_URL` to the public HTTPS address that reaches `HTTP_ADDR`. Steam's OpenID callback must reach `/auth/steam/callback` on the Discord service; a reverse proxy or tunnel is needed when hosting locally. Use the same **absolute** `DB_PATH` for both processes.
4. Run `npm install` and `go mod tidy`.
5. From the project root, run `npm start` to launch both services in one terminal. It loads `.env`, starts the Discord service, waits for the database, then starts the Dota worker. You can also run `npm run start:discord` and `npm run start:dota` in separate terminals. If the Go worker exits, Discord stays online; run `npm run start:dota` in another terminal to start it again.
6. Use `/link` and have ten players join the queue. For role mode, each player sets preferred positions with `/roles add` or `/roles set` before joining. Players must accept the Steam lobby invite and join the announced Radiant or Dire team. The worker launches when the lobby cache shows all ten on the correct teams.

The Go service needs a Steam account able to log into Dota 2 and create practice lobbies. Set `STEAM_USERNAME` with either `STEAM_PASSWORD` or `STEAM_ACCESS_TOKEN`. When logging in with a password, the worker prompts in its terminal if Steam Guard requires an email code, mobile code, or approval. Choose a method, enter the code or approve the request, and press Enter. Keep Guard codes in that terminal; do not post them in Discord or chat. A valid `STEAM_ACCESS_TOKEN` skips this interactive step. Keep the `.env` file private. `QUEUE_MODE` and `LOBBY_GAME_MODE` seed the SQLite settings when the Discord service first starts with them; later changes through `/settings` persist across restarts. Use `LOBBY_GAME_MODE=cm` for Captains Mode (the default) or `LOBBY_GAME_MODE=ap` for All Pick. `LOBBY_NAME` is the base name; the worker appends the match number, such as `Discord Inhouse #11`. The worker creates a public lobby and generates a new random password when `LOBBY_PASS_KEY` is empty; set `LOBBY_PASS_KEY` to use a fixed password instead. Players receive direct Steam invites. Set `LOBBY_SERVER_REGION` to the Dota region number for your group if Valve does not accept the default value of `0`.

On Windows PowerShell, npm may resolve to a disabled `.ps1` shim. Run `npm.cmd install` and `npm.cmd start` in that case. If startup says Go was not found, install Go 1.26+ and open a new terminal.

## Operations

For a local lobby test, set `TEST_SOLO_LOBBY=true` in `.env` and restart the Discord bot and Dota worker after updating the code. Use a separate Steam account for the worker and the linked player. Open Dota 2 on the player account before using `/queue join`. One linked player will form a public lobby, be assigned to Radiant, and have an invite requested. Solo test mode takes the oldest queued player regardless of queue mode. The lobby stays open without automatically launching a game; use `/cancelmatch` to end the test. Set `TEST_SOLO_LOBBY=false` and restart the Discord bot to restore the ten-player requirement.

If the player does not see an invite, compare the worker's `Steam logged on as SteamID` and `requesting invite to steamID` log lines with the Steam account actually open in Dota 2. The worker's invite call has no delivery receipt; `lobby` status only confirms that it made the request. The worker retries requests every 90 seconds for players who are still absent from the lobby. Check that the worker and player are Steam friends, or that the player's Dota settings allow invites from non-friends. Also check that both services use the same absolute `DB_PATH`: `./inhouses.db` resolves relative to each process's working directory. After correcting the account or settings, cancel the old test match and create a new one.

The database uses WAL mode so both services can read and write concurrently. Back up the `.db` file with SQLite's backup API or after both services are stopped. The Discord service registers server-specific slash commands when it starts.

`/worker pause` keeps the Go process alive but disconnects its Steam session. `/worker resume` reconnects using the credentials already loaded by that process; Steam Guard may prompt in its terminal. If you run the services in separate terminals, stopping `npm run start:dota` also leaves the Discord bot online, and starting that command again resumes the worker. Queue entries and unfinished drafts remain in SQLite while the worker is offline.

If the Go worker stops after sending a lobby creation request and before seeing the lobby in the coordinator cache, match status stays `creating` to avoid making a duplicate lobby. It will adopt a new visible lobby but will not mistake the previous lobby for the new one. A server manager can run `/cancelmatch` to release a stalled match; players must queue again. Result polling resumes after a normal worker restart if the Dota match ID was already stored. A live ten-player test with a real Steam account is needed before relying on unattended operation; Valve's coordinator can change independently of these libraries.

Run JavaScript tests with `npm test`, Go tests with `go test ./dota`, and compile the worker with `go build ./dota`.
