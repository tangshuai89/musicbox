import type { DeezerEditorial } from '../../api';

interface Props {
  editorials: DeezerEditorial[];
  value: string;
  onChange: (preset: string) => void;
}

/** Map a Deezer editorial's display name to its preset code (the value the
 *  radio endpoint expects). Unknown names fall back to 'all'. */
const PRESET_CODES: Record<string, string> = {
  All: 'all',
  亚洲流行: 'asia',
  国际流行: 'pop',
  说唱: 'rap',
  摇滚: 'rock',
  舞曲: 'dance',
  'R&B': 'rnb',
  古典: 'classical',
  爵士: 'jazz',
};

function presetCode(name: string): string {
  return PRESET_CODES[name] ?? 'all';
}

/** Deezer editorial (chart) picker, shown only for the Deezer source. */
export default function DeezerPresetSelect({ editorials, value, onChange }: Props) {
  return (
    <select
      className="preset-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title="Deezer 榜单"
    >
      {editorials.map((e) => (
        <option key={e.id} value={presetCode(e.name)}>
          {e.name}
          {e.region ? ` · ${e.region}` : ''}
        </option>
      ))}
    </select>
  );
}
