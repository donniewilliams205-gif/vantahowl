'use strict';
/*
 * Trivia Nights — built-in gaming trivia bank.
 * Each question lists every acceptable answer; matching is forgiving
 * (case/punctuation/leading "the" insensitive) via normalize().
 */

const QUESTIONS = [
  { q: 'What year was the first Super Mario Bros. released?', answers: ['1985'] },
  { q: 'Which company makes the PlayStation?', answers: ['Sony'] },
  { q: 'What is the name of the hero in The Legend of Zelda?', answers: ['Link'] },
  { q: 'In Minecraft, what green exploding mob sneaks up on players?', answers: ['Creeper'] },
  { q: "What does 'FPS' stand for in gaming?", answers: ['First person shooter'] },
  { q: "Which Pokémon is Ash's partner and #25 in the Pokédex?", answers: ['Pikachu'] },
  { q: 'In Fortnite, what vehicle drops players onto the island at the start?', answers: ['Battle Bus'] },
  { q: 'What is the currency called in Roblox?', answers: ['Robux'] },
  { q: 'Which game is set in the city of Los Santos?', answers: ['GTA V', 'Grand Theft Auto V', 'GTA 5', 'Grand Theft Auto 5'] },
  { q: 'What is the best-selling video game of all time?', answers: ['Minecraft'] },
  { q: 'In Among Us, what do you call the hidden traitor?', answers: ['Impostor', 'Imposter'] },
  { q: 'Which Nintendo console introduced motion controls with a remote?', answers: ['Wii', 'Nintendo Wii'] },
  { q: "What does 'GG' stand for?", answers: ['Good game'] },
  { q: "What is the name of Sonic's two-tailed sidekick?", answers: ['Tails', 'Miles Prower', 'Miles Tails Prower'] },
  { q: 'In The Sims, what is the in-game currency called?', answers: ['Simoleons'] },
  { q: 'Which studio created The Witcher 3: Wild Hunt?', answers: ['CD Projekt Red', 'CD Projekt'] },
  { q: 'What color is Pac-Man?', answers: ['Yellow'] },
  { q: 'What handheld console did Nintendo release in 1989?', answers: ['Game Boy', 'Gameboy'] },
  { q: 'In Halo, what is the real name the Chief is called by Cortana?', answers: ['John', 'John-117', 'John 117'] },
  { q: 'Which game popularized the phrase "The cake is a lie"?', answers: ['Portal'] },
];

/** Forgiving answer comparison key: lowercase, no punctuation, no leading "the". */
function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

function isCorrect(question, text) {
  const n = normalize(text);
  if (!n) return false;
  return question.answers.some((a) => normalize(a) === n);
}

/** Pick n random questions without repeats. */
function pickQuestions(n) {
  const pool = QUESTIONS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(1, Math.min(n, pool.length)));
}

module.exports = { QUESTIONS, normalize, isCorrect, pickQuestions };
