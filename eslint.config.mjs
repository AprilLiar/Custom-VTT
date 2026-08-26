import js from '@eslint/js';
import globals from 'globals';

// **A linter, finally — and it exists for one specific bug (decided, new).**
//
// `getPairStanceMatchup` referenced a variable that a refactor two phases
// earlier had removed from its scope. The result was `ReferenceError:
// attributes is not defined` inside `GET /api/combat` — but *only* when a
// seated fighter had an active stance, since that is the only path that reaches
// the closure. Every test passed, because the throwaway NPCs the tests create
// never have stances. It shipped, took the Arena down in production, and cost
// four deploys of guesswork to find.
//
// `no-undef` finds it in milliseconds. That is the whole justification for this
// file: a class of bug that unit tests cannot be relied on to reach, because
// reaching it depends on data shape rather than on code paths anyone thought to
// exercise.
//
// Deliberately narrow. This is a correctness gate, not a style gate — there is
// no formatting rule here and no opinion about how anything is written. Rules
// earn their place by catching things that break at runtime; anything that
// would need a sweep through working code to satisfy is turned off rather than
// left to make `npm run lint` noisy enough to ignore.
const correctness = {
  ...js.configs.recommended.rules,
  // Off: this codebase deliberately destructures values it does not use and
  // catches errors it does not inspect. Neither breaks anything, and both would
  // bury the rules that do.
  'no-unused-vars': 'off',
  'no-empty': 'off',
};

export default [
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: correctness,
  },
];

// **The client is deliberately not linted here yet.** Several components carry
// `eslint-disable-next-line react-hooks/exhaustive-deps` comments, and ESLint
// 9 errors on a disable directive naming a rule it has not loaded — so linting
// `client/src` means taking on `eslint-plugin-react-hooks` and the React
// plugin config with it. Worth doing; not worth bundling into a production
// hotfix. The bug this file exists for was server-side, and `npm run build`
// already fails the client on anything Vite cannot parse.
