export function selectPlayers(players, mode, priorityRoles = [], maxWaitMinutes = 30, now = Date.now()) {
  if (players.length < 10) return null;
  const oldest = [...players].sort((a, b) => (a.queue_order ?? a.joined_at) - (b.queue_order ?? b.joined_at) || a.discord_id.localeCompare(b.discord_id));
  if (mode === 'fifo' || (mode === 'mmr' && now - oldest[0].joined_at >= maxWaitMinutes * 60_000)) return oldest.slice(0, 10);
  if (mode === 'role') {
    const rank = p => {
      const roles = JSON.parse(p.role_ids || '[]');
      const index = priorityRoles.findIndex(id => roles.includes(id));
      return index < 0 ? priorityRoles.length : index;
    };
    return oldest.sort((a, b) => rank(a) - rank(b) || (a.queue_order ?? a.joined_at) - (b.queue_order ?? b.joined_at)).slice(0, 10);
  }
  if (mode === 'mmr') {
    const byMMR = [...oldest].sort((a, b) => a.mmr - b.mmr || a.joined_at - b.joined_at);
    let best = null;
    for (let i = 0; i <= byMMR.length - 10; i++) {
      const group = byMMR.slice(i, i + 10);
      const spread = group[9].mmr - group[0].mmr;
      const age = group.reduce((sum, p) => sum + p.joined_at, 0);
      if (!best || spread < best.spread || (spread === best.spread && age < best.age)) best = { group, spread, age };
    }
    return best.group.sort((a, b) => (a.queue_order ?? a.joined_at) - (b.queue_order ?? b.joined_at));
  }
  throw new Error(`Unknown queue mode: ${mode}`);
}

export function balanceTeams(players) {
  if (players.length !== 10) throw new Error('Exactly ten players are required');
  let best = null;
  const total = players.reduce((sum, p) => sum + p.mmr, 0);
  for (let mask = 0; mask < 1 << 10; mask++) {
    if (!(mask & 1) || countBits(mask) !== 5) continue;
    const radiant = players.filter((_, i) => mask & (1 << i));
    const radiantMMR = radiant.reduce((sum, p) => sum + p.mmr, 0);
    const gap = Math.abs(total - 2 * radiantMMR);
    if (!best || gap < best.gap) best = { gap, radiant: new Set(radiant.map(p => p.discord_id)) };
  }
  return players.map(p => ({ ...p, team: best.radiant.has(p.discord_id) ? 'radiant' : 'dire' }));
}

function countBits(n) { let count = 0; while (n) { n &= n - 1; count++; } return count; }
