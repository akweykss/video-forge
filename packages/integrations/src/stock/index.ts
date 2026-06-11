// ============================================================
// Re-exportação dos clientes de stock
// ============================================================
export {
  searchVideos as searchPexelsVideos,
  searchPhotos as searchPexelsPhotos,
  downloadPexelsAsset,
  type StockVideo,
  type StockPhoto,
} from './pexels';

export {
  searchVideos as searchPixabayVideos,
  searchPhotos as searchPixabayPhotos,
  searchMusic as searchPixabayMusic,
  downloadPixabayAsset,
  type PixabayStockVideo,
  type PixabayStockPhoto,
  type MusicTrack,
} from './pixabay';

export {
  findBRoll,
  findImage,
  type UnifiedStockVideo,
  type UnifiedStockPhoto,
} from './unified';

export {
  searchGoogleImages,
  downloadWebImage,
  type WebImage,
} from './google-images';

export {
  searchSerpImages,
  downloadSerpImage,
  searchSerpVideos,
  type SerpImage,
  type SerpVideo,
} from './serpapi';

export {
  smartImageSearch,
} from './smart-search';

export {
  searchTMDB,
  getTMDBBackdrops,
  getTMDBStills,
  getTMDBCast,
  downloadTMDBImage,
  findTMDBImages,
  type TMDBResult,
  type TMDBImage,
  type TMDBCastMember,
} from './tmdb';
