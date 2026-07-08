import { PROVIDER_LABELS } from '../../api';
import type { MusicProvider, UnifiedSourceInfo } from '../../api';

/** Short platform label for the compact chips. */
function providerShort(p: MusicProvider): string {
  switch (p) {
    case 'qq':
      return 'QQ';
    case 'netease':
      return '网易';
    case 'deezer':
      return 'DZ';
    case 'spotify':
      return 'SP';
  }
}

/** Platform chip — marks which platforms a unified search result exists on.
 *  The bestSource platform gets its brand colour + ★; no-copyright ones are
 *  greyed with a strikethrough. */
export default function SourceChip({
  source,
  isBest,
}: {
  source: UnifiedSourceInfo;
  isBest: boolean;
}) {
  return (
    <span
      className={`source-chip source-chip--${source.platform}${
        source.hasCopyright ? '' : ' source-chip--no-rights'
      }${isBest ? ' source-chip--best' : ''}`}
      title={
        source.hasCopyright
          ? `${PROVIDER_LABELS[source.platform]} · 有版权${isBest ? ' · 推荐' : ''}`
          : `${PROVIDER_LABELS[source.platform]} · 无版权`
      }
    >
      {providerShort(source.platform)}
      {isBest && <span className="source-chip-best">★</span>}
    </span>
  );
}
