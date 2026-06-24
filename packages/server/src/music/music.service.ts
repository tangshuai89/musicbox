import { Injectable } from '@nestjs/common';

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  audioUrl: string;
  duration: number; // seconds
  liked: boolean;
}

/**
 * In production, this service would call QQ Music APIs:
 * - GET /radio/songs — fetch radio playlist
 * - POST /song/like — like a song
 *
 * For demo purposes we use a curated list of royalty-free tracks
 * from the public domain.
 */
@Injectable()
export class MusicService {
  private readonly demoTracks: Track[] = [
    {
      id: '1',
      title: 'Clair de Lune',
      artist: 'Claude Debussy',
      album: 'Suite bergamasque',
      coverUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/Claude_Debussy_ca_1908%2C_foto_av_F%C3%A9lix_Nadar.jpg/440px-Claude_Debussy_ca_1908%2C_foto_av_F%C3%A9lix_Nadar.jpg',
      audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/7/75/Clair_de_lune_%28Debussy%29.ogg',
      duration: 302,
      liked: false,
    },
    {
      id: '2',
      title: 'Gymnop\u00e9die No. 1',
      artist: 'Erik Satie',
      album: 'Trois Gymnop\u00e9dies',
      coverUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Erik_Satie_en_1909.jpg/440px-Erik_Satie_en_1909.jpg',
      audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/e/ee/Erik_Satie_-_gymnop%C3%A9die_no.1.ogg',
      duration: 190,
      liked: false,
    },
    {
      id: '3',
      title: 'Nocturne Op. 9 No. 2',
      artist: 'Fr\u00e9d\u00e9ric Chopin',
      album: 'Nocturnes',
      coverUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/Frederic_Chopin_photo.jpeg/440px-Frederic_Chopin_photo.jpeg',
      audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/e/e3/Frederic_Chopin_-_nocturne_op._9_no._2.ogg',
      duration: 271,
      liked: false,
    },
    {
      id: '4',
      title: 'Arabesque No. 1',
      artist: 'Claude Debussy',
      album: 'Deux Arabesques',
      coverUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/Claude_Debussy_ca_1908%2C_foto_av_F%C3%A9lix_Nadar.jpg/440px-Claude_Debussy_ca_1908%2C_foto_av_F%C3%A9lix_Nadar.jpg',
      audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/4/49/Claude_Debussy_-_Arabesque_No._1.ogg',
      duration: 256,
      liked: false,
    },
    {
      id: '5',
      title: 'Moonlight Sonata',
      artist: 'Ludwig van Beethoven',
      album: 'Piano Sonata No. 14',
      coverUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/Beethoven.jpg/440px-Beethoven.jpg',
      audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/3/32/Ludwig_van_Beethoven_-_Moonlight_Sonata.ogg',
      duration: 360,
      liked: false,
    },
    {
      id: '6',
      title: 'Rêverie',
      artist: 'Claude Debussy',
      album: 'Rêverie',
      coverUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/Claude_Debussy_ca_1908%2C_foto_av_F%C3%A9lix_Nadar.jpg/440px-Claude_Debussy_ca_1908%2C_foto_av_F%C3%A9lix_Nadar.jpg',
      audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/0/09/Debussy_-_R%C3%AAverie.ogg',
      duration: 240,
      liked: false,
    },
  ];

  private likedTrackIds = new Set<string>();
  private playHistory: string[] = [];

  getNextTrack(): Track {
    // Radio-style: pick a random track, avoid repeating the last played
    const lastPlayed = this.playHistory[this.playHistory.length - 1];
    let candidates = this.demoTracks.filter((t) => t.id !== lastPlayed);
    if (candidates.length === 0) {
      candidates = this.demoTracks;
    }
    const track = candidates[Math.floor(Math.random() * candidates.length)];
    this.playHistory.push(track.id);
    if (this.playHistory.length > 50) {
      this.playHistory = this.playHistory.slice(-20);
    }
    return { ...track, liked: this.likedTrackIds.has(track.id) };
  }

  likeTrack(trackId: string): { success: boolean; liked: boolean } {
    if (this.likedTrackIds.has(trackId)) {
      this.likedTrackIds.delete(trackId);
      return { success: true, liked: false };
    }
    this.likedTrackIds.add(trackId);
    return { success: true, liked: true };
  }

  getLikedTracks(): Track[] {
    return this.demoTracks
      .filter((t) => this.likedTrackIds.has(t.id))
      .map((t) => ({ ...t, liked: true }));
  }
}
