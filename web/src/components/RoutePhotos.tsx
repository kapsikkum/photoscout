import { useEffect, useState } from 'react';
import { api, type Photo, type Route, type RoutePhoto } from '../api.js';
import { prepareUpload } from '../photos.js';
import { Lightbox } from './Photos.js';

/** Route gallery. The server keeps the images behind the route's visibility. */
export default function RoutePhotos({ route, canEdit }: { route: Route; canEdit: boolean }) {
  const [photos, setPhotos] = useState<RoutePhoto[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = () => api.routePhotos(route.id).then(setPhotos).catch(() => setPhotos([]));
  useEffect(() => { void load(); }, [route.id]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy('Uploading…');
    setError('');
    try {
      for (const file of files) {
        const prepared = await prepareUpload(file);
        await api.uploadRoutePhoto(route.id, prepared.photo, prepared.thumb, { w: prepared.w, h: prepared.h });
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="photos route-photos">
      <h3>Route photos</h3>
      {photos.length === 0 && <p className="hint">No photos yet.</p>}
      <div className="photos__grid">
        {photos.map((photo, index) => (
          <figure key={photo.id} className="photos__item">
            <img src={photo.thumbUrl} alt={photo.caption || 'Route photo'} loading="lazy" onClick={() => setOpen(index)} />
            {photo.caption && <figcaption>{photo.caption}</figcaption>}
            {canEdit && <button className="photos__remove" title="Delete photo" onClick={async () => {
              if (!confirm('Delete this photo?')) return;
              await api.deleteRoutePhoto(photo.id);
              void load();
            }}>✕</button>}
          </figure>
        ))}
      </div>
      {canEdit && <div className="photos__upload">
        <label className="buttonlike">{busy || 'Upload photos'}
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={!!busy} onChange={(e) => void upload(e.target.files)} />
        </label>
      </div>}
      {error && <p className="status-line error" role="alert">{error}</p>}
      {open != null && <Lightbox photos={photos.map((photo) => ({ ...photo, spotId: route.id })) as Photo[]} index={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
