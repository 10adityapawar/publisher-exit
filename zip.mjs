import { once } from 'node:events';
const table = Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
// Stored ZIP entries: no dependencies, one source PDF in memory at a time.
export async function streamZip(res, entries){
  let offset=0;const directory=[];
  async function send(b){if(!res.write(b))await once(res,'drain');offset+=b.length;}
  for(const entry of entries){
    const name=Buffer.from(entry.name),bytes=entry.read(),crc=crc32(bytes),start=offset;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
    await send(local);await send(name);await send(bytes);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt32LE(crc,16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(start,42);directory.push(central,name);
  }
  const centralStart=offset;for(const chunk of directory)await send(chunk);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(offset-centralStart,12);end.writeUInt32LE(centralStart,16);res.end(end);
}
