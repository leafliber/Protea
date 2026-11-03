import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import { EVENT_INPUT_SCHEMA } from '@protea/protocol';

// ajv and ajv-formats are CommonJS with a `default` export.
const Ajv = AjvModule.default;
const addFormats = addFormatsModule.default;

export function createAjv(): InstanceType<typeof Ajv> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

const ajv = createAjv();
const validateInput = ajv.compile(EVENT_INPUT_SCHEMA);

export function validateEventInput(input: unknown): { ok: true } | { ok: false; errors: string[] } {
  if (validateInput(input)) return { ok: true };
  const errors = (validateInput.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
  return { ok: false, errors };
}
