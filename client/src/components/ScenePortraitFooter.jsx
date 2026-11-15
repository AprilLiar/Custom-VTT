import { Link } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, MessageCircle, MoreHorizontal, X } from 'lucide-react';
import { ActionButton } from './FightControls.jsx';
import { FOOTER_REM, sceneChat, useChannel } from '../lib/sceneFooter.js';

// **The portrait footer (decided).** Every button of the Scene tab, in one
// bar under the stage, so nothing floats over the board: Back and Hide UI on
// the left, Action and End Turn in the middle (on your turn), Chat and — for
// the GM — More on the right. With the interface hidden only the Hide toggle,
// the Action buttons and Chat stay (as they do in landscape).
const iconButton =
  'relative flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900 text-zinc-300 active:border-brand-500 active:text-brand-300';

export default function ScenePortraitFooter({ role, uiHidden, onToggleUi, fight, fightMode, controls, onOpenMore }) {
  const chat = useChannel(sceneChat);
  return (
    <nav
      aria-label="Scene controls"
      className="relative flex shrink-0 items-center gap-1.5 border-t border-zinc-800 bg-zinc-950 px-2"
      style={{
        // Under every dialog (z-50) and popup, which open over it.
        zIndex: 40,
        height: `calc(${FOOTER_REM}rem + var(--safe-bottom, 0px))`,
        paddingBottom: 'var(--safe-bottom, 0px)',
        paddingLeft: 'calc(0.5rem + var(--safe-left, 0px))',
        paddingRight: 'calc(0.5rem + var(--safe-right, 0px))',
      }}
    >
      {!uiHidden && (
        <Link to="/" title="Back" aria-label="Back" className={iconButton}>
          <ArrowLeft size={18} aria-hidden />
        </Link>
      )}
      <button type="button" onClick={onToggleUi} title={uiHidden ? 'Show interface' : 'Hide interface'} aria-label={uiHidden ? 'Show interface' : 'Hide interface'} className={iconButton}>
        {uiHidden ? <Eye size={18} aria-hidden /> : <EyeOff size={18} aria-hidden />}
      </button>
      <div className="flex min-w-0 flex-1 justify-center">
        {fight && <ActionButton fight={fight} mode={fightMode} controls={controls} inline />}
      </div>
      <button
        type="button"
        onClick={() => sceneChat.trigger()}
        title={chat.open ? 'Close chat' : 'Open chat'}
        aria-label={chat.open ? 'Close chat' : 'Open chat'}
        className={iconButton}
      >
        {chat.open ? <X size={18} aria-hidden /> : <MessageCircle size={18} aria-hidden />}
        {chat.unread && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border border-zinc-900 bg-brand-500" />}
      </button>
      {role === 'gm' && !uiHidden && (
        <button type="button" onClick={onOpenMore} title="More" aria-label="More" className={iconButton}>
          <MoreHorizontal size={18} aria-hidden />
        </button>
      )}
    </nav>
  );
}
