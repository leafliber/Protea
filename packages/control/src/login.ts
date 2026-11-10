import type { PluginLoginStatus, PluginLoginView } from '@protea/protocol';
import qrcode from 'qrcode-generator';

/**
 * What the console and the CLI show for a sign-in. The QR code is drawn here, from the text the
 * plugin gave, so a plugin never supplies markup and the link never goes to a QR-rendering service.
 */
export function loginView(status: PluginLoginStatus): PluginLoginView {
  const { qr, ...rest } = status;
  if (!qr) return rest;
  const code = qrcode(0, 'M');
  code.addData(qr);
  code.make();
  return { ...rest, qr: { text: qr, svg: code.createSvgTag({ cellSize: 6, margin: 12, scalable: true }), terminal: code.createASCII(1, 2) } };
}
