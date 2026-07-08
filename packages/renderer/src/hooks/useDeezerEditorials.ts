import { useEffect, useState } from 'react';
import { fetchDeezerEditorials } from '../api';
import type { DeezerEditorial } from '../api';

/** Fetch the list of available Deezer editorials once on mount. */
export function useDeezerEditorials() {
  const [editorials, setEditorials] = useState<DeezerEditorial[]>([]);
  useEffect(() => {
    fetchDeezerEditorials()
      .then(setEditorials)
      .catch(() => setEditorials([]));
  }, []);
  return editorials;
}
