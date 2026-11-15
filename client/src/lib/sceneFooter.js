import { useSyncExternalStore } from 'react';
import { useIsDesktop, useIsLandscape } from './useMediaQuery.js';

// **Portrait mode on a phone (decided).** The Scene tab used to ask a phone
// held upright to rotate. Now it gets its own layout: the stage on top
// (Scene and Simple Combat fitted to the screen's width, the Combat map
// filling the space) and every button in one footer below it, so nothing
// floats over the board. Desktop and landscape phones are unchanged.
export const usePortraitPhone = () => {
  const isDesktop = useIsDesktop();
  const isLandscape = useIsLandscape();
  return !isDesktop && !isLandscape;
};

// The footer's height (its buttons; the safe area comes on top). Popups that
// sit at the bottom of the screen (Interrupts, the chat cards) stay above it
// through the `--scene-footer-h` CSS variable, which is 0 everywhere else.
export const FOOTER_REM = 3.5;

// **Buttons that moved into the footer talk to their owners through here**,
// so SceneChat and GM Tools keep their own state and only lose their
// floating buttons in portrait.
function channel(initial) {
  let state = initial;
  const subs = new Set();
  const handlers = new Set();
  return {
    get: () => state,
    set: (next) => {
      state = { ...state, ...next };
      subs.forEach((fn) => fn());
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    // The owner registers what a footer tap does.
    handle: (fn) => {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    trigger: () => handlers.forEach((fn) => fn()),
  };
}

export const sceneChat = channel({ open: false, unread: false });
export const gmTools = channel({ open: false });

export const useChannel = (ch) => useSyncExternalStore(ch.subscribe, ch.get, ch.get);
