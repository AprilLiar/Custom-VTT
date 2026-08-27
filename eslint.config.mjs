import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

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
  // **`no-use-before-define`: tried, and deliberately not enabled.** A `const`
  // read before its declaration IS a real runtime error — a hook dependency
  // array naming a `const` declared further down a component threw a
  // temporal-dead-zone ReferenceError and took a whole tab down, the third
  // runtime-only error this project has shipped past lint. So the rule was
  // worth trying.
  //
  // It does not earn its place. Turned on (`variables: true, functions: false`)
  // it flags 18 sites across working code, and every one is the SAFE shape: a
  // module-level `let` or a `const` arrow read from inside a function body that
  // nothing calls until after the module has finished initialising. The rule
  // cannot tell that apart from a reference evaluated during initialisation,
  // which is the only case that throws — so the choice is 18 suppressions in
  // code that is fine, and that is exactly the sweep this gate exists not to
  // demand. Recorded here so the next person with this idea can skip the
  // experiment.
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
  {
    // **The client is linted now too (decided, revised).** It was left out as
    // "worth doing, not worth bundling into a hotfix" — and then the very next
    // change shipped `useMemo is not defined` in CombatArena, the same class of
    // bug, caught only because a browser pass happened to open that panel.
    // `npm run build` does not catch it: Vite parses the file fine, and an
    // undefined identifier is a runtime error, not a syntax one.
    //
    // `react-hooks` is loaded for one reason only: several components carry
    // `eslint-disable-next-line react-hooks/exhaustive-deps`, and ESLint 9
    // errors on a directive naming a rule it has not loaded. The rules stay
    // off — this is a correctness gate, and the exhaustive-deps sweep those
    // comments represent is a separate piece of work.
    files: ['client/src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    // The `exhaustive-deps` directives below are load-bearing documentation of
    // deliberate choices, and they become live again the day that rule is
    // turned on. Reporting them as "unused" because this config switches the
    // rule off would be the lint complaining about its own configuration.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...correctness,
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/rules-of-hooks': 'off',
    },
  },
];
