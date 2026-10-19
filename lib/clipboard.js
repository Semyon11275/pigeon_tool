'use strict';
// Electron 44 clipboard reads are asynchronous; read a single coherent snapshot.
async function readClipboard(clipboard, nativeImage) {
  let image = nativeImage.createEmpty(), text = '', html = '';
  const entries = await clipboard.read();
  for (const entry of entries) {
    for (const type of entry.types) {
      if (type === 'text/plain') text = await (await entry.getType(type)).text();
      else if (type === 'text/html') html = await (await entry.getType(type)).text();
      else if (type.startsWith('image/') && image.isEmpty()) {
        const blob = await entry.getType(type);
        image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      }
    }
  }
  return {image, text, html};
}
module.exports = {readClipboard};
