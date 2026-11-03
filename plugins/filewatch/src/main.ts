import { runPlugin } from '@protea/plugin-sdk';
import { createFilewatchPlugin } from './plugin.js';

runPlugin(createFilewatchPlugin());
