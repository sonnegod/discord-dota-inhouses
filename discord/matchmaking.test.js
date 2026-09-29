import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPlayers, balanceTeams, balanceRoleTeams, closestCaptains } from './matchmaking.js';

const players = Array.from({ length: 12 }, (_, i) => ({ discord_id: String(i).padStart(2, '0'), joined_at: i, mmr: 1000 + i * 100, preferred_positions: '[]' }));
test('FIFO keeps queue order', () => assert.deepEqual(selectPlayers(players, 'fifo').map(p => p.discord_id), players.slice(0, 10).map(p => p.discord_id)));
test('FIFO uses insertion order when timestamps tie', () => {
  const sameTime = players.map((p, i) => ({ ...p, joined_at: 100, queue_order: i + 1 }));
  assert.deepEqual(selectPlayers(sameTime.reverse(), 'fifo').map(p => p.discord_id), players.slice(0, 10).map(p => p.discord_id));
});
test('role queue waits for two complete position lineups and keeps flexible older players', () => {
  const positions = [1, 1, 2, 3, 3, 4, 4, 5, 1, 5];
  const input = players.map((p, i) => ({ ...p, preferred_positions: JSON.stringify(i === 0 ? [1, 2] : positions[i - 1] ? [positions[i - 1]] : []) }));
  assert.equal(selectPlayers(input.slice(0, 10), 'role'), null);
  const selected = selectPlayers(input.slice(0, 11), 'role');
  assert.equal(selected.length, 10);
  assert.ok(selected.some(p => p.discord_id === '00'));
  assert.ok(!selected.some(p => p.discord_id === '09'));
  const teams = balanceRoleTeams(selected);
  for (const team of ['radiant', 'dire'])
    assert.deepEqual(teams.filter(p => p.team === team).map(p => p.position).sort(), [1, 2, 3, 4, 5]);
});
test('role teams balance MMR across valid positions', () => {
  const input = Array.from({ length: 10 }, (_, i) => ({ ...players[i], preferred_positions: JSON.stringify([Math.floor(i / 2) + 1]), mmr: i % 2 ? 4000 : 2000 }));
  const teams = balanceRoleTeams(input);
  const sums = ['radiant', 'dire'].map(team => teams.filter(p => p.team === team).reduce((sum, p) => sum + p.mmr, 0));
  assert.equal(Math.abs(sums[0] - sums[1]), 2000);
});
test('role teams search flexible positions for the smallest possible MMR gap', () => {
  const mmrs = [1000, 1000, 1000, 1000, 2000, 2000, 2000, 2000, 3000, 3000];
  const input = players.slice(0, 10).map((p, i) => ({ ...p, mmr: mmrs[i], preferred_positions: '[1,2,3,4,5]' }));
  const teams = balanceRoleTeams(input);
  for (const team of ['radiant', 'dire'])
    assert.deepEqual(teams.filter(p => p.team === team).map(p => p.position).sort(), [1, 2, 3, 4, 5]);
  const sums = ['radiant', 'dire'].map(team => teams.filter(p => p.team === team).reduce((sum, p) => sum + p.mmr, 0));
  assert.equal(sums[0], sums[1]);
});
test('captain mode takes the first ten and chooses the closest MMR pair in that group', () => {
  const mmrs = [1000, 5000, 4000, 3000, 3001, 7000, 8000, 9000, 10000, 11000, 3000];
  const input = players.map((p, i) => ({ ...p, mmr: mmrs[i] }));
  const selected = selectPlayers(input, 'captain');
  assert.deepEqual(selected.map(p => p.discord_id), players.slice(0, 10).map(p => p.discord_id));
  assert.deepEqual(closestCaptains(selected).map(p => p.discord_id), ['03', '04']);
});
test('teams have five players and minimum possible gap', () => {
  const teams = balanceTeams(players.slice(0, 10));
  assert.equal(teams.filter(p => p.team === 'radiant').length, 5);
  assert.equal(teams.filter(p => p.team === 'dire').length, 5);
  const sums = ['radiant', 'dire'].map(team => teams.filter(p => p.team === team).reduce((n, p) => n + p.mmr, 0));
  assert.equal(Math.abs(sums[0] - sums[1]), 100);
});
