import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '1.0.0';
export const CACHE_DIR = join(homedir(), '.cache', 'chaipi');
export const DEFAULT_PROFILE_DIR = join(CACHE_DIR, 'profile');
export const SOCKET_PATH = join(CACHE_DIR, 'chaipi.sock');
export const PID_PATH = join(CACHE_DIR, 'chaipi.pid');
export const DAEMON_LOG_PATH = join(CACHE_DIR, 'daemon.log');
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 Minuten Inaktivitäts-Timeout
export const DEFAULT_HTTP_PORT = 8380;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
