import { readFileSync } from 'node:fs';
import { PMTiles, tileIdToZxy } from 'pmtiles';
const buf = readFileSync('apps/web/public/basemap/firepulse.pmtiles');
const source = {
  getKey: () => 'x',
  async getBytes(o, l) { const s = buf.subarray(o, o + l); return { data: s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) }; },
};
const pm = new PMTiles(source);
const h = await pm.getHeader();
console.log('header', h.minZoom, h.maxZoom, h.numTileEntries, 'root', h.rootDirectoryOffset, h.rootDirectoryLength, 'tiles', h.tileDataOffset, h.tileDataLength);
let ok = 0, empty = 0;
for (let z = 4; z <= 6; z++) {
  let zok = 0;
  const n = 2 ** z;
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
    const t = await pm.getZxy(z, x, y);
    if (t && t.data.byteLength > 0) { zok++; }
    else if (t) empty++;
  }
  console.log('z', z, 'tiles', zok);
  ok += zok;
}
console.log('total nonempty', ok, 'empty', empty);
// sample a tile far east
for (const [z,x,y] of [[5,4,12],[5,5,12],[5,6,12],[5,7,12],[6,20,24]]) {
  const t = await pm.getZxy(z,x,y);
  console.log('sample', z,x,y, t ? t.data.byteLength : 'MISSING');
}
