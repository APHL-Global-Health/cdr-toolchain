export class BitConverter {
  GetBytes(value: number): number[] {
    const bytes = new Uint8Array(new Float32Array([value]).buffer);
    return Array.from(bytes);
  }

  ToBitArray(bytes: string): number[] {
    const b: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      b.push(bytes.charCodeAt(i));
    }
    return b;
  }

  ToInt(bytes: string): number {
    const b = this.ToBitArray(bytes);
    const data = new Uint8Array(b);
    const uint = new Uint32Array(data.buffer);
    return uint[0] ?? 0;
  }

  ToSingle(bytes: string): number {
    const b = this.ToBitArray(bytes);
    const buffer = new ArrayBuffer(4);
    const byteArray = new Uint8Array(buffer);
    for (let i = 0; i < 4; i++) {
      byteArray[i] = b[i] ?? 0;
    }
    const floatArray = new Float32Array(buffer);
    return floatArray[0] ?? 0;
  }
}

// https://stackoverflow.com/questions/49951290/javascript-simple-bitconverter
// const converter = new BitConverter();
// converter.ToInt(converter.GetBytes(2851281703)); // 2851281703
