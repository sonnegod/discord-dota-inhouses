const POSITIONS = [1, 2, 3, 4, 5];

export function selectPlayers(players, mode) {
  if (players.length < 10) return null;
  const oldest = [...players].sort((a, b) => (a.queue_order ?? a.joined_at) - (b.queue_order ?? b.joined_at) || a.discord_id.localeCompare(b.discord_id));
  if (mode === 'fifo' || mode === 'captain') return oldest.slice(0, 10);
  if (mode === 'role') {
    // Fill two places for each position. Augmenting paths preserve older players
    // while allowing a flexible player to move when a later specialist joins.
    const slots = Array(10).fill(null);
    const visit = (player, seen) => {
      for (const position of JSON.parse(player.preferred_positions || '[]')) {
        if (!POSITIONS.includes(position)) continue;
        for (const slot of [(position - 1) * 2, (position - 1) * 2 + 1]) {
          if (seen.has(slot)) continue;
          seen.add(slot);
          if (!slots[slot] || visit(slots[slot], seen)) {
            slots[slot] = player;
            return true;
          }
        }
      }
      return false;
    };
    for (const player of oldest) {
      visit(player, new Set());
      if (slots.every(Boolean)) {
        const selected = new Set(slots);
        return oldest.filter(p => selected.has(p));
      }
    }
    return null;
  }
  throw new Error(`Unknown queue mode: ${mode}`);
}

export function closestCaptains(players) {
  if (players.length !== 10) throw new Error('Exactly ten players are required');
  let best = null;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const gap = Math.abs(players[i].mmr - players[j].mmr);
      if (!best || gap < best.gap) best = { gap, captains: [players[i], players[j]] };
    }
  }
  return best.captains;
}

export function balanceRoleTeams(players) {
  if (players.length !== 10) throw new Error('Exactly ten players are required');
  const ordered = [...players].sort((a, b) =>
    JSON.parse(a.preferred_positions).length - JSON.parse(b.preferred_positions).length ||
    (a.queue_order ?? a.joined_at) - (b.queue_order ?? b.joined_at));
  const pairs = Array.from({ length: 5 }, () => []);
  const total = players.reduce((sum, p) => sum + p.mmr, 0);
  let best = null;
  const assign = index => {
    if (index === ordered.length) {
      for (let mask = 0; mask < 32; mask++) {
        const radiantMMR = pairs.reduce((sum, pair, i) => sum + pair[(mask >> i) & 1].mmr, 0);
        const gap = Math.abs(total - 2 * radiantMMR);
        if (!best || gap < best.gap) {
          const radiant = new Set(pairs.map((pair, i) => pair[(mask >> i) & 1].discord_id));
          best = { gap, radiant, positions: new Map(pairs.flatMap((pair, i) => pair.map(p => [p.discord_id, i + 1]))) };
        }
      }
      return;
    }
    const player = ordered[index];
    for (const position of JSON.parse(player.preferred_positions)) {
      if (!POSITIONS.includes(position) || pairs[position - 1].length === 2) continue;
      pairs[position - 1].push(player);
      assign(index + 1);
      pairs[position - 1].pop();
    }
  };
  assign(0);
  if (!best) throw new Error('Selected players cannot fill two teams of positions 1–5');
  return players.map(p => ({ ...p, team: best.radiant.has(p.discord_id) ? 'radiant' : 'dire', position: best.positions.get(p.discord_id) }));
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
