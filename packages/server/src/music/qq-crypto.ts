import { createHash, createCipheriv, randomBytes } from 'crypto';

/**
 * QQ 音乐 web 端「写操作」用的加密+签名通道（"ag-1"）。
 *
 * 背景（2026-07 实测）：读接口（搜索 / GetVkey / getmyfav）容忍 g_tk=5381 明文，
 * 但**写操作**（收藏歌曲到「我喜欢」）必须走 `u6.y.qq.com/cgi-bin/musics.fcg`
 * 的加密通道——请求体 AES-128-GCM 加密、URL 带 zzcSign 签名、响应循环 XOR。
 * 明文 musicu.fcg 会返回 code 500026（拒绝）。
 *
 * ⚠️ 这些 key / zzcSign 索引是从 QQ 音乐 web 客户端逆向来的（同 GetVkey 一样
 * 属于社区逆向，无官方文档），QQ 改版时可能失效——失效表现为写接口报错，
 * 到时主要看这里的常量。参考实现：tlyanyu/multiPlatformMusicApi。
 */

// ag-1 请求加密 key（AES-128-GCM，16B）
const REQUEST_KEY = Buffer.from('bd305f10d0ff74b6ef54dab835b5e1cf', 'hex');
// ag-1 响应解密 key（循环 XOR，21B）
const RESPONSE_KEY = Buffer.from(
  '7a3f8c1d5e9b2f0a6c4d7e8b1f3a5c9d0e2b6f4a81',
  'hex',
);
const IV_LEN = 12;
const TAG_LEN = 16;

function xorCycle(data: Buffer, key: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ key[i % key.length];
  }
  return out;
}

/**
 * 请求体加密：明文对象 → JSON → AES-128-GCM → base64([12B IV][CT][16B TAG])。
 */
export function encryptRequest(payload: unknown): string {
  const iv = randomBytes(IV_LEN);
  const pt = Buffer.from(JSON.stringify(payload), 'utf8');
  const cipher = createCipheriv('aes-128-gcm', REQUEST_KEY, iv, {
    authTagLength: TAG_LEN,
  });
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

/** 响应解密：二进制响应体（循环 XOR）→ UTF-8 明文。 */
export function decryptResponse(input: Buffer): string {
  return xorCycle(input, RESPONSE_KEY).toString('utf8');
}

/**
 * zzcSign 签名：对请求 JSON 做 SHA1 → 固定索引取字符拼 part1/part2 →
 * 混淆数组与 hash 字节 XOR → base64 去特殊字符 → 组装 'zzc'+part1+mid+part2。
 */
export function zzcSign(payload: string): string {
  const hash = createHash('sha1').update(payload).digest('hex').toUpperCase();

  const part1Indexes = [23, 14, 6, 36, 16, 40, 7, 19];
  let part1 = '';
  for (const i of part1Indexes) if (i < 40) part1 += hash[i];

  const part2Indexes = [16, 1, 32, 12, 19, 27, 8, 5];
  let part2 = '';
  for (const i of part2Indexes) part2 += hash[i];

  const scramble = [
    89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133,
    143, 161, 121, 179,
  ];
  const part3 = new Uint8Array(scramble.length);
  for (let i = 0; i < scramble.length; i++) {
    const hv = parseInt(hash.slice(i * 2, i * 2 + 2), 16);
    part3[i] = scramble[i] ^ hv;
  }
  const midPart = Buffer.from(part3)
    .toString('base64')
    .replace(/[/+=]/g, '');

  return ('zzc' + part1 + midPart + part2).toLowerCase();
}
