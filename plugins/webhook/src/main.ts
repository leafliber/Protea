import { runPlugin } from '@protea/plugin-sdk';
import { createWebhookPlugin } from './plugin.js';

runPlugin(createWebhookPlugin());
