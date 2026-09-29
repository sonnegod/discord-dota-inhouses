import { Client, Events, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { openDatabase, joinQueue, leaveQueue, queueList, getStats, getRecentMatches, getActiveMatch, getActiveDraft, pickDraftPlayer, cancelActiveDraft, maybeCreateMatch, setMMR, getSettings, setQueueMode, setGameMode, getPreferredPositions, setPreferredPositions, getWorkerStatus, setWorkerEnabled, DRAFT_PICK_ORDER } from './db.js';
import { createSteamLinks } from './steam-link.js';

const required = ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID', 'PUBLIC_BASE_URL'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required`);
const options = {
  testSoloLobby: process.env.TEST_SOLO_LOBBY === 'true'
};
const requiredPlayers = options.testSoloLobby ? 1 : 10;
const db = openDatabase(process.env.DB_PATH || './inhouses.db', {
  queueMode: process.env.QUEUE_MODE || 'fifo',
  gameMode: process.env.LOBBY_GAME_MODE || 'cm'
});
const links = createSteamLinks(db, process.env.PUBLIC_BASE_URL);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Verify and link your Steam account'),
  new SlashCommandBuilder().setName('roles').setDescription('Set your preferred Dota positions (1–5)')
    .addSubcommand(c => c.setName('add').setDescription('Add a preferred position')
      .addIntegerOption(o => o.setName('position').setDescription('Dota position').setRequired(true).setMinValue(1).setMaxValue(5)))
    .addSubcommand(c => c.setName('remove').setDescription('Remove a preferred position')
      .addIntegerOption(o => o.setName('position').setDescription('Dota position').setRequired(true).setMinValue(1).setMaxValue(5)))
    .addSubcommand(c => c.setName('set').setDescription('Set one or more preferred positions')
      .addStringOption(o => o.setName('positions').setDescription('Comma-separated positions, e.g. 1,3,5').setRequired(true)))
    .addSubcommand(c => c.setName('show').setDescription('Show your preferred positions')),
  new SlashCommandBuilder().setName('queue').setDescription('Join, leave, or view the inhouse queue')
    .addSubcommand(c => c.setName('join').setDescription('Join the queue'))
    .addSubcommand(c => c.setName('leave').setDescription('Leave the queue'))
    .addSubcommand(c => c.setName('status').setDescription('Show the queue and current match')),
  new SlashCommandBuilder().setName('draft').setDescription('Captain draft picks and status')
    .addSubcommand(c => c.setName('pick').setDescription('Pick an unassigned player when it is your turn')
      .addUserOption(o => o.setName('player').setDescription('Player to add to your team').setRequired(true)))
    .addSubcommand(c => c.setName('status').setDescription('Show the current captain draft')),
  new SlashCommandBuilder().setName('stats').setDescription('Show inhouse stats')
    .addUserOption(o => o.setName('player').setDescription('Player to inspect')),
  new SlashCommandBuilder().setName('matches').setDescription('Show recent inhouse results'),
  new SlashCommandBuilder().setName('setmmr').setDescription('Set a player’s matchmaking rating')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(o => o.setName('player').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('mmr').setDescription('Rating (0–15000)').setMinValue(0).setMaxValue(15000).setRequired(true)),
  new SlashCommandBuilder().setName('cancelmatch').setDescription('Cancel the waiting inhouse match')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('worker').setDescription('Pause, resume, or inspect the Steam/Dota worker')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(c => c.setName('pause').setDescription('Disconnect Steam while keeping the Discord bot online'))
    .addSubcommand(c => c.setName('resume').setDescription('Reconnect the Steam/Dota worker'))
    .addSubcommand(c => c.setName('status').setDescription('Show worker connection status')),
  new SlashCommandBuilder().setName('settings').setDescription('View or change inhouse settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(c => c.setName('show').setDescription('Show current queue and lobby modes'))
    .addSubcommand(c => c.setName('queue').setDescription('Change player selection rule')
      .addStringOption(o => o.setName('mode').setDescription('Queue mode').setRequired(true)
        .addChoices({ name: 'FIFO', value: 'fifo' }, { name: 'Preferred positions', value: 'role' }, { name: 'Captain draft', value: 'captain' })))
    .addSubcommand(c => c.setName('gamemode').setDescription('Change mode for future Dota lobbies')
      .addStringOption(o => o.setName('mode').setDescription('Dota game mode').setRequired(true)
        .addChoices({ name: 'Captains Mode', value: 'cm' }, { name: 'All Pick', value: 'ap' })))
].map(c => c.toJSON());

client.once(Events.ClientReady, async () => {
  await client.application.commands.set(commands, process.env.DISCORD_GUILD_ID);
  console.log(`Discord ready as ${client.user.tag}`);
  const existing = getActiveMatch(db);
  if (existing) seen.set(existing.id, existing.status);
  setInterval(tick, 5000);
  await tick();
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || interaction.guildId !== process.env.DISCORD_GUILD_ID) return;
  try {
    let content;
    let publicReply = false;
    const id = interaction.user.id;
    switch (interaction.commandName) {
      case 'link':
        content = `Open this link to verify your Steam account (expires in 10 minutes): ${links.linkURL(id)}`;
        break;
      case 'roles': {
        const action = interaction.options.getSubcommand();
        if (action === 'set') {
          const input = interaction.options.getString('positions', true).trim();
          if (!/^[1-5](?:\s*,\s*[1-5])*$/.test(input)) throw new Error('Enter positions 1–5 separated by commas, for example 1,3,5');
          const positions = input.split(',').map(Number);
          setPreferredPositions(db, id, positions);
          content = `Preferred positions saved: ${positions.join(', ')}. If you are already queued, leave and rejoin to use them.`;
        } else {
          const player = getPreferredPositions(db, id);
          if (!player) throw new Error('Link your Steam account with /link first');
          const positions = JSON.parse(player.preferred_positions);
          if (action === 'add' || action === 'remove') {
            const position = interaction.options.getInteger('position', true);
            const updated = action === 'add' ? [...new Set([...positions, position])] : positions.filter(p => p !== position);
            setPreferredPositions(db, id, updated);
            content = `Preferred positions: ${updated.length ? updated.sort().join(', ') : 'none'}. If you are already queued, leave and rejoin to use them.`;
          } else content = positions.length ? `Your preferred positions: ${positions.join(', ')}.` : 'No preferred positions set. Use /roles add or /roles set.';
        }
        break;
      }
      case 'queue': {
        const action = interaction.options.getSubcommand();
        if (action === 'join') {
          const result = joinQueue(db, id, options);
          content = result.match ? `Match #${result.match.id} formed. Waiting for the Dota lobby.` : result.draft ? `Captain draft #${result.draft.id} started. Captains will pick the other eight players.` : `Queued. ${result.count}/${requiredPlayers} waiting.`;
          if (result.match) void announce(formatMatch(result.match));
          if (result.draft) void tick();
        } else if (action === 'leave') content = leaveQueue(db, id) ? 'You left the queue.' : 'You are not queued.';
        else {
          const active = getActiveMatch(db);
          const draft = getActiveDraft(db);
          const queue = queueList(db);
          const shown = queue.slice(0, 20);
          content = `Queue: ${queue.length}/${requiredPlayers} — ${shown.length ? shown.map((p, i) => `${i + 1}. <@${p.discord_id}>`).join(' ') : 'empty'}${queue.length > shown.length ? ` …and ${queue.length - shown.length} more` : ''}\n${active ? `Match #${active.id}: ${active.status}` : draft ? `Captain draft #${draft.id}: pick ${draft.next_pick + 1}/8` : 'No active match.'}`;
          const settings = getSettings(db);
          content = `Queue mode: ${settings.queue_mode}. Lobby mode: ${settings.game_mode.toUpperCase()}.\n${content}`;
          if (!getWorkerStatus(db).enabled) content += '\nSteam/Dota worker is paused; lobby creation waits until resumed.';
        }
        break;
      }
      case 'draft': {
        const action = interaction.options.getSubcommand();
        if (action === 'pick') {
          const player = interaction.options.getUser('player', true);
          const result = pickDraftPlayer(db, id, player.id);
          content = result.match ? `${formatMatch(result.match)}\nDraft complete; the Dota lobby is next.` : formatDraft(result.draft);
          publicReply = true;
        } else {
          const draft = getActiveDraft(db);
          content = draft ? formatDraft(draft) : 'There is no active captain draft.';
        }
        break;
      }
      case 'stats': {
        const player = interaction.options.getUser('player') || interaction.user;
        const stats = getStats(db, player.id);
        content = stats ? `<@${player.id}> — MMR: ${stats.mmr}, Games: ${stats.games}, Wins: ${stats.wins}, Losses: ${stats.games - stats.wins}, K/D/A: ${stats.kills}/${stats.deaths}/${stats.assists}` : 'That player has not linked Steam yet.';
        break;
      }
      case 'matches': {
        const matches = getRecentMatches(db);
        content = matches.length ? matches.map(m => `#${m.id}: ${m.winner} won — Dota match ${m.dota_match_id}`).join('\n') : 'No completed matches yet.';
        break;
      }
      case 'setmmr': {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Manage Server permission is required');
        const player = interaction.options.getUser('player', true);
        const mmr = interaction.options.getInteger('mmr', true);
        content = setMMR(db, player.id, mmr) ? `Set <@${player.id}> to ${mmr} MMR.` : 'That player must link Steam first.';
        break;
      }
      case 'settings': {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Manage Server permission is required');
        const action = interaction.options.getSubcommand();
        if (action === 'queue') {
          const mode = interaction.options.getString('mode', true);
          setQueueMode(db, mode);
          content = `Queue mode set to ${mode}. Future matches will use it.`;
        } else if (action === 'gamemode') {
          const mode = interaction.options.getString('mode', true);
          setGameMode(db, mode);
          content = `Lobby game mode set to ${mode === 'cm' ? 'Captains Mode' : 'All Pick'}. Future matches will use it.`;
        } else {
          const settings = getSettings(db);
          content = `Queue mode: ${settings.queue_mode}. Lobby game mode: ${settings.game_mode === 'cm' ? 'Captains Mode' : 'All Pick'}.`;
        }
        break;
      }
      case 'worker': {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Manage Server permission is required');
        const action = interaction.options.getSubcommand();
        if (action === 'pause') setWorkerEnabled(db, false);
        if (action === 'resume') setWorkerEnabled(db, true);
        const status = getWorkerStatus(db);
        const state = !status.running ? 'Go worker process is not reporting in' : !status.enabled && status.steamOnline ? 'Steam disconnect requested' : !status.enabled ? 'Steam disconnected; Discord bot remains online' : status.steamOnline ? 'Steam online' : 'Steam connecting';
        content = `Worker: ${status.enabled ? 'enabled' : 'paused'}. ${state}.`;
        break;
      }
      case 'cancelmatch': {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Manage Server permission is required');
        const draft = getActiveDraft(db);
        if (draft) {
          cancelActiveDraft(db);
          content = `Cancelled captain draft #${draft.id}. Players may join the queue again.`;
          void announce(content);
          break;
        }
        const active = getActiveMatch(db);
        if (!active || !['pending', 'creating', 'lobby'].includes(active.status)) throw new Error('There is no waiting match to cancel');
        const result = db.prepare("UPDATE matches SET status='cancelled',error='Cancelled by a server manager',finished_at=? WHERE id=? AND status IN ('pending','creating','lobby')").run(Date.now(), active.id);
        content = result.changes ? `Cancelled match #${active.id}. Players may join the queue again.` : 'Match already started.';
        break;
      }
      default: return;
    }
    await interaction.reply({ content, ...(publicReply ? {} : { flags: MessageFlags.Ephemeral }), allowedMentions: { parse: [] } });
  } catch (error) {
    console.error('Discord command error:', error);
    const content = error.message || 'Command failed';
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
});

async function announce(content) {
  try {
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error('Announcement channel is not text based');
    await channel.send({ content, allowedMentions: { parse: ['users'] } });
    return true;
  } catch (error) { console.error('Could not announce match:', error); return false; }
}

const seen = new Map();
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const draft = getActiveDraft(db);
    if (draft && !draft.announced_at) {
      if (await announce(formatDraft(draft))) db.prepare('UPDATE drafts SET announced_at=? WHERE id=? AND announced_at IS NULL').run(Date.now(), draft.id);
    }
    const match = getActiveMatch(db);
    if (match && seen.get(match.id) !== match.status) {
      seen.set(match.id, match.status);
      if (match.status === 'lobby') await announce(`Match #${match.id}: Dota lobby ${match.lobby_id} is ready. The worker requested Steam invites, but delivery is not confirmed. Open Dota 2, check for the lobby invite, and join your assigned team. Solo test lobbies stay open without auto-launch.`);
      if (match.status === 'live') await announce(`Match #${match.id} has started${match.dota_match_id ? ` (Dota match ${match.dota_match_id})` : ''}.`);
      if (match.status === 'results_pending') await announce(`Match #${match.id} ended. Waiting for the Dota result.`);
    }
    const done = db.prepare("SELECT * FROM matches WHERE status IN ('complete','failed','cancelled') AND announced_at IS NULL ORDER BY id").all();
    for (const row of done) {
      const posted = await announce(row.status === 'complete' ? `Match #${row.id}: ${row.winner} won. Dota match ${row.dota_match_id}.` : row.status === 'cancelled' ? `Match #${row.id} was cancelled. Players may join the queue again.` : `Match #${row.id} has no scored result: ${row.error || 'unknown error'}.`);
      if (posted) db.prepare('UPDATE matches SET announced_at=? WHERE id=? AND announced_at IS NULL').run(Date.now(), row.id);
    }
    if (!getActiveMatch(db)) {
      const next = maybeCreateMatch(db, options);
      if (next?.draft) {
        if (await announce(formatDraft(next.draft)))
          db.prepare('UPDATE drafts SET announced_at=? WHERE id=? AND announced_at IS NULL').run(Date.now(), next.draft.id);
      } else if (next) await announce(formatMatch(next));
    }
  } catch (error) { console.error('Match polling error:', error); }
  finally { ticking = false; }
}
function formatMatch(match) {
  const team = name => match.players.filter(p => p.team === name).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map(p => `${p.position ? `${p.position}: ` : ''}<@${p.discord_id}>`).join(' ');
  return `Match #${match.id} formed!\nRadiant: ${team('radiant')}\nDire: ${team('dire')}\nJoin the assigned team after accepting your Steam invite.`;
}

function formatDraft(draft) {
  const fp = `<@${draft.first_captain}>`;
  const sp = `<@${draft.second_captain}>`;
  const captainMMR = id => draft.players.find(p => p.discord_id === id)?.mmr;
  const team = name => draft.players.filter(p => p.team === name).map(p => `<@${p.discord_id}>`).join(' ');
  const available = draft.players.filter(p => !p.team).map(p => `<@${p.discord_id}> (${p.mmr})`).join(' ');
  const nextTeam = DRAFT_PICK_ORDER[draft.next_pick];
  const next = nextTeam === 'radiant' ? fp : sp;
  return `Captain draft #${draft.id}: FP ${fp} (${captainMMR(draft.first_captain)} MMR, Radiant), SP ${sp} (${captainMMR(draft.second_captain)} MMR, Dire).\nRadiant: ${team('radiant')}\nDire: ${team('dire')}\nAvailable (MMR): ${available}\nPick ${draft.next_pick + 1}/8: ${next} use /draft pick player. Order: FP, SP, SP, FP, FP, SP, SP, FP.`;
}

const addr = process.env.HTTP_ADDR || '127.0.0.1:8080';
const split = addr.lastIndexOf(':');
links.server.listen(Number(addr.slice(split + 1)), addr.slice(0, split), () => console.log(`Steam link callback listening on ${addr}`));
await client.login(process.env.DISCORD_TOKEN);
