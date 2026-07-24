// Display helpers for Perk automation chips. Extensible list — a new
// automation type needs an entry here (label/summary) plus a case in the
// PerkCreator's sub-form and the server's perkAutomations.js/index.js.
export const AUTOMATION_TYPE_LABELS = {
  die_step: 'Step a Die',
  stamina_multiplier: 'Stamina Multiplier',
  move_tag: 'Move Tag',
  move_frame_override: 'Move Frame Data',
  move_roll_bonus: 'Move Roll Bonus',
};

// moveById/tagById are Maps for resolving referenced ids to names.
export function automationSummary(type, payload, { moveById, tagById } = {}) {
  switch (type) {
    case 'die_step': {
      const dir = payload.steps > 0 ? '+' : '';
      const scope = payload.scope === 'current' ? ' (current only)' : ' (permanent)';
      return `${payload.slotName} ${dir}${payload.steps} step${Math.abs(payload.steps) === 1 ? '' : 's'}${scope}`;
    }
    case 'stamina_multiplier':
      return `Stamina Multiplier ${payload.delta > 0 ? '+' : ''}${payload.delta}`;
    case 'move_tag': {
      const moveName = moveById?.get(payload.moveId)?.name ?? `#${payload.moveId}`;
      const tagName = tagById?.get(payload.tagId)?.name ?? `#${payload.tagId}`;
      return `${payload.action === 'add' ? 'Add' : 'Remove'} tag "${tagName}" on ${moveName}`;
    }
    case 'move_frame_override': {
      const moveName = moveById?.get(payload.moveId)?.name ?? `#${payload.moveId}`;
      const parts = [];
      if (payload.startupDelta) parts.push(`Startup ${payload.startupDelta > 0 ? '+' : ''}${payload.startupDelta}`);
      if (payload.activeDelta) parts.push(`Active ${payload.activeDelta > 0 ? '+' : ''}${payload.activeDelta}`);
      if (payload.recoveryDelta) parts.push(`Recovery ${payload.recoveryDelta > 0 ? '+' : ''}${payload.recoveryDelta}`);
      return `${moveName}: ${parts.join(', ')}`;
    }
    case 'move_roll_bonus': {
      const moveName = moveById?.get(payload.moveId)?.name ?? `#${payload.moveId}`;
      return `${payload.amount > 0 ? '+' : ''}${payload.amount} on rolls with ${moveName}`;
    }
    default:
      return type;
  }
}
