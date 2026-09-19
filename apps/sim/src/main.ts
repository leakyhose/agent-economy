// Entry point. Starts the control server and nothing else: no world is loaded
// and no tick runs until the dashboard asks for one.
import { CFG } from './config.ts';
import { startServer } from './server.ts';

startServer(CFG.PORT);
