// React's window onto the audio engine.
//
// The engine is a module singleton outside the component tree (see
// audioEngine.js for why it has to be), so components read it through
// useSyncExternalStore rather than holding the state themselves. Nothing here
// can start, stop or steer playback — that is the GM's socket events — this
// only ever reports what is currently true.
import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from './audioEngine.js';

export const useAudioStatus = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
