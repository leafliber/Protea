import { runPlugin } from '@protea/plugin-sdk';
import { createTelegramPlugin } from './plugin.js';

runPlugin(createTelegramPlugin());
