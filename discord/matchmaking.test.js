import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPlayers, balanceTeams } from './matchmaking.js';

const players = Array.from({ length: 12 }, (_, i) => ({ discord_id: String(i).padStart(2, '0'), joined_at: i, mmr: 1000 + i * 100, role_ids: '[]' }));
test('FIFO keeps queue order', () => assert.deepEqual(selectPlayers(players, 'fifo').map(p => p.discord_id), players.slice(0, 10).map(p => p.discord_id)));
test('FIFO uses insertion order when timestamps tie', () => {
  const sameTime = players.map((p, i) => ({ ...p, joined_at: 100, queue_order: i + 1 }));
  assert.deepEqual(selectPlayers(sameTime.reverse(), 'fifo').map(p => p.discord_id), players.slice(0, 10).map(p => p.discord_id));
});
test('role priority selects eligible role first', () => {
  const input = players.map((p, i) => ({ ...p, role_ids: JSON.stringify(i === 11 ? ['vip'] : []) }));
  assert.equal(selectPlayers(input, 'role', ['vip'])[0].discord_id, '11');
});
test('MMR selection favors the tightest band', () => {
  const input = players.map((p, i) => ({ ...p, mmr: i === 0 ? 100 : 2000 + i }));
  assert.equal(selectPlayers(input, 'mmr', [], 30, 10_000)[0].discord_id, '01');
});
test('MMR wait limit brings oldest player back', () => assert.equal(selectPlayers(players, 'mmr', [], 30, 2_000_000)[0].discord_id, '00'));
test('teams have five players and minimum possible gap', () => {
  const teams = balanceTeams(players.slice(0, 10));
  assert.equal(teams.filter(p => p.team === 'radiant').length, 5);
  assert.equal(teams.filter(p => p.team === 'dire').length, 5);
  const sums = ['radiant', 'dire'].map(team => teams.filter(p => p.team === team).reduce((n, p) => n + p.mmr, 0));
  assert.equal(Math.abs(sums[0] - sums[1]), 100);
});
