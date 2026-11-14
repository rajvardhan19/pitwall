// The grid: 11 teams and 22 drivers, sized like the 2026 field. Every name, team and livery here
// is fictional on purpose. Rename freely: nothing else in the game hard-codes these names, except
// that Apex (ids 1 and 4) is the player's team, and Theo and Nico are the radio characters.
export interface Team {
  id: string; name: string; color: string;
  /** Car performance in seconds per lap; negative is faster. Used in full races and the season. */
  pace: number;
}
export interface Driver {
  id: number; name: string; code: string; team: string; color: string;
  /** Driver performance in seconds per lap; negative is faster. */
  skill: number;
}

export const TEAMS: Team[] = [
  { id: 'Papaya', name: 'Papaya', color: '#e3aa6d', pace: -0.55 },
  { id: 'Rosso', name: 'Rosso', color: '#ed6d73', pace: -0.5 },
  { id: 'Apex', name: 'Apex', color: '#c4f17b', pace: -0.3 },
  { id: 'Cobalt', name: 'Cobalt', color: '#7997eb', pace: -0.38 },
  { id: 'Silver', name: 'Silver', color: '#a8bdc8', pace: -0.2 },
  { id: 'Verdant', name: 'Verdant', color: '#2fa36b', pace: 0.0 },
  { id: 'Tidewater', name: 'Tidewater', color: '#4cc3d9', pace: 0.15 },
  { id: 'Lumiere', name: 'Lumière', color: '#f08cc0', pace: 0.25 },
  { id: 'Kestrel', name: 'Kestrel', color: '#a07cf5', pace: 0.32 },
  { id: 'Frontier', name: 'Frontier', color: '#f2f2f2', pace: 0.45 },
  { id: 'Meridian', name: 'Meridian', color: '#c9a227', pace: 0.55 },
];

const team = (id: string) => TEAMS.find(t => t.id === id)!;
const driver = (id: number, name: string, code: string, teamId: string, skill: number): Driver =>
  ({ id, name, code, team: team(teamId).name, color: team(teamId).color, skill });

// Ids 0–9 are the original scenario field; keep them stable so authored scenarios replay exactly.
export const ROSTER: Driver[] = [
  driver(0, 'Luca Voss', 'VOS', 'Rosso', -0.15),
  driver(1, 'Theo Laurent', 'LAU', 'Apex', -0.1),
  driver(2, 'Oscar Vega', 'VEG', 'Papaya', -0.1),
  driver(3, 'Max Keller', 'KEL', 'Cobalt', -0.05),
  driver(4, 'Nico Reyes', 'REY', 'Apex', -0.12),
  driver(5, 'Alex Sato', 'SAT', 'Silver', 0),
  driver(6, 'Daniel Costa', 'COS', 'Rosso', 0.05),
  driver(7, 'Elliot Ward', 'WAR', 'Papaya', 0),
  driver(8, 'Gabriel Moreau', 'MOR', 'Cobalt', 0),
  driver(9, 'Finn Rossi', 'ROS', 'Silver', 0.05),
  driver(10, 'Hugo Brandt', 'BRA', 'Verdant', 0.05),
  driver(11, 'Mateo Arriaga', 'ARR', 'Verdant', 0),
  driver(12, 'Julien Faure', 'FAU', 'Lumiere', 0),
  driver(13, 'Kai Watanabe', 'WAT', 'Lumiere', -0.05),
  driver(14, 'Samuel Okafor', 'OKA', 'Tidewater', -0.05),
  driver(15, 'Emil Hartmann', 'HAR', 'Tidewater', 0.05),
  driver(16, 'Ravi Menon', 'MEN', 'Kestrel', 0),
  driver(17, 'Lucas Duarte', 'DUA', 'Kestrel', 0.05),
  driver(18, 'Cole Brennan', 'BRE', 'Frontier', 0.05),
  driver(19, 'Tomasz Wolski', 'WOL', 'Frontier', 0),
  driver(20, 'Aiden Park', 'PAR', 'Meridian', 0.05),
  driver(21, 'Leon Varga', 'VAR', 'Meridian', -0.05),
];

export function teamOf(d: { team: string }) {
  return TEAMS.find(t => t.name === d.team)!;
}
