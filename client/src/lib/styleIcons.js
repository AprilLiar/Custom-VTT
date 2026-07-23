// Maps the icon names stored in the attributes table to lucide-react
// components (ISC-licensed open-source icon set).
import {
  ArrowLeftRight,
  Crosshair,
  Dumbbell,
  Shield,
  Shuffle,
  Swords,
  Zap,
} from 'lucide-react';

const ICONS = {
  zap: Zap,
  dumbbell: Dumbbell,
  shuffle: Shuffle,
  crosshair: Crosshair,
  'arrow-left-right': ArrowLeftRight,
  shield: Shield,
  swords: Swords,
};

export const iconFor = (name) => ICONS[name] ?? Shield;
