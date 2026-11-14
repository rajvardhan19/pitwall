// Where the game is served from: "/" locally, "/F1RaceEngineer/" on GitHub Pages.
// Vite fills this in at build time; plain Node (the tests) falls back to "/".
export const BASE: string = import.meta.env?.BASE_URL ?? '/';
