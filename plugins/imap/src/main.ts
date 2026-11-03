import { runPlugin } from '@protea/plugin-sdk';
import { createImapPlugin } from './plugin.js';

runPlugin(createImapPlugin());
