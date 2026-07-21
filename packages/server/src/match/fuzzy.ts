/**
 * Jaro-Winkler string similarity, normalized to [0, 1].
 *   1.0 = identical, 0.0 = completely different.
 *
 * 算法分两步：
 *   1. **Jaro 距离**：基于字符匹配 + 字符位置不变的字符比例。两个字符串
 *      \`matchDistance\` 半径内的相同字符算"匹配"（超出半径的不算）；转
 *      置（matched 但位置错）再扣分。
 *   2. **Winkler 调整**：对常见前缀最多加 0.1 * (1 - jaro)。Winkler 强化
 *      "前缀对齐 → 更可能同源" 的假设，适合处理标题拼写错误（错字多半
 *      在尾部）。
 *
 * 用途：跨平台匹配阶段 C 的 fuzzy 兜底——strict normalizeKey 没命中时，
 * 用 Jaro-Winkler 给 normalized key 之间的相似度打分。**阈值**由调用方
 * 控制（match.service.ts 的 \`FUZZY_THRESHOLD\`），默认 0.88。
 *
 * 实现细节：
 *   - 不依赖外部库（避免打包变重）；
 *   - 用 `string[i]` 取 UTF-16 code unit，对 BMP（含中、日、韩）字符串
 *     足够正确；少见增补平面的字不在匹配范围（不影响实际歌名）；
 *   - 短字符串（<3 字符）结果不可靠，不在算法内做特殊处理，留给调用方
 *     阈值兜底。
 */
export function jaroWinkler(s1: string, s2: string): number {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;

  const len1 = s1.length;
  const len2 = s2.length;
  const matchDistance = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const s2Matched = new Array<boolean>(len2).fill(false);
  const s1Matched = new Array<boolean>(len1).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matched[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matched[i] = true;
      s2Matched[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // transpositions: matching pairs that are in different positions.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matched[i]) continue;
    while (!s2Matched[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / len1 +
      matches / len2 +
      (matches - transpositions / 2) / matches) /
    3;

  // Winkler 调整：仅在 jaro 已经高（>= 0.7）时才有意义——差距太大就
  // 没有"前缀对齐"可加。
  if (jaro < 0.7) return jaro;

  let prefix = 0;
  const maxPrefix = Math.min(4, len1, len2);
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}
