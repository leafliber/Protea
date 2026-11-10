/** Only the official package's OpenClaw gateway integration uses this. */
export async function mutateConfigFile() {
  throw new Error('the OpenClaw configuration is not available in Protea');
}
