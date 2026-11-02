// Icons for the Panic at the Dojo tokens (client only — the catalog itself is
// plain data in panicTokens.js so the server can import it too).
//
// From game-icons.net via react-icons/gi. The icons are CC BY 3.0: the
// credit line below is shown wherever the token icons appear, as the licence
// requires.
import {
  GiCheckedShield,
  GiFist,
  GiSprint,
  GiFlame,
  GiSnail,
  GiBrokenBone,
  GiPuppet,
  GiDevilMask,
  GiClover,
  GiTeacher,
  GiLightBulb,
  GiGhost,
  GiPunchingBag,
  GiLightningSlashes,
  GiCrossedSwords,
} from 'react-icons/gi';

export const TOKEN_ICONS = {
  iron: GiCheckedShield,
  power: GiFist,
  speed: GiSprint,
  burning: GiFlame,
  fatigue: GiSnail,
  weakness: GiBrokenBone,
  challenge: GiCrossedSwords,
  control: GiPuppet,
  chaos: GiDevilMask,
  luck: GiClover,
  mentor: GiTeacher,
  inspired: GiLightBulb,
  poltergeist: GiGhost,
  training: GiPunchingBag,
  rapid_strike: GiLightningSlashes,
};

// Each kind keeps the book's colour coding where it has one (Unique tokens
// share their source's colour: purple Archetype, blue Form, red Style — the
// app cannot know which, so Unique tokens use one violet), and a distinct hue
// for Basic and Status so the row reads at a glance.
export const KIND_CLASS = {
  basic: 'text-sky-300',
  status: 'text-orange-300',
  unique: 'text-violet-300',
  super: 'text-amber-300',
};

export function TokenIcon({ tokenKey, className = '', title }) {
  const Icon = TOKEN_ICONS[tokenKey];
  if (!Icon) return null;
  return <Icon className={className} title={title} aria-hidden={title ? undefined : true} />;
}

export const ICON_CREDIT = 'Token icons by Lorc, Delapouite and contributors — game-icons.net (CC BY 3.0).';
