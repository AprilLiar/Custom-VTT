import { io } from 'socket.io-client';

// Same origin in production (Express serves the build); the Vite dev server
// proxies /socket.io to the backend, so no URL is needed in either case.
export const socket = io();
